// Datation et tri « intelligents » :
//  - dates dans les noms de fichiers (appareils, messageries, captures, horodatages) ;
//  - fichiers annexes de Google Takeout (photoTakenTime) ;
//  - dates dans les noms de dossiers (« 2023-05 Vacances », « Mai 2023 », « 2023/05 ») ;
//  - numérotation de l'appareil (IMG_4203 entre IMG_4201 et IMG_4207 déjà datées) ;
//  - captures d'écran, miniatures et images trop petites écartées ;
//  - noms d'événements tirés des dossiers pour titrer les chapitres.
import type { MediaItem } from '../types';

const ok = (Y: number, M: number, D: number, h = 12, mi = 0, s = 0) =>
  Y >= 1990 && Y <= 2100 && M >= 1 && M <= 12 && D >= 1 && D <= 31 && h < 24 && mi < 60 && s < 60;

export interface NameDate {
  t: number;
  hasTime: boolean;
}

/** Date contenue dans un nom de fichier. */
export function dateFromName(name: string): NameDate | null {
  const base = name.replace(/\.[^.]+$/, '');
  // horodatage en millisecondes (Telegram, Signal, Snapchat, exports d'applications)
  let m = /(?:^|\D)(1[3-8]\d{11})(?:\D|$)/.exec(base);
  if (m) {
    const t = Number(m[1]);
    if (t < Date.now() + 86_400_000) return { t, hasTime: true };
  }
  // AAAAMMJJ ou AAAA-MM-JJ, puis l'heure jusqu'à quelques caractères plus loin
  // (IMG_20230512_143010, PXL_20230512_143010123, 2023-05-12 14.30.10, « WhatsApp Image 2023-05-12 at 14.30.10 »)
  m = /(19\d{2}|20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})\D{0,4}?(\d{2})[-_.:h]?(\d{2})[-_.:m]?(\d{2})/.exec(base);
  if (m) {
    const [Y, M, D, h, mi, s] = m.slice(1).map(Number);
    if (ok(Y, M, D, h, mi, s)) return { t: new Date(Y, M - 1, D, h, mi, s).getTime(), hasTime: true };
  }
  // jour seul (IMG-20230512-WA0003, 2023-05-12)
  m = /(19\d{2}|20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?!\d)/.exec(base);
  if (m) {
    const [Y, M, D] = m.slice(1).map(Number);
    if (ok(Y, M, D)) return { t: new Date(Y, M - 1, D, 12).getTime(), hasTime: false };
  }
  return null;
}

const MONTHS: Record<string, number> = {
  janvier: 1, janv: 1, jan: 1, january: 1, fevrier: 2, février: 2, fevr: 2, févr: 2, feb: 2, february: 2, mars: 3, mar: 3, march: 3,
  avril: 4, avr: 4, apr: 4, april: 4, mai: 5, may: 5, juin: 6, jun: 6, june: 6, juillet: 7, juil: 7, jul: 7, july: 7, aout: 8, août: 8,
  aug: 8, august: 8, septembre: 9, sept: 9, sep: 9, september: 9, octobre: 10, oct: 10, october: 10, novembre: 11, nov: 11, november: 11,
  decembre: 12, décembre: 12, dec: 12, déc: 12, december: 12,
};
const SEASONS: Record<string, number> = { hiver: 1, winter: 1, printemps: 4, spring: 4, ete: 7, été: 7, summer: 7, automne: 10, autumn: 10, fall: 10 };

export interface FolderDate {
  start: number;
  end: number;
  t: number; // milieu de la période
}

