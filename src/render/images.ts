// Décodage d'images à une taille donnée, avec cache LRU.
import type { MediaItem } from '../types';

export type Decoded = { image: ImageBitmap | HTMLCanvasElement | HTMLImageElement; w: number; h: number };

/** Corrige les dimensions mémorisées si l'image décodée n'a pas les mêmes proportions. */
function fixDims(item: MediaItem, w: number, h: number) {
  if (!w || !h || Math.abs(w / h - item.width / Math.max(1, item.height)) < 0.01) return;
  const long = Math.max(item.width, item.height);
  if (w >= h) {
    item.width = long;
    item.height = Math.round((long * h) / w);
  } else {
    item.height = long;
    item.width = Math.round((long * w) / h);
  }
}

export async function decodeImage(item: MediaItem, maxSide: number): Promise<Decoded> {
  if (item.demo) {
    const s = Math.min(1, maxSide / Math.max(item.width, item.height));
    const c = item.demo.draw(Math.round(item.width * s), Math.round(item.height * s));
    return { image: c, w: c.width, h: c.height };
  }
  if (!item.file) throw new Error('Fichier absent');
  const file = item.file;
  const s = Math.min(1, maxSide / Math.max(item.width, item.height));
  if (s < 1) {
    try {
      // une seule dimension imposée : le navigateur garde les vraies proportions de l'image
      const landscape = item.width >= item.height;
      const bmp = await createImageBitmap(file, {
        imageOrientation: 'from-image',
        ...(landscape ? { resizeWidth: Math.max(1, Math.round(item.width * s)) } : { resizeHeight: Math.max(1, Math.round(item.height * s)) }),
        resizeQuality: 'high',
      } as ImageBitmapOptions);
      fixDims(item, bmp.width, bmp.height);
      if (Math.max(bmp.width, bmp.height) <= maxSide * 1.05) return { image: bmp, w: bmp.width, h: bmp.height };
      bmp.close();
    } catch {
      /* repli */
    }
  }
  const full = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  fixDims(item, full.width, full.height);
  const k = Math.min(1, maxSide / Math.max(full.width, full.height));
  if (k >= 1) return { image: full, w: full.width, h: full.height };
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(full.width * k));
  c.height = Math.max(1, Math.round(full.height * k));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(full, 0, 0, c.width, c.height);
  full.close();
  return { image: c, w: c.width, h: c.height };
}

export class ImageCache {
  private map = new Map<string, { d: Decoded; used: number }>();
  private pending = new Map<string, Promise<Decoded | null>>();
  private tick = 0;
  constructor(
    private maxSide: number,
    private limit: number,
  ) {}

  get(id: string): Decoded | null {
    const e = this.map.get(id);
    if (!e) return null;
    e.used = ++this.tick;
    return e.d;
  }

  has(id: string) {
    return this.map.has(id);
  }

  load(item: MediaItem): Promise<Decoded | null> {
    const hit = this.map.get(item.id);
    if (hit) return Promise.resolve(hit.d);
    let p = this.pending.get(item.id);
    if (!p) {
      p = decodeImage(item, this.maxSide)
        .then((d) => {
          this.map.set(item.id, { d, used: ++this.tick });
          this.evict();
          return d;
        })
        .catch(() => null)
        .finally(() => this.pending.delete(item.id));
      this.pending.set(item.id, p);
    }
    return p;
  }

  private evict() {
    if (this.map.size <= this.limit) return;
    const arr = [...this.map.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < arr.length - this.limit; i++) {
      const im = arr[i][1].d.image;
      if ('close' in im) im.close();
      this.map.delete(arr[i][0]);
    }
  }

  clear() {
    for (const e of this.map.values()) if ('close' in e.d.image) e.d.image.close();
    this.map.clear();
  }
}

/** Vignettes (chargement instantané) utilisées en attendant le décodage complet. */
const thumbs = new Map<string, HTMLImageElement>();
export function thumbImage(item: MediaItem): HTMLImageElement | null {
  if (!item.thumb) return null;
  let im = thumbs.get(item.id);
  if (!im) {
    im = new Image();
    im.src = item.thumb;
    thumbs.set(item.id, im);
  }
  return im.complete && im.naturalWidth ? im : null;
}

/** Oublie la vignette mise en cache (elle vient d'être régénérée). */
export function forgetThumb(id: string) {
  thumbs.delete(id);
}
