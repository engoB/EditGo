// Collecte de toutes les dates d'un fichier et choix de la plus fiable.
import type { DateSource, MediaItem } from '../types';
import { readExif, type DateCandidate, type ExifInfo } from './exif';
import { mtsCreationDate, videoDates } from './mp4date';
import { dateFromName } from './dates';
import { NEEDS_DECODE } from './codecs';

export async function collectDates(file: File, kind: 'photo' | 'video', exif?: ExifInfo): Promise<DateCandidate[]> {
  const out: DateCandidate[] = [];
  if (kind === 'photo') out.push(...(exif ?? (await readExif(file))).candidates);
  else if (NEEDS_DECODE.test(file.name)) {
    const t = await mtsCreationDate(file);
    if (t) out.push({ key: 'avchd', label: 'Enregistrement (caméscope AVCHD)', t, rank: 0 });
  } else out.push(...(await videoDates(file)));
  const n = dateFromName(file.name);
  if (n) out.push({ key: 'filename', label: n.hasTime ? 'Nom du fichier (date et heure)' : 'Nom du fichier (jour)', t: n.t, rank: n.hasTime ? 4 : 5 });
  if (file.lastModified) out.push({ key: 'file', label: 'Modification du fichier (disque)', t: file.lastModified, rank: 9 });
  return out.sort((a, b) => a.rank - b.rank);
}

export function sourceOfKey(key: string, kind: 'photo' | 'video'): DateSource {
  if (key === 'filename') return 'filename';
  if (key === 'file') return 'file';
  if (key.endsWith('modified') || key === 'xmp-tiff') return 'metamod';
  return kind === 'photo' ? 'exif' : 'video';
}

/** Applique la date la plus fiable (sauf date corrigée à la main ou fichier Takeout). Renvoie vrai si la date change. */
/** À incrémenter quand la lecture des dates s'améliore : les projets existants sont relus. */
export const DATES_VERSION = 3;

export function applyBest(item: MediaItem, cands: DateCandidate[]): boolean {
  item.dates = cands;
  item.datesV = DATES_VERSION;
  if (item.dateSource === 'manual' || item.dateSource === 'sidecar' || item.dateSource === 'demo') return false;
  const best = cands[0];
  if (!best) return false;
  const before = item.date;
  item.date = best.t;
  item.dateSource = sourceOfKey(best.key, item.kind);
  return Math.abs(before - item.date) > 1000;
}

/**
 * Projets créés avant la correction des proportions : recalcule les dimensions d'une photo JPEG
 * à partir de son en-tête et régénère sa vignette si elle avait été écrasée. Renvoie vrai si réparée.
 */
export async function repairPhoto(item: MediaItem): Promise<boolean> {
  if (item.kind !== 'photo' || !item.file || item.demo) return false;
  const ex = await readExif(item.file);
  if (!ex.sofWidth || !ex.sofHeight) return false;
  const rot = (ex.orientation ?? 1) >= 5;
  const W = rot ? ex.sofHeight : ex.sofWidth,
    H = rot ? ex.sofWidth : ex.sofHeight;
  if (Math.abs(W / H - item.width / Math.max(1, item.height)) < 0.01) return false;
  item.width = W;
  item.height = H;
  const bmp = await createImageBitmap(item.file, { imageOrientation: 'from-image', ...(W >= H ? { resizeWidth: 360 } : { resizeHeight: 360 }) } as ImageBitmapOptions);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.82));
  if (item.thumb.startsWith('blob:')) URL.revokeObjectURL(item.thumb);
  item.thumb = URL.createObjectURL(blob);
  return true;
}
