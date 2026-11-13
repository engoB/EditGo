// Bande de découpe d'une vidéo : images-repères, poignées début / fin, extrait déplaçable,
// toucher la bande pour placer le début (avant l'extrait) ou la fin (après), ou montrer une image.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { MediaItem } from '../types';
import { beginGesture } from '../state/store';
import { videoStrip } from '../media/strip';

export type Edge = 'in' | 'out' | 'inside';

export function RangeBar(props: {
  m: MediaItem;
  a: number;
  b: number;
  /** position de lecture (temps source), si connue */
  at?: number | null;
  /** pendant le geste (sans historique) */
  onLive: (a: number, b: number, edge: Edge) => void;
  /** fin du geste / toucher (avec historique) */
  onCommit: (a: number, b: number, edge: Edge) => void;
  /** toucher dans l'extrait : montrer cette image */
  onSeek?: (t: number) => void;
}) {
  const { m, a, b } = props;
  const bar = useRef<HTMLDivElement>(null);
  const [frames, setFrames] = useState<string[]>([]);
  const [drag, setDrag] = useState<Edge | null>(null);
  useEffect(() => {
    let alive = true;
    void videoStrip(m, 10).then((f) => alive && setFrames(f));
    return () => {
      alive = false;
    };
  }, [m.id]);
  const D = Math.max(0.01, m.duration);
  const pct = (t: number) => `${(t / D) * 100}%`;
  const timeAt = (x: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(D, ((x - r.left) / r.width) * D));
  };

  const startDrag = (e: PointerEvent, kind: Edge) => {
    e.preventDefault();
    e.stopPropagation();
    beginGesture();
    setDrag(kind);
    const r = bar.current!.getBoundingClientRect();
    const x0 = e.clientX;
    const len = b - a;
    let na = a,
      nb = b;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dt = ((ev.clientX - x0) / r.width) * D;
      if (kind === 'in') na = Math.max(0, Math.min(a + dt, b - 0.2));
      else if (kind === 'out') nb = Math.min(D, Math.max(b + dt, a + 0.2));
      else {
        na = Math.max(0, Math.min(a + dt, D - len));
        nb = na + len;
      }
      props.onLive(na, nb, kind);
    };
    const up = () => {
      setDrag(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      props.onCommit(na, nb, kind);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const tap = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.trim-h, .trim-sel')) return;
    const t = timeAt(e.clientX);
    if (t < a || t > b) beginGesture();
    if (t < a) props.onCommit(t, b, 'in');
    else if (t > b) props.onCommit(a, t, 'out');
    else props.onSeek?.(t);
  };

  return (
    <div class={'trim-bar' + (drag ? ' dragging' : '')} ref={bar} onPointerDown={(e) => tap(e as PointerEvent)}>
      <div class="trim-frames">{frames.length ? frames.map((f) => (f ? <img src={f} alt="" draggable={false} /> : <i />)) : <span class="trim-loading">Lecture des images…</span>}</div>
      <div class="trim-shade" style={{ left: 0, width: pct(a) }} />
      <div class="trim-shade" style={{ left: pct(b), right: 0 }} />
      <div class="trim-sel" style={{ left: pct(a), width: pct(b - a) }} onPointerDown={(e) => startDrag(e as PointerEvent, 'inside')} title="Glisser pour déplacer l’extrait" />
      <div class="trim-h trim-in" style={{ left: pct(a) }} onPointerDown={(e) => startDrag(e as PointerEvent, 'in')} title="Début">
        <i />
      </div>
      <div class="trim-h trim-out" style={{ left: pct(b) }} onPointerDown={(e) => startDrag(e as PointerEvent, 'out')} title="Fin">
        <i />
      </div>
      {props.at != null && <div class="trim-ph" style={{ left: pct(Math.min(D, props.at)) }} />}
    </div>
  );
}
