// Allonger ou raccourcir le film entier en conservant les proportions du montage.
import type { Clip, MediaItem } from '../types';
import { layout } from './timeline';
import { cutOf } from '../media/cut';

const MIN = 0.8;
const MAX_STILL = 20;

function bounds(c: Clip, media: Map<string, MediaItem>): { min: number; max: number; video: MediaItem | null } {
  const m = c.mediaId ? media.get(c.mediaId) : undefined;
  if (c.type === 'media' && m?.kind === 'video') {
    // une vidéo peut s'allonger jusqu'à son extrait choisi (toute la vidéo par défaut),
    // et au moins jusqu'à sa durée actuelle dans le montage
    const cut = cutOf(m);
    const cur = c.duration * c.speed;
    const span = Math.max(cut.len, Math.min(m.duration, cur));
    return { min: Math.min(MIN, span / c.speed), max: Math.max(MIN, span / c.speed), video: m };
  }
  return { min: MIN, max: MAX_STILL, video: null };
}

function apply(base: Clip[], media: Map<string, MediaItem>, k: number): Clip[] {
  return base.map((c) => {
    const b = bounds(c, media);
    const d = Math.min(b.max, Math.max(b.min, c.duration * k));
    if (!b.video) return { ...c, duration: d };
    // vidéo : on garde le point d'entrée, et on le recule seulement si la fin dépasse la vidéo
    const span = d * c.speed;
    const cut = cutOf(b.video);
    const lo = c.trimIn >= cut.a - 0.01 ? cut.a : 0,
      hi = c.trimIn + c.duration * c.speed <= cut.b + 0.01 ? cut.b : b.video.duration;
    const trimIn = Math.max(lo, Math.min(c.trimIn, hi - span));
    return { ...c, duration: d, trimIn };
  });
}

/** Durée totale atteignable (min, max) pour un montage donné. */
export function retimeRange(base: Clip[], media: Map<string, MediaItem>) {
  return { min: layout(apply(base, media, 0.001)).total, max: layout(apply(base, media, 1000)).total };
}

/** Recalcule les durées pour que le film dure `target` secondes (au plus près). */
export function retime(base: Clip[], media: Map<string, MediaItem>, target: number): Clip[] {
  if (!base.length) return base;
  let lo = 0.001,
    hi = 1000;
  for (let i = 0; i < 50; i++) {
    const mid = Math.sqrt(lo * hi);
    if (layout(apply(base, media, mid)).total < target) lo = mid;
    else hi = mid;
  }
  return apply(base, media, (lo + hi) / 2).map((c) => ({ ...c, duration: Math.round(c.duration * 100) / 100 }));
}
