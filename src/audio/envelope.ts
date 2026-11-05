// Enveloppe de la musique : fondus d'entrée/sortie et atténuation (ducking) pendant les vidéos.
import type { MediaItem, Project } from '../types';
import type { Placed } from '../story/timeline';

export function duckingSegments(placed: Placed[], media: Map<string, MediaItem>): [number, number][] {
  const segs: [number, number][] = [];
  for (const p of placed) {
    const m = p.clip.mediaId ? media.get(p.clip.mediaId) : undefined;
    if (p.clip.type !== 'media' || m?.kind !== 'video' || !m.hasAudio || p.clip.volume < 0.05) continue;
    segs.push([p.start, p.end]);
  }
  return segs;
}

export function applyMusicEnvelope(gain: AudioParam, project: Project, total: number, segs: [number, number][], from = 0) {
  const v = project.music.volume;
  const duck = project.music.ducking ? v * 0.28 : v;
  gain.cancelScheduledValues(0);
  const at = (t: number) => Math.max(0, t - from);
  // Avant le début de la lecture : on part directement du bon niveau
  const inSeg = (t: number) => segs.some(([a, b]) => t >= a && t <= b);
  const fadeInEnd = 1.2;
  const startLevel = from < fadeInEnd ? v * (from / fadeInEnd) : inSeg(from) ? duck : v;
  gain.setValueAtTime(startLevel, 0);
  if (from < fadeInEnd) gain.linearRampToValueAtTime(v, at(fadeInEnd));
  for (const [a, b] of segs) {
    if (b < from) continue;
    if (a - 0.4 > from) {
      gain.setValueAtTime(v, at(a - 0.4));
      gain.linearRampToValueAtTime(duck, at(a));
    }
    gain.setValueAtTime(duck, at(Math.max(from, b - 0.3)));
    gain.linearRampToValueAtTime(v, at(b + 0.2));
  }
  const fo = Math.max(from, total - 2.8);
  gain.setValueAtTime(inSeg(fo) ? duck : v, at(fo));
  gain.linearRampToValueAtTime(0, at(total));
}

