import type { Clip } from '../types';

export interface Placed {
  clip: Clip;
  index: number;
  start: number;
  end: number;
  /** Durée effective de la transition d'entrée. */
  tIn: number;
}

export function effectiveTransition(clips: Clip[], i: number): number {
  if (i === 0) return 0;
  const c = clips[i];
  if (c.transition === 'cut') return 0;
  const prev = clips[i - 1];
  return Math.max(0, Math.min(c.transitionDuration, c.duration * 0.5, prev.duration * 0.5));
}

export function layout(clips: Clip[]): { placed: Placed[]; total: number } {
  const placed: Placed[] = [];
  let t = 0;
  for (let i = 0; i < clips.length; i++) {
    const tIn = effectiveTransition(clips, i);
    const start = Math.max(0, t - tIn);
    const end = start + clips[i].duration;
    placed.push({ clip: clips[i], index: i, start, end, tIn });
    t = end;
  }
  return { placed, total: t };
}

export interface FrameState {
  a: Placed | null; // plan sortant (ou unique)
  b: Placed | null; // plan entrant pendant une transition
  mix: number; // 0..1 progression de la transition
}

export function stateAt(placed: Placed[], t: number): FrameState {
  if (!placed.length) return { a: null, b: null, mix: 0 };
  // recherche du dernier plan commencé
  let lo = 0,
    hi = placed.length - 1,
    idx = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (placed[m].start <= t) {
      idx = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  const cur = placed[idx];
  if (idx > 0 && cur.tIn > 0 && t < cur.start + cur.tIn) {
    return { a: placed[idx - 1], b: cur, mix: (t - cur.start) / cur.tIn };
  }
  return { a: cur, b: null, mix: 0 };
}

/** Temps source d'une vidéo pour un plan donné à l'instant t de la timeline. */
export function sourceTime(p: Placed, t: number): number {
  return p.clip.trimIn + Math.max(0, t - p.start) * p.clip.speed;
}