/** Période déduite des dossiers du chemin (le plus précis l'emporte). */
export function dateFromFolders(path: string): FolderDate | null {
  const segs = path.split('/').slice(0, -1);
  let year = 0,
    month = 0,
    day = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i].toLowerCase();
    let m = /(19\d{2}|20\d{2})[-_. ](\d{2})[-_. ](\d{2})(?!\d)/.exec(seg);
    if (m && ok(+m[1], +m[2], +m[3])) {
      [year, month, day] = [+m[1], +m[2], +m[3]];
      continue;
    }
    m = /(?:^|\D)(19\d{2}|20\d{2})[-_. ](\d{2})(?!\d)/.exec(seg);
    if (m && +m[2] >= 1 && +m[2] <= 12) {
      [year, month, day] = [+m[1], +m[2], 0];
      continue;
    }
    const words = seg.normalize('NFC').split(/[^a-zà-ÿ0-9]+/);
    const y = words.find((w) => /^(19|20)\d{2}$/.test(w));
    const mo = words.map((w) => MONTHS[w]).find(Boolean);
    const se = words.map((w) => SEASONS[w]).find(Boolean);
    if (y && (mo || se)) {
      [year, month, day] = [+y, mo ?? se!, 0];
      continue;
    }
    if (/^(19|20)\d{2}$/.test(seg)) {
      year = +seg;
      month = 0;
      day = 0;
      continue;
    }
    // « 05 » ou « 05 - mai » juste sous un dossier année
    if (year && /^(0[1-9]|1[0-2])(\D|$)/.test(seg) && i > 0 && /^(19|20)\d{2}$/.test(segs[i - 1])) {
      month = +seg.slice(0, 2);
      day = 0;
    }
  }
  if (!year || year > new Date().getFullYear() + 1) return null;
  let start: Date, end: Date;
  if (day) {
    start = new Date(year, month - 1, day);
    end = new Date(year, month - 1, day + 1);
  } else if (month) {
    start = new Date(year, month - 1, 1);
    end = new Date(year, month, 1);
  } else {
    start = new Date(year, 0, 1);
    end = new Date(year + 1, 0, 1);
  }
  return { start: start.getTime(), end: end.getTime(), t: (start.getTime() + end.getTime()) / 2 };
}

/** Clé « dossier + nom de base » utilisée pour associer un fichier JSON Takeout à son média. */
export function sidecarKey(path: string): string | null {
  const m = /^(.*?\.(?:jpe?g|png|heic|heif|webp|gif|mp4|mov|m4v|3gp|avi|mkv))(?:\.supplemental-meta[a-z-]*|\.suppl[a-z-]*)?(\(\d+\))?\.json$/i.exec(path);
  return m ? (m[1] + (m[2] ?? '')).toLowerCase() : null;
}

/** Date de prise de vue d'un fichier JSON de Google Takeout. */
export async function readSidecar(file: File): Promise<number | null> {
  try {
    if (file.size > 200_000) return null;
    const j = JSON.parse(await file.text());
    const ts = Number(j?.photoTakenTime?.timestamp ?? j?.creationTime?.timestamp);
    return ts > 0 ? ts * 1000 : null;
  } catch {
    return null;
  }
}

const STRONG = new Set(['exif', 'video', 'sidecar', 'manual', 'demo']);
const isWeak = (m: MediaItem) => m.dateSource === 'file' || m.dateSource === 'folder' || m.dateSource === 'sequence';

function seqKey(m: MediaItem): { key: string; n: number } | null {
  const dir = m.path.split('/').slice(0, -1).join('/');
  const base = m.name.replace(/\.[^.]+$/, '');
  const r = /^(.*?)(\d{3,6})(?:\D.*)?$/.exec(base);
  if (!r) return null;
  return { key: (m.sourceId ?? '') + '|' + dir + '|' + r[1].toUpperCase(), n: Number(r[2]) };
}

/**
 * Affine les dates peu fiables (date de modification, dossier) :
 *  1. numérotation de l'appareil : interpolation entre les deux voisins datés les plus proches ;
 *  2. sinon, si la date de modification sort de la période indiquée par le dossier, on retient le dossier.
 */
export function refineDates(items: MediaItem[]) {
  const groups = new Map<string, { m: MediaItem; n: number }[]>();
  for (const m of items) {
    if (m.demo) continue;
    const k = seqKey(m);
    if (!k) continue;
    const arr = groups.get(k.key) ?? [];
    arr.push({ m, n: k.n });
    groups.set(k.key, arr);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.n - b.n);
    const anchors = arr.filter((x) => STRONG.has(x.m.dateSource) || (x.m.dateSource === 'filename' && !isWeak(x.m)));
    if (!anchors.length) continue;
    for (const x of arr) {
      if (!isWeak(x.m)) continue;
      let lo: (typeof arr)[number] | undefined, hi: (typeof arr)[number] | undefined;
      for (const a of anchors) {
        if (a.n < x.n) lo = a;
        else if (a.n > x.n && !hi) hi = a;
      }
      let t: number | null = null;
      if (lo && hi && hi.n - lo.n <= 400 && hi.m.date >= lo.m.date && hi.m.date - lo.m.date < 45 * 86_400_000) {
        t = lo.m.date + ((x.n - lo.n) / (hi.n - lo.n)) * (hi.m.date - lo.m.date);
      } else if (lo && x.n - lo.n <= 15) t = lo.m.date + (x.n - lo.n) * 20_000;
      else if (hi && hi.n - x.n <= 15) t = hi.m.date - (hi.n - x.n) * 20_000;
      if (t !== null) {
        x.m.date = Math.round(t);
        x.m.dateSource = 'sequence';
      }
    }
  }
  for (const m of items) {
    if (m.dateSource !== 'file') continue;
    const f = dateFromFolders(m.path);
    if (f && (m.date < f.start || m.date >= f.end)) {
      m.date = f.t;
      m.dateSource = 'folder';
    }
  }
}

