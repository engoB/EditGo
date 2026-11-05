import { useEffect, useRef, useState } from 'preact/hooks';
import {
  mediaMap,
  moveClip,
  musicBuffer,
  playhead,
  playing,
  project,
  selectedClip,
  timeline,
  timelineZoom,
  updateClip,
  updateProject,
  beginGesture,
  removeClip,
} from '../state/store';
import { newClip } from '../story/auto';
import { TRANSITIONS, THEMES } from '../presets';
import { Icon } from './icons';
import { timecode, clamp, uid } from '../util';
import type { Clip } from '../types';

const PAD = 16;

function Waveform({ width, height }: { width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const buf = musicBuffer.value;
  const p = project.value;
  const total = timeline.value.total;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(width * dpr));
    c.height = Math.round(height * dpr);
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    if (!buf || p.music.kind === 'none') return;
    const data = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const cols = c.width;
    const mid = c.height / 2;
    const grad = g.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0, 'rgba(120,200,160,0.95)');
    grad.addColorStop(1, 'rgba(60,150,120,0.75)');
    g.fillStyle = grad;
    for (let x = 0; x < cols; x++) {
      const t0 = (x / cols) * total + p.music.offset;
      const t1 = ((x + 1) / cols) * total + p.music.offset;
      const a = Math.floor((t0 % buf.duration) * sr),
        b = Math.max(a + 1, Math.floor((t1 % buf.duration) * sr));
      let peak = 0;
      const stepS = Math.max(1, Math.floor((b - a) / 64));
      for (let i = a; i < b && i < data.length; i += stepS) peak = Math.max(peak, Math.abs(data[i]));
      const h = Math.max(1, peak * mid * 0.95 * p.music.volume * 1.2);
      g.fillRect(x, mid - h, 1, h * 2);
    }
  }, [buf, width, height, total, p.music.kind, p.music.offset, p.music.volume]);
  return <canvas ref={ref} class="wave" style={{ width: width + 'px', height: height + 'px' }} />;
}

