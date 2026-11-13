// Images-repères d'une vidéo (barre de découpe), mises en cache.
import type { MediaItem } from '../types';
import { FrameReader } from './framereader';

const cache = new Map<string, Promise<string[]>>();

export function videoStrip(m: MediaItem, n = 10): Promise<string[]> {
  const key = m.id + ':' + n;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      if (!m.file || !m.duration) return [];
      const reader = await FrameReader.open(m.file, 200, !m.decode);
      try {
        // accès direct à chaque position (depuis l'image clé voisine) : rapide même pour une longue vidéo
        const out: string[] = [];
        for (let i = 0; i < n; i++) {
          const f = await reader.getCanvas(((i + 0.5) / n) * reader.duration).catch(() => null);
          out.push(f ? f.canvas.toDataURL('image/jpeg', 0.7) : '');
        }
        return out;
      } finally {
        reader.dispose();
      }
    })().catch(() => []);
    cache.set(key, p);
  }
  return p;
}
