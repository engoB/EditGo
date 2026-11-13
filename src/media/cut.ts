// Extrait choisi pour une vidéo (début / fin), utilisé par la création automatique et le recalage de durée.
import type { MediaItem } from '../types';

export function cutOf(m: MediaItem): { a: number; b: number; len: number; set: boolean } {
  const D = Math.max(0, m.duration || 0);
  const a = Math.max(0, Math.min(m.cutIn ?? 0, Math.max(0, D - 0.2)));
  const b = Math.max(a + 0.2, Math.min(m.cutOut ?? D, D));
  return { a, b: Math.min(b, D || b), len: Math.min(b, D || b) - a, set: m.cutIn != null || m.cutOut != null };
}