export function Timeline() {
  const { placed, total } = timeline.value;
  const zoom = timelineZoom.value;
  const media = mediaMap.value;
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; over: number } | null>(null);
  const width = Math.max(total * zoom + PAD * 2 + 200, 400);
  const sel = selectedClip.value;

  // suit la tête de lecture pendant la lecture
  useEffect(() => {
    if (!playing.value || !scroller.current) return;
    const el = scroller.current;
    const x = PAD + playhead.value * zoom;
    if (x > el.scrollLeft + el.clientWidth - 80 || x < el.scrollLeft) el.scrollLeft = x - 120;
  }, [playhead.value]);

  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return clamp((clientX - r.left + el.scrollLeft - PAD) / zoom, 0, total);
  };

  const scrub = (e: PointerEvent) => {
    playing.value = false;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    playhead.value = timeAt(e.clientX);
    const move = (ev: PointerEvent) => (playhead.value = timeAt(ev.clientX));
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  // repères de la règle
  const step = zoom > 90 ? 1 : zoom > 40 ? 2 : zoom > 20 ? 5 : 10;
  const ticks: number[] = [];
  for (let s = 0; s <= total + step; s += step) ticks.push(s);

  // positions visuelles (coupe au milieu des transitions)
  const vis = placed.map((p, i) => {
    const next = placed[i + 1];
    const l = p.start + p.tIn / 2;
    const r = next ? next.start + next.tIn / 2 : p.end;
    return { p, l, r };
  });

  const startClipDrag = (e: PointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest('.trim')) return;
    selectedClip.value = id;
    const startX = e.clientX;
    let moved = false;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 6) return;
      moved = true;
      const t = timeAt(ev.clientX);
      let over = vis.length;
      for (let i = 0; i < vis.length; i++) {
        if (t < (vis[i].l + vis[i].r) / 2) {
          over = i;
          break;
        }
      }
      setDrag({ id, x: ev.clientX, over });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (moved) {
        const t = timeAt(ev.clientX);
        let over = vis.length;
        for (let i = 0; i < vis.length; i++) {
          if (t < (vis[i].l + vis[i].r) / 2) {
            over = i;
            break;
          }
        }
        moveClip(id, over);
      } else {
        playing.value = false;
        playhead.value = timeAt(ev.clientX);
      }
      setDrag(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const startTrim = (e: PointerEvent, c: Clip, side: 'l' | 'r') => {
    e.stopPropagation();
    selectedClip.value = c.id;
    beginGesture();
    const m = c.mediaId ? media.get(c.mediaId) : undefined;
    const isVideo = c.type === 'media' && m?.kind === 'video';
    const x0 = e.clientX;
    const d0 = c.duration,
      in0 = c.trimIn;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / zoom;
      if (side === 'r') {
        let d = Math.max(0.5, d0 + dt);
        if (isVideo) d = Math.min(d, (m!.duration - c.trimIn) / c.speed);
        updateClip(c.id, { duration: Math.round(d * 100) / 100 }, false);
      } else if (isVideo) {
        const ni = clamp(in0 + dt * c.speed, 0, in0 + (d0 - 0.5) * c.speed);
        const nd = d0 - (ni - in0) / c.speed;
        updateClip(c.id, { trimIn: Math.round(ni * 100) / 100, duration: Math.round(nd * 100) / 100 }, false);
      } else {
        updateClip(c.id, { duration: Math.max(0.5, Math.round((d0 - dt) * 100) / 100) }, false);
      }
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const addTitleCard = () => {
    const theme = THEMES[project.value.theme];
    const t = playhead.value;
    let idx = placed.findIndex((p) => p.start > t);
    if (idx < 0) idx = placed.length;
    const c = newClip({
      type: 'title',
      mediaId: null,
      duration: 3,
      background: 'gradient',
      transition: 'fade',
      transitionDuration: 0.8,
      title: { text: 'Nouveau titre', sub: 'Sous-titre', style: theme.title, position: 'center' },
    });
    updateProject((p) => {
      const arr = [...p.clips];
      arr.splice(idx, 0, c);
      return { clips: arr };
    });
    selectedClip.value = c.id;
  };

  const splitAtPlayhead = () => {
    const t = playhead.value;
    const p = placed.find((x) => t > x.start + 0.3 && t < x.end - 0.3);
    if (!p) return;
    const c = p.clip;
    const local = t - p.start;
    const m = c.mediaId ? media.get(c.mediaId) : undefined;
    const a: Clip = { ...c, duration: local };
    const b: Clip = {
      ...c,
      id: uid(),
      duration: c.duration - local,
      trimIn: m?.kind === 'video' ? c.trimIn + local * c.speed : c.trimIn,
      transition: 'cut',
      transitionDuration: 0,
      title: null,
    };
    updateProject((pp) => {
      const arr = [...pp.clips];
      arr.splice(p.index, 1, a, b);
      return { clips: arr };
    });
    selectedClip.value = b.id;
  };

  const trackH = 64;
  return (
    <div class="timeline panel">
      <div class="tl-toolbar">
        <button class="ibtn" title="Ajouter un carton-titre à la tête de lecture" onClick={addTitleCard}>
          <Icon name="type" size={16} />
          <span>Titre</span>
        </button>
        <button class="ibtn" title="Couper le plan à la tête de lecture" onClick={splitAtPlayhead}>
          <Icon name="scissors" size={16} />
          <span>Couper</span>
        </button>
        <button class="ibtn" title="Supprimer le plan sélectionné (Suppr)" disabled={!sel} onClick={() => sel && removeClip(sel)}>
          <Icon name="trash" size={16} />
          <span>Supprimer</span>
        </button>
        <div class="tl-spacer" />
        <span class="tl-info">
          {placed.length} plans · {timecode(total)}
        </span>
        <label class="tl-zoom">
          <Icon name="zoomIn" size={15} />
          <input type="range" min={12} max={200} value={zoom} onInput={(e) => (timelineZoom.value = Number((e.target as HTMLInputElement).value))} />
        </label>
      </div>
      <div class="tl-body">
        <div class="tl-heads">
          <div class="tl-head ruler-h" />
          <div class="tl-head" style={{ height: trackH + 'px' }}>
            <b>V1</b>
            <small>Images</small>
          </div>
          <div class="tl-head">
            <b>T1</b>
            <small>Titres</small>
          </div>
          <div class="tl-head">
            <b>A1</b>
            <small>Musique</small>
          </div>
        </div>
        <div class="tl-scroll" ref={scroller}>
          <div class="tl-content" style={{ width: width + 'px' }}>
            <div class="ruler" onPointerDown={scrub}>
              {ticks.map((s) => (
                <span class="tick" style={{ left: PAD + s * zoom + 'px' }}>
                  {s % (step * 2) === 0 ? timecode(s).slice(0, 5) : ''}
                </span>
              ))}
            </div>
            <div class="track track-v" style={{ height: trackH + 'px' }}>
              {vis.map(({ p, l, r }) => {
                const c = p.clip;
                const m = c.mediaId ? media.get(c.mediaId) : undefined;
                const w = Math.max(6, (r - l) * zoom - 2);
                const dragging = drag?.id === c.id;
                return (
                  <div
                    key={c.id}
                    class={'clip' + (c.type === 'title' ? ' clip-title' : m?.kind === 'video' ? ' clip-video' : '') + (sel === c.id ? ' sel' : '') + (dragging ? ' dragging' : '')}
                    style={{ left: PAD + l * zoom + 1 + 'px', width: w + 'px', backgroundImage: m?.thumb && c.background !== 'black' && c.background !== 'gradient' ? `url(${m.thumb})` : undefined }}
                    onPointerDown={(e) => startClipDrag(e as PointerEvent, c.id)}
                    title={c.title?.text || m?.name || ''}
                  >
                    <span class="clip-label">
                      {c.type === 'title' ? <Icon name="type" size={11} /> : m?.kind === 'video' ? <Icon name="video" size={11} /> : null}
                      {c.duration.toFixed(1)}s
                    </span>
                    <i class="trim trim-l" onPointerDown={(e) => startTrim(e as PointerEvent, c, 'l')} />
                    <i class="trim trim-r" onPointerDown={(e) => startTrim(e as PointerEvent, c, 'r')} />
                  </div>
                );
              })}
              {vis.slice(1).map(({ p, l }) =>
                p.clip.transition !== 'cut' && p.tIn > 0 ? (
                  <button
                    class="trans-mark"
                    style={{ left: PAD + l * zoom + 'px' }}
                    title={TRANSITIONS.find((t) => t.id === p.clip.transition)?.label}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => (selectedClip.value = p.clip.id)}
                  />
                ) : null,
              )}
              {drag && (
                <div class="insert-mark" style={{ left: PAD + (drag.over < vis.length ? vis[drag.over].l : total) * zoom + 'px' }} />
              )}
            </div>
            <div class="track track-t">
              {placed.map((p) =>
                p.clip.title?.text ? (
                  <div
                    class={'tblock' + (sel === p.clip.id ? ' sel' : '')}
                    style={{ left: PAD + p.start * zoom + 'px', width: Math.max(8, p.clip.duration * zoom - 2) + 'px' }}
                    onClick={() => (selectedClip.value = p.clip.id)}
                  >
                    {p.clip.title.text}
                  </div>
                ) : null,
              )}
            </div>
            <div class="track track-a">
              <div style={{ position: 'absolute', left: PAD + 'px', top: 0, bottom: 0 }}>
                <Waveform width={Math.max(1, total * zoom)} height={40} />
              </div>
              {placed.map((p) => {
                const m = p.clip.mediaId ? media.get(p.clip.mediaId) : undefined;
                return p.clip.type === 'media' && m?.kind === 'video' && m.hasAudio && p.clip.volume > 0 ? (
                  <div class="ablock" style={{ left: PAD + p.start * zoom + 'px', width: p.clip.duration * zoom + 'px' }} title="Son de la vidéo (la musique est atténuée)" />
                ) : null;
              })}
            </div>
            <div class="playhead" style={{ left: PAD + playhead.value * zoom + 'px' }}>
              <i />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
