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

export async function videoCreationDate(file: Blob): Promise<number | undefined> {
  try {
    // recherche de la boîte moov parmi les boîtes de premier niveau
    let off = 0;
    let moov: { offset: number; size: number } | null = null;
    for (let i = 0; i < 64 && off < file.size; i++) {
      const b = await readBox(file, off);
      if (!b) break;
      if (b.type === 'moov') {
        moov = { offset: off, size: b.size };
        break;
      }
      off += b.size;
    }
    if (!moov || moov.size > 64 * 1024 * 1024) return undefined;
    const buf = await file.slice(moov.offset, moov.offset + moov.size).arrayBuffer();
    const view = new DataView(buf);
    // 1. date Apple (texte ISO avec fuseau)
    const text = new TextDecoder('latin1').decode(new Uint8Array(buf));
    const ki = text.indexOf('com.apple.quicktime.creationdate');
    if (ki >= 0) {
      const m = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:?\d{2}|Z)?/.exec(text.slice(ki));
      if (m) {
        const tz = m[7] ? (m[7] === 'Z' ? 'Z' : m[7].replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2')) : '';
        const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${tz}`);
        if (!isNaN(t) && t > 0) return t;
      }
    }
    // 2. mvhd
    const mv = findChild(view, 8, view.byteLength, 'mvhd');
    if (mv < 0) return undefined;
    const version = view.getUint8(mv + 8);
    const secs = version === 1 ? Number(view.getBigUint64(mv + 12)) : view.getUint32(mv + 12);
    if (!secs) return undefined;
    const t = EPOCH_1904 + secs * 1000;
    if (t < Date.UTC(1971, 0, 1) || t > Date.now() + 86_400_000) return undefined;
    return t;
  } catch {
    return undefined;
  }
}