/** Raison d'écarter automatiquement un fichier (capture d'écran, miniature…), sinon null. */
export function junkReason(m: MediaItem): string | null {
  const lower = m.path.toLowerCase();
  if (/(^|\/)(\.?thumbnails?|\.thumbs?|@eadir|\.cache|cache)(\/|$)/.test(lower)) return 'Miniature';
  if (/(screenshot|screen ?shot|capture d.?[ée]cran|bildschirmfoto|captura de pantalla|schermata|scrnli|screencast|screen recording|enregistrement de l.?[ée]cran)/i.test(m.name + ' ' + m.path))
    return m.kind === 'video' ? 'Enregistrement d’écran' : 'Capture d’écran';
  if (m.kind === 'photo') {
    if (Math.min(m.width, m.height) < 360) return 'Image trop petite';
    const ratio = Math.max(m.width, m.height) / Math.max(1, Math.min(m.width, m.height));
    const noCamera = !m.camera && m.dateSource !== 'exif';
    if (noCamera && /\.png$/i.test(m.name) && ratio > 1.9) return 'Capture d’écran probable';
    if (/\.gif$/i.test(m.name)) return 'Animation GIF';
  } else if (m.duration > 0 && m.duration < 1) return 'Vidéo trop courte';
  return null;
}

const GENERIC = new RegExp(
  '^(' +
    [
      'dcim', 'camera', 'camera roll', 'pellicule', '\\d{3}[a-z_]+', 'pictures', 'photos?', 'images?', 'img', 'imgs', 'downloads?', 'téléchargements', 'telechargements',
      'whatsapp.*', 'telegram.*', 'signal.*', 'messenger', 'instagram', 'snapchat', 'screenshots?', 'captures?.*', 'google photos', 'takeout', 'drive', 'mon drive',
      'my drive', 'google drive', 'onedrive', 'dropbox', 'icloud.*', 'desktop', 'bureau', 'documents?', 'videos?', 'vidéos?', 'movies?', 'media', 'médias?',
      'new folder', 'nouveau dossier', 'dossier sans titre', 'untitled folder', 'export.*', 'backup.*', 'sauvegarde.*', 'photos from \\d{4}', 'raw', 'jpe?g',
      'sent', 'private', 'recovered', 'archive.*', 'divers', 'misc', 'tmp', 'temp', 'users?', 'home', 'utilisateurs',
    ].join('|') +
    ')$',
  'i',
);

/** Nom d'événement tiré des dossiers (« 2023-07 Vacances Bretagne » → « Vacances Bretagne »), sinon null. */
export function eventFromPath(path: string): string | null {
  const segs = path.split('/').slice(0, -1).reverse();
  for (const raw of segs) {
    let s = raw
      .replace(/[_]+/g, ' ')
      .replace(/(19|20)\d{2}([-. ]\d{2}){0,2}/g, ' ')
      .replace(/\b(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\b/gi, ' ')
      .replace(/^[\s\-–·.,]+|[\s\-–·.,]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (s.length < 3 || /^\d+$/.test(s) || GENERIC.test(s) || GENERIC.test(raw.trim())) continue;
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return s.length > 40 ? s.slice(0, 40).trim() + '…' : s;
  }
  return null;
}

export const DATE_SOURCE_LABEL: Record<string, string> = {
  exif: 'lue dans la photo (EXIF)',
  video: 'lue dans la vidéo',
  sidecar: 'lue dans le fichier Google Takeout',
  filename: 'déduite du nom du fichier',
  sequence: 'déduite de la numérotation de l’appareil',
  folder: 'déduite du nom du dossier',
  file: 'date de modification du fichier (peu fiable)',
  demo: 'démo',
  manual: 'corrigée à la main',
};
