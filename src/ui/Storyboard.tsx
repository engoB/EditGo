// Vue storyboard : les plans en vignettes, à réordonner par glisser-déposer
// (souris : glisser ; tactile : appui long puis glisser).
import { useRef, useState } from 'preact/hooks';
import { mediaMap, playhead, playing, project, selectedClip, timeline } from '../state/store';
import { moveClipTo, nudgeClip } from '../state/actions';
import { Icon } from './icons';
import { formatDayShort, formatTime } from '../util';

export function Storyboard() {
  const clips = project.value.clips;
  const media = mediaMap.value;
  const { placed } = timeline.value;
  const sel = selectedClip.value;
  const grid = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; over: number; w: number; h: number } | null>(null);

  const indexAt = (x: number, y: number): number => {
    const cards = Array.from(grid.current?.querySelectorAll<HTMLElement>('.sb-card') ?? []);
    let best = cards.length;
    let bestD = Infinity;
    cards.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      // insertion avant la carte i si le pointeur est sur sa moitié gauche, après sinon
      const cy = r.top + r.height / 2;
      const dy = Math.abs(y - cy);
      if (dy > r.height) return;
      const left = x < r.left + r.width / 2;
      const d = Math.abs(x - (left ? r.left : r.right)) + dy * 2;
      if (d < bestD) {
        bestD = d;
        best = left ? i : i + 1;
      }
    });
    return best;
  };

  const onPointerDown = (e: PointerEvent, id: string, index: number) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const sx = e.clientX,
      sy = e.clientY;
    const touch = e.pointerType !== 'mouse';
    let active = false;
    let longTimer = 0;
    const blockScroll = (ev: TouchEvent) => active && ev.preventDefault();
    const start = (x: number, y: number) => {
      active = true;
      navigator.vibrate?.(12);
      setDrag({ id, x, y, over: index, w: rect.width, h: rect.height });
    };
    if (touch) longTimer = window.setTimeout(() => start(sx, sy), 280);
    document.addEventListener('touchmove', blockScroll, { passive: false });
    const move = (ev: PointerEvent) => {
      if (!active) {
        const dist = Math.hypot(ev.clientX - sx, ev.clientY - sy);
        if (touch) {
          if (dist > 10) cleanup(); // l'utilisateur fait défiler
          return;
        }
        if (dist < 6) return;
        start(ev.clientX, ev.clientY);
      }
      setDrag((d) => (d ? { ...d, x: ev.clientX, y: ev.clientY, over: indexAt(ev.clientX, ev.clientY) } : d));
      // défilement automatique près des bords
      const g = grid.current;
      if (g) {
        const r = g.getBoundingClientRect();
        if (ev.clientY < r.top + 40) g.scrollTop -= 12;
        else if (ev.clientY > r.bottom - 40) g.scrollTop += 12;
      }
    };
    const up = (ev: PointerEvent) => {
      if (active) {
        const to = indexAt(ev.clientX, ev.clientY);
        moveClipTo(id, to > index ? to - 1 : to);
      } else if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 10) {
        selectedClip.value = id;
        const p = placed.find((x) => x.clip.id === id);
        if (p) {
          playing.value = false;
          playhead.value = p.start + Math.min(0.5, p.clip.duration / 2);
        }
      }
      cleanup();
    };
    const cleanup = () => {
      clearTimeout(longTimer);
      active = false;
      setDrag(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cleanup);
      document.removeEventListener('touchmove', blockScroll);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cleanup);
  };

  const dragged = drag ? clips.find((c) => c.id === drag.id) : null;
  const draggedMedia = dragged?.mediaId ? media.get(dragged.mediaId) : undefined;

  return (
    <div class="storyboard" ref={grid}>
      <p class="sb-hint">
        <Icon name="info" size={13} /> Glissez une vignette pour la déplacer (appui long sur écran tactile). Le numéro indique l’ordre dans le film.
      </p>
      <div class="sb-grid">
        {clips.map((c, i) => {
          const m = c.mediaId ? media.get(c.mediaId) : undefined;
          const showThumb = m?.thumb && c.background !== 'black' && c.background !== 'gradient';
          return (
              <div
                key={c.id}
                class={
                  'sb-card' +
                  (sel === c.id ? ' sel' : '') +
                  (drag?.id === c.id ? ' ghosted' : '') +
                  (c.type === 'title' ? ' sb-title' : '') +
                  (drag && drag.over === i ? ' ins-before' : '') +
                  (drag && drag.over >= clips.length && i === clips.length - 1 ? ' ins-after' : '')
                }
                onPointerDown={(e) => onPointerDown(e as PointerEvent, c.id, i)}
              >
                <div class="sb-thumb">
                  {showThumb ? <img src={m!.thumb} alt="" draggable={false} /> : <span class="sb-tt">{c.title?.text || 'Titre'}</span>}
                  <span class="sb-num">{i + 1}</span>
                  {m?.kind === 'video' && c.type === 'media' && (
                    <span class="sb-badge">
                      <Icon name="video" size={11} />
                    </span>
                  )}
                  {c.title && c.type === 'media' && (
                    <span class="sb-badge sb-badge-t">
                      <Icon name="type" size={11} />
                    </span>
                  )}
                </div>
                <div class="sb-meta">
                  <span>{c.duration.toFixed(1)} s</span>
                  <span class="sb-date">{c.type === 'title' ? 'Carton' : m ? `${formatDayShort(m.date)} · ${formatTime(m.date)}` : ''}</span>
                </div>
                {sel === c.id && (
                  <div class="sb-move">
                    <button class="ibtn" title="Plus tôt" disabled={i === 0} onClick={() => nudgeClip(c.id, -1)}>
                      <Icon name="stepBack" size={15} />
                    </button>
                    <button class="ibtn" title="Plus tard" disabled={i === clips.length - 1} onClick={() => nudgeClip(c.id, 1)}>
                      <Icon name="stepFwd" size={15} />
                    </button>
                  </div>
                )}
              </div>
          );
        })}
      </div>
      {drag && dragged && (
        <div class="sb-drag" style={{ left: drag.x - drag.w / 2 + 'px', top: drag.y - drag.h / 2 + 'px', width: drag.w + 'px' }}>
          {draggedMedia?.thumb ? <img src={draggedMedia.thumb} alt="" /> : <span class="sb-tt">{dragged.title?.text}</span>}
        </div>
      )}
    </div>
  );
}
