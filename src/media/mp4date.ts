import { readXmp, type DateCandidate, type ExifInfo } from './exif';

// Date de tournage d'une vidéo MP4 / MOV / 3GP sans décodage :
//  1. « com.apple.quicktime.creationdate » (iPhone, heure locale + fuseau) ;
//  2. sinon « creation_time » de la boîte mvhd (UTC, secondes depuis 1904).

const EPOCH_1904 = Date.UTC(1904, 0, 1);

async function readBox(file: Blob, offset: number): Promise<{ size: number; type: string; header: number } | null> {
  if (offset + 8 > file.size) return null;
  const v = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
  let size = v.getUint32(0);
  const type = String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7));
  let header = 8;
  if (size === 1 && v.byteLength >= 16) {
    size = Number(v.getBigUint64(8));
    header = 16;
  } else if (size === 0) size = file.size - offset;
  if (size < header) return null;
  return { size, type, header };
}

function findChild(view: DataView, start: number, end: number, type: string): number {
  let p = start;
  while (p + 8 <= end) {
    const size = view.getUint32(p);
    const t = String.fromCharCode(view.getUint8(p + 4), view.getUint8(p + 5), view.getUint8(p + 6), view.getUint8(p + 7));
    if (t === type) return p;
    if (size < 8) break;
    p += size;
  }
  return -1;
}

/** Toutes les dates d'une vidéo MP4 / MOV / 3GP, de la plus fiable à la moins fiable. */
export async function videoDates(file: Blob): Promise<DateCandidate[]> {
  const out: DateCandidate[] = [];
  try {
    let off = 0;
    let moov: { offset: number; size: number } | null = null;
    const uuidXmp: { offset: number; size: number }[] = [];
    for (let i = 0; i < 64 && off < file.size; i++) {
      const b = await readBox(file, off);
      if (!b) break;
      if (b.type === 'moov') moov = { offset: off, size: b.size };
      else if (b.type === 'uuid' && b.size < 2_000_000) uuidXmp.push({ offset: off, size: b.size });
      off += b.size;
    }
    if (moov && moov.size < 64 * 1024 * 1024) {
      const buf = await file.slice(moov.offset, moov.offset + moov.size).arrayBuffer();
      const view = new DataView(buf);
      const text = new TextDecoder('latin1').decode(new Uint8Array(buf));
      // 1. date Apple (heure locale + fuseau)
      const ki = text.indexOf('com.apple.quicktime.creationdate');
      if (ki >= 0) {
        const t = isoWithZone(text.slice(ki, ki + 4000));
        if (t) out.push({ key: 'qt-apple', label: 'Tournage (Apple QuickTime)', t, rank: 0 });
      }
      // 2. ©day (balise texte de nombreux appareils)
      const di = text.indexOf('\u00a9day');
      if (di >= 0) {
        const t = isoWithZone(text.slice(di, di + 80));
        if (t) out.push({ key: 'qt-day', label: 'Date (balise ©day)', t, rank: 1 });
      }
      // 3. XMP éventuel
      const x: ExifInfo = { candidates: [] };
      readXmp(text, x);
      for (const c of x.candidates) out.push({ ...c, label: c.label.replace('XMP', 'XMP vidéo') });
      // 4. mvhd : création et modification (UTC)
      const mv = findChild(view, 8, view.byteLength, 'mvhd');
      if (mv >= 0) {
        const v1 = view.getUint8(mv + 8) === 1;
        const rd = (o: number) => (v1 ? Number(view.getBigUint64(mv + o)) : view.getUint32(mv + o));
        const ok = (t: number) => t > Date.UTC(1971, 0, 1) && t < Date.now() + 86_400_000;
        const c = EPOCH_1904 + rd(12) * 1000;
        const m = EPOCH_1904 + rd(v1 ? 20 : 16) * 1000;
        if (rd(12) && ok(c)) out.push({ key: 'mp4-created', label: 'Création (en-tête vidéo)', t: c, rank: 2 });
        if (rd(v1 ? 20 : 16) && ok(m) && Math.abs(m - c) > 60_000) out.push({ key: 'mp4-modified', label: 'Modification (en-tête vidéo)', t: m, rank: 6 });
      }
      // 5. pistes (tkhd / mdhd) : certaines caméras y mettent la bonne date
      let tp = 8;
      for (let k = 0; k < 8; k++) {
        const trak = findChild(view, tp, view.byteLength, 'trak');
        if (trak < 0) break;
        const tEnd = trak + view.getUint32(trak);
        for (const [box, inner] of [['tkhd', trak + 8], ['mdhd', findChild(view, trak + 8, tEnd, 'mdia') + 8]] as const) {
          if (inner < 16) continue;
          const b = findChild(view, inner, tEnd, box);
          if (b < 0) continue;
          const v1 = view.getUint8(b + 8) === 1;
          const secs = v1 ? Number(view.getBigUint64(b + 12)) : view.getUint32(b + 12);
          const t = EPOCH_1904 + secs * 1000;
          if (secs && t > Date.UTC(1971, 0, 1) && t < Date.now() + 86_400_000 && !out.some((o) => Math.abs(o.t - t) < 2000))
            out.push({ key: 'mp4-track', label: 'Création (piste vidéo)', t, rank: 2 });
        }
        tp = tEnd;
      }
      textDates(text, out, 'métadonnées');
    }
    // 6. dates écrites en clair au début ou à la fin du fichier (caméras d'action, dashcams)
    for (const [a, b] of [[0, 512 * 1024], [Math.max(0, file.size - 512 * 1024), file.size]] as const) {
      if (moov && a >= moov.offset && b <= moov.offset + moov.size) continue;
      textDates(new TextDecoder('latin1').decode(await file.slice(a, b).arrayBuffer()), out, 'fichier');
    }
    for (const u of uuidXmp) {
      const text = new TextDecoder('latin1').decode(await file.slice(u.offset, u.offset + u.size).arrayBuffer());
      const x: ExifInfo = { candidates: [] };
      readXmp(text, x);
      for (const c of x.candidates) if (!out.some((o) => o.key === c.key)) out.push({ ...c, label: c.label.replace('XMP', 'XMP vidéo') });
    }
  } catch {
    /* illisible */
  }
  return out;
}

