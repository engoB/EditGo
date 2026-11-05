// Barre de découpe d'un plan vidéo : point d'entrée et point de sortie.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Clip, MediaItem } from '../types';
import { beginGesture, playhead, playing, timeline, updateClip } from '../state/store';
import { setVideoBounds } from '../state/actions';
import { videoStrip } from '../media/strip';
import { Icon } from './icons';

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};

export function TrimBar({ c, m }: { c: Clip; m: MediaItem }) {
  const bar = useRef<HTMLDivElement>(null);
  const [frames, setFrames] = useState<string[]>([]);
  const [drag, setDrag] = useState<'in' | 'out' | 'both' | null>(null);
  useEffect(() => {
    let alive = true;
    void videoStrip(m, 10).then((f) => alive && setFrames(f));
    return () => {
      alive = false;
    };
  }, [m.id]);
  const D = Math.max(0.01, m.duration);
  const inT = c.trimIn;
  const outT = Math.min(D, c.trimIn + c.duration * c.speed);
  const placed = timeline.value.placed.find((p) => p.clip.id === c.id);
  const show = (where: 'in' | 'out') => {
    if (!placed) return;
    playing.value = false;
    const cur = timeline.value.placed.find((p) => p.clip.id === c.id) ?? placed;
    playhead.value = where === 'in' ? cur.start + 0.01 : Math.max(cur.start, cur.end - 1 / 30);
  };
  // temps source de l'image affichée, si la tête de lecture est sur ce plan
  const atPlayhead = placed && playhead.value >= placed.start && playhead.value <= placed.end ? c.trimIn + (playhead.value - placed.start) * c.speed : null;

  const startDrag = (e: PointerEvent, kind: 'in' | 'out' | 'both') => {
    e.preventDefault();
    e.stopPropagation();
    beginGesture();
    setDrag(kind);
    const el = bar.current!;
    const r = el.getBoundingClientRect();
    const x0 = e.clientX;
    const in0 = inT,
      out0 = outT;
    const len = out0 - in0;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dt = ((ev.clientX - x0) / r.width) * D;
      let a = in0,
        b = out0;
      if (kind === 'in') a = Math.max(0, Math.min(in0 + dt, out0 - 0.2));
      else if (kind === 'out') b = Math.min(D, Math.max(out0 + dt, in0 + 0.2));
      else {
        a = Math.max(0, Math.min(in0 + dt, D - len));
        b = a + len;
      }
      updateClip(c.id, { trimIn: Math.round(a * 100) / 100, duration: Math.round(((b - a) / c.speed) * 100) / 100 }, false);
      show(kind === 'out' ? 'out' : 'in');
    };
    const up = () => {
      setDrag(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const pct = (t: number) => `${(t / D) * 100}%`;
  return (
    <div class="trimbox">
      <div class="trim-head">
        <span>
          Entrée <b>{fmt(inT)}</b>
        </span>
        <span>
          Sortie <b>{fmt(outT)}</b>
        </span>
        <span>
          Extrait <b>{(outT - inT).toFixed(1)} s</b> / {D.toFixed(1)} s
        </span>
      </div>
      <div class={'trim-bar' + (drag ? ' dragging' : '')} ref={bar}>
        <div class="trim-frames">{frames.length ? frames.map((f) => (f ? <img src={f} alt="" draggable={false} /> : <i />)) : <span class="trim-loading">Lecture des images…</span>}</div>
        <div class="trim-shade" style={{ left: 0, width: pct(inT) }} />
        <div class="trim-shade" style={{ left: pct(outT), right: 0 }} />
        <div class="trim-sel" style={{ left: pct(inT), width: pct(outT - inT) }} onPointerDown={(e) => startDrag(e as PointerEvent, 'both')} title="Glisser pour déplacer l’extrait" />
        <div class="trim-h trim-in" style={{ left: pct(inT) }} onPointerDown={(e) => startDrag(e as PointerEvent, 'in')} title="Point d’entrée">
          <i />
        </div>
        <div class="trim-h trim-out" style={{ left: pct(outT) }} onPointerDown={(e) => startDrag(e as PointerEvent, 'out')} title="Point de sortie">
          <i />
        </div>
        {atPlayhead !== null && <div class="trim-ph" style={{ left: pct(Math.min(D, atPlayhead)) }} />}
      </div>
      <div class="trim-fields">
        <label>
          Entrée (s)
          <input id="trim-in" class="input" type="number" min={0} max={D} step={0.1} value={inT.toFixed(2)} onChange={(e) => setVideoBounds(c.id, Number((e.target as HTMLInputElement).value), null)} />
        </label>
        <label>
          Sortie (s)
          <input id="trim-out" class="input" type="number" min={0} max={D} step={0.1} value={outT.toFixed(2)} onChange={(e) => setVideoBounds(c.id, null, Number((e.target as HTMLInputElement).value))} />
        </label>
      </div>
      <div class="trim-btns">
        <button class="btn btn-ghost btn-sm" disabled={atPlayhead === null} onClick={() => atPlayhead !== null && setVideoBounds(c.id, atPlayhead, null)} title="Raccourci : I">
          <Icon name="stepBack" size={13} /> Entrée ici
        </button>
        <button class="btn btn-ghost btn-sm" disabled={atPlayhead === null} onClick={() => atPlayhead !== null && setVideoBounds(c.id, null, atPlayhead)} title="Raccourci : O">
          Sortie ici <Icon name="stepFwd" size={13} />
        </button>
        <button class="btn btn-quiet btn-sm" onClick={() => setVideoBounds(c.id, 0, D)} title="Utiliser toute la vidéo">
          Tout
        </button>
      </div>
      <p class="side-note">Glissez les poignées, ou placez la tête de lecture sur l’image voulue puis « Entrée ici » / « Sortie ici » (touches I et O).</p>
    </div>
  );
}
