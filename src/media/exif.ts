// Métadonnées photo : EXIF (JPEG / TIFF / HEIC / PNG / WebP) et XMP (Lightroom, Photoshop, applis).
// Toutes les dates trouvées sont renvoyées, avec la meilleure estimation de la date de prise de vue.

export interface DateCandidate {
  key: string; // identifiant stable du type de date (ex. « exif-original »)
  label: string; // libellé lisible
  t: number; // epoch ms (heure locale de prise de vue)
  rank: number; // fiabilité : plus petit = plus fiable
}

export interface ExifInfo {
  date?: number;
  dateKey?: string;
  candidates: DateCandidate[];
  orientation?: number;
  width?: number;
  height?: number;
  make?: string;
  model?: string;
  /** Dimensions réelles de l'image codée (en-tête JPEG), avant orientation. */
  sofWidth?: number;
  sofHeight?: number;
}

const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_DATETIME = 0x0132;
const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_SUBSEC_ORIGINAL = 0x9291;

export function parseExifDate(s: string, subsec?: string): number | undefined {
  // « AAAA:MM:JJ HH:MM:SS » (EXIF) ou « AAAA-MM-JJTHH:MM:SS(.sss)(±hh:mm) » (XMP) : heure locale conservée
  const m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?)?/.exec(s.trim());
  if (!m) return undefined;
  const Y = +m[1],
    M = +m[2],
    D = +m[3],
    h = +(m[4] ?? 12),
    mi = +(m[5] ?? 0),
    se = +(m[6] ?? 0);
  if (Y < 1971 || Y > 2100 || M < 1 || M > 12 || D < 1 || D > 31 || h > 23 || mi > 59 || se > 59) return undefined;
  const frac = subsec ?? m[7];
  const ms = frac ? Math.round(Number('0.' + frac.replace(/\D/g, '')) * 1000) || 0 : 0;
  return new Date(Y, M - 1, D, h, mi, se, ms).getTime();
}

