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
export function applyBest(item: MediaItem, cands: DateCandidate[]): boolean {
  item.dates = cands;
  if (item.dateSource === 'manual' || item.dateSource === 'sidecar' || item.dateSource === 'demo') return false;
  const best = cands[0];
  if (!best) return false;
  const before = item.date;
  item.date = best.t;
  item.dateSource = sourceOfKey(best.key, item.kind);
  return Math.abs(before - item.date) > 1000;
}
