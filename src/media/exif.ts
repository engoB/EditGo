// Lecteur EXIF minimal (JPEG / TIFF / HEIC « Exif » box) : date de prise de vue,
// orientation et dimensions. Ne lit que les premiers Ko du fichier.

export interface ExifInfo {
  date?: number; // epoch ms, interprété en heure locale
  orientation?: number;
  width?: number;
  height?: number;
  make?: string;
  model?: string;
}

const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_DATETIME = 0x0132;
const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_SUBSEC_ORIGINAL = 0x9291;

export function parseExifDate(s: string, subsec?: string): number | undefined {
  // "YYYY:MM:DD HH:MM:SS"
  const m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return undefined;
  const [, Y, M, D, h, mi, se] = m.map(Number) as unknown as number[];
  if (Y < 1971 || M < 1 || M > 12) return undefined;
  const ms = subsec ? Math.round(Number('0.' + subsec.replace(/\D/g, '')) * 1000) || 0 : 0;
  return new Date(Y, M - 1, D, h, mi, se, ms).getTime();
}

function readTiff(view: DataView, start: number, len: number): ExifInfo {
  const info: ExifInfo = {};
  if (start + 8 > view.byteLength) return info;
  const le = view.getUint16(start) === 0x4949;
  const u16 = (o: number) => view.getUint16(start + o, le);
  const u32 = (o: number) => view.getUint32(start + o, le);
  if (u16(2) !== 42) return info;
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
  const readIfd = (off: number, depth: number) => {
    if (depth > 2 || off <= 0 || start + off + 2 > end) return;
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
      if (type === 2) {
        const o = count > 4 ? u32(valOff) : valOff;
        tags.set(tag, strAt(o, count));
      } else if (type === 3) {
        tags.set(tag, u16(valOff));
      } else if (type === 4) {
        tags.set(tag, u32(valOff));
      }
    }
  };
  readIfd(u32(4), 0);
  const dt = (tags.get(TAG_DATETIME_ORIGINAL) ?? tags.get(TAG_DATETIME_DIGITIZED) ?? tags.get(TAG_DATETIME)) as
    | string
    | undefined;
  if (dt) info.date = parseExifDate(dt, tags.get(TAG_SUBSEC_ORIGINAL) as string | undefined);
  const o = tags.get(TAG_ORIENTATION);
  if (typeof o === 'number') info.orientation = o;
  const w = tags.get(TAG_PIXEL_X);
  const h = tags.get(TAG_PIXEL_Y);
  if (typeof w === 'number') info.width = w;
  if (typeof h === 'number') info.height = h;
  const make = tags.get(TAG_MAKE);
  const model = tags.get(TAG_MODEL);
  if (typeof make === 'string') info.make = make;
  if (typeof model === 'string') info.model = model;
  return info;
}

function findExifInJpeg(view: DataView): ExifInfo {
  let p = 2;
  while (p + 4 < view.byteLength) {
    if (view.getUint8(p) !== 0xff) {
      p++;
      continue;
    }
    const marker = view.getUint8(p + 1);
    if (marker === 0xd9 || marker === 0xda) break;
    const size = view.getUint16(p + 2);
    if (marker === 0xe1 && p + 10 < view.byteLength) {
      // "Exif\0\0"
      if (view.getUint32(p + 4) === 0x45786966 && view.getUint16(p + 8) === 0) {
        return readTiff(view, p + 10, size - 8);
      }
    }
    p += 2 + size;
  }
  return {};
}

function findExifGeneric(view: DataView): ExifInfo {
  // HEIC / AVIF / PNG eXIf : recherche de la signature TIFF précédée de "Exif\0\0"
  // ou directement de l'en-tête TIFF.
  const n = view.byteLength - 8;
  for (let i = 0; i < n; i++) {
    const a = view.getUint32(i);
    if (a === 0x45786966 && view.getUint16(i + 4) === 0) {
      const t = i + 6;
      const sig = view.getUint32(t);
      if (sig === 0x49492a00 || sig === 0x4d4d002a) return readTiff(view, t, view.byteLength - t);
    }
  }
  return {};
}

export async function readExif(file: Blob): Promise<ExifInfo> {
  try {
    const head = await file.slice(0, 256 * 1024).arrayBuffer();
    const view = new DataView(head);
    if (view.byteLength < 12) return {};
    if (view.getUint16(0) === 0xffd8) return findExifInJpeg(view);
    const sig = view.getUint32(0);
    if (sig === 0x49492a00 || sig === 0x4d4d002a) return readTiff(view, 0, view.byteLength);
    return findExifGeneric(view);
  } catch {
    return {};
  }
}

/** Date déduite du nom de fichier (IMG_20230512_143010, PXL_…, WhatsApp, Screenshot…). */
export function dateFromFilename(name: string): number | undefined {
  const base = name.replace(/\.[^.]+$/, '');
  let m = /(20\d{2}|19\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[-_ T.]?(\d{2})[-_.:h]?(\d{2})[-_.:m]?(\d{2})/.exec(base);
  if (m) {
    const [, Y, M, D, h, mi, s] = m.map(Number) as unknown as number[];
    if (M >= 1 && M <= 12 && D >= 1 && D <= 31 && h < 24 && mi < 60 && s < 60)
      return new Date(Y, M - 1, D, h, mi, s).getTime();
  }
  m = /(20\d{2}|19\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/.exec(base);
  if (m) {
    const [, Y, M, D] = m.map(Number) as unknown as number[];
    if (M >= 1 && M <= 12 && D >= 1 && D <= 31) return new Date(Y, M - 1, D, 12, 0, 0).getTime();
  }
  return undefined;
}