function readTiff(view: DataView, start: number, len: number, info: ExifInfo) {
  if (start + 8 > view.byteLength) return;
  const le = view.getUint16(start) === 0x4949;
  const u16 = (o: number) => view.getUint16(start + o, le);
  const u32 = (o: number) => view.getUint32(start + o, le);
  if (u16(2) !== 42) return;
  const end = Math.min(view.byteLength, start + len);
  const strAt = (off: number, count: number) => {
    let s = '';
    for (let i = 0; i < count; i++) {
      const p = start + off + i;
      if (p >= end) break;
      const c = view.getUint8(p);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const tags = new Map<number, string | number>();
  const seen = new Set<number>();
  const readIfd = (off: number, depth: number) => {
    if (depth > 3 || off <= 0 || start + off + 2 > end || seen.has(off)) return;
    seen.add(off);
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (start + e + 12 > end) return;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const valOff = e + 8;
      if (tag === TAG_EXIF_IFD) {
        readIfd(u32(valOff), depth + 1);
        continue;
      }
      if (tag === TAG_GPS_IFD) continue;
      if (tags.has(tag)) continue; // IFD0 prioritaire sur IFD1 (vignette)
      if (type === 2) tags.set(tag, strAt(count > 4 ? u32(valOff) : valOff, count));
      else if (type === 3) tags.set(tag, u16(valOff));
      else if (type === 4) tags.set(tag, u32(valOff));
    }
    if (depth === 0) {
      const next = u32(off + 2 + n * 12);
      if (next) readIfd(next, 1); // IFD1
    }
  };
  readIfd(u32(4), 0);
  const sub = tags.get(TAG_SUBSEC_ORIGINAL) as string | undefined;
  const add = (tag: number, key: string, label: string, rank: number) => {
    const v = tags.get(tag);
    const t = typeof v === 'string' ? parseExifDate(v, tag === TAG_DATETIME_ORIGINAL ? sub : undefined) : undefined;
    if (t) info.candidates.push({ key, label, t, rank });
  };
  add(TAG_DATETIME_ORIGINAL, 'exif-original', 'Prise de vue (EXIF)', 0);
  add(TAG_DATETIME_DIGITIZED, 'exif-digitized', 'Numérisation (EXIF)', 2);
  // date de modification : souvent celle de la retouche ou de l'export, donc peu fiable
  add(TAG_DATETIME, 'exif-modified', 'Modification (EXIF)', 6);
  const o = tags.get(TAG_ORIENTATION);
  if (typeof o === 'number') info.orientation = o;
  const w = tags.get(TAG_PIXEL_X);
  const h = tags.get(TAG_PIXEL_Y);
  if (typeof w === 'number') info.width = w;
  if (typeof h === 'number') info.height = h;
  const make = tags.get(TAG_MAKE);
  const model = tags.get(TAG_MODEL);
  if (typeof make === 'string' && make.trim()) info.make = make.trim();
  if (typeof model === 'string' && model.trim()) info.model = model.trim();
}

/** Dates XMP (attributs ou éléments). */
export function readXmp(text: string, info: ExifInfo) {
  const i = text.indexOf('<x:xmpmeta');
  if (i < 0 && text.indexOf('ns.adobe.com/xap') < 0) return;
  const xmp = text.slice(Math.max(0, i), Math.max(0, i) + 200_000);
  const fields: [string, string, string, number][] = [
    ['exif:DateTimeOriginal', 'xmp-original', 'Prise de vue (XMP)', 1],
    ['photoshop:DateCreated', 'xmp-created', 'Création (XMP Photoshop)', 1],
    ['exif:DateTimeDigitized', 'xmp-digitized', 'Numérisation (XMP)', 2],
    ['xmp:CreateDate', 'xmp-create', 'Création du fichier (XMP)', 3],
    ['xmp:ModifyDate', 'xmp-modified', 'Modification (XMP)', 6],
    ['tiff:DateTime', 'xmp-tiff', 'Modification (XMP TIFF)', 6],
  ];
  for (const [name, key, label, rank] of fields) {
    const esc = name.replace(':', '\\:');
    const m = new RegExp(`${esc}\\s*=\\s*"([^"]+)"`).exec(xmp) ?? new RegExp(`<${esc}>\\s*([^<]+)<`).exec(xmp);
    const t = m ? parseExifDate(m[1]) : undefined;
    if (t && !info.candidates.some((c) => c.key === key)) info.candidates.push({ key, label, t, rank });
  }
}

const latin1 = (b: ArrayBuffer | Uint8Array) => new TextDecoder('latin1').decode(b);

/** Parcourt les segments JPEG directement dans le fichier (sans limite de taille d'en-tête). */
async function readJpeg(file: Blob, info: ExifInfo) {
  let p = 2;
  for (let n = 0; n < 64 && p + 4 < file.size; n++) {
    const head = new DataView(await file.slice(p, p + 4).arrayBuffer());
    if (head.getUint8(0) !== 0xff) break;
    const marker = head.getUint8(1);
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const size = head.getUint16(2);
    // SOFn : vraies dimensions de l'image (les métadonnées EXIF peuvent dater d'avant une retouche)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const sof = new DataView(await file.slice(p + 5, p + 9).arrayBuffer());
      info.sofHeight = sof.getUint16(0);
      info.sofWidth = sof.getUint16(2);
      break;
    }
    if (marker === 0xe1 && size > 8) {
      const seg = await file.slice(p + 4, p + 2 + size).arrayBuffer();
      const v = new DataView(seg);
      if (v.byteLength > 6 && v.getUint32(0) === 0x45786966 && v.getUint16(4) === 0) readTiff(v, 6, v.byteLength - 6, info);
      else if (latin1(seg.slice(0, 40)).startsWith('http://ns.adobe.com/xap/')) readXmp(latin1(seg), info);
    }
    p += 2 + size;
  }
}

export async function readExif(file: Blob): Promise<ExifInfo> {
  const info: ExifInfo = { candidates: [] };
  try {
    const head = await file.slice(0, 512 * 1024).arrayBuffer();
    const view = new DataView(head);
    if (view.byteLength < 12) return info;
    if (view.getUint16(0) === 0xffd8) await readJpeg(file, info);
    else {
      const sig = view.getUint32(0);
      if (sig === 0x49492a00 || sig === 0x4d4d002a) readTiff(view, 0, view.byteLength, info);
      else {
        // HEIC / AVIF / PNG (eXIf) / WebP (EXIF) : recherche de l'en-tête TIFF
        const n = view.byteLength - 8;
        for (let i = 0; i < n; i++) {
          const a = view.getUint32(i);
          if (a === 0x49492a00 || a === 0x4d4d002a) {
            const before = i >= 6 ? view.getUint32(i - 6) : 0;
            const pngChunk = i >= 4 && view.getUint32(i - 4) === 0x65584966; // « eXIf »
            if (before === 0x45786966 || pngChunk || latin1(head.slice(Math.max(0, i - 8), i)).includes('EXIF')) {
              readTiff(view, i, view.byteLength - i, info);
              break;
            }
          }
        }
      }
      readXmp(latin1(head), info);
    }
  } catch {
    /* métadonnées illisibles */
  }
  const best = [...info.candidates].sort((a, b) => a.rank - b.rank)[0];
  if (best) {
    info.date = best.t;
    info.dateKey = best.key;
  }
  return info;
}