/** Dates texte « AAAA:MM:JJ HH:MM:SS » (ou / - .) présentes dans des métadonnées propriétaires. */
function textDates(text: string, out: DateCandidate[], where: string) {
  const re = /(20[0-4]\d)[:/\-.](0[1-9]|1[0-2])[:/\-.](0[1-9]|[12]\d|3[01])[ T_]([01]\d|2[0-3])[:.]([0-5]\d)[:.]([0-5]\d)/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) && n < 3) {
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    if (t > Date.now() + 86_400_000 || out.some((o) => Math.abs(o.t - t) < 2000)) continue;
    out.push({ key: 'text-' + where + '-' + n, label: `Date inscrite en clair (${where})`, t, rank: 3 });
    n++;
  }
}

function isoWithZone(s: string): number | undefined {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?([+-]\d{2}:?\d{2}|Z)?/.exec(s);
  if (!m) return undefined;
  const tz = m[7] ? (m[7] === 'Z' ? 'Z' : m[7].replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2')) : '';
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '12'}:${m[5] ?? '00'}:${m[6] ?? '00'}${tz}`);
  return !isNaN(t) && t > 0 ? t : undefined;
}

export async function videoCreationDate(file: Blob): Promise<number | undefined> {
  const c = (await videoDates(file)).sort((a, b) => a.rank - b.rank)[0];
  return c?.t;
}

const bcd = (b: number) => ((b >> 4) > 9 || (b & 15) > 9 ? -1 : (b >> 4) * 10 + (b & 15));

/**
 * Date d'enregistrement d'une vidéo AVCHD (.MTS) : métadonnées « MDPM » que les caméscopes
 * inscrivent dans le flux H.264 (étiquettes 0x18 : année/mois, 0x19 : jour/heure/minute/seconde, en BCD).
 */
export async function mtsCreationDate(file: Blob): Promise<number | undefined> {
  try {
    const buf = new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer());
    for (let i = 0; i < buf.length - 64; i++) {
      if (buf[i] !== 0x4d || buf[i + 1] !== 0x44 || buf[i + 2] !== 0x50 || buf[i + 3] !== 0x4d) continue;
      // retrait des octets anti-émulation (00 00 03)
      const raw: number[] = [];
      let zeros = 0;
      for (let j = i + 4; j < Math.min(buf.length, i + 4 + 160); j++) {
        const b = buf[j];
        if (zeros >= 2 && b === 3) {
          zeros = 0;
          continue;
        }
        raw.push(b);
        zeros = b === 0 ? zeros + 1 : 0;
      }
      const n = raw[0];
      let d18: number[] | null = null,
        d19: number[] | null = null;
      for (let k = 0, p = 1; k < n && p + 5 <= raw.length; k++, p += 5) {
        if (raw[p] === 0x18) d18 = raw.slice(p + 1, p + 5);
        else if (raw[p] === 0x19) d19 = raw.slice(p + 1, p + 5);
      }
      if (!d18 || !d19) continue;
      const Y = bcd(d18[1]) * 100 + bcd(d18[2]);
      const M = bcd(d18[3]);
      const [D, h, mi, s] = d19.map(bcd);
      if (Y < 1990 || Y > 2100 || M < 1 || M > 12 || D < 1 || D > 31 || h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) continue;
      return new Date(Y, M - 1, D, h, mi, s).getTime();
    }
  } catch {
    /* illisible */
  }
  return undefined;
}
