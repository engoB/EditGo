// Analyse des médias importés : date, vignette, empreintes (exacte + perceptuelle),
// score de qualité et point d'intérêt (pour le cadrage Ken Burns).
import type { FocusPoint, ImportOptions, MediaItem } from '../types';
import { dateFromFilename, readExif } from './exif';
import { videoCreationDate } from './mp4date';
import { uid } from '../util';

const PHOTO_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|3gp|avi|ogv)$/i;

export function mediaKindOf(file: File): 'photo' | 'video' | null {
  if (file.type.startsWith('image/') || PHOTO_EXT.test(file.name)) return 'photo';
  if (file.type.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video';
  return null;
}

// ---------- Empreinte exacte ----------
async function exactHash(file: File): Promise<string> {
  const CHUNK = 4 * 1024 * 1024;
  let data: ArrayBuffer;
  if (file.size <= CHUNK * 3) {
    data = await file.arrayBuffer();
  } else {
    const a = await file.slice(0, CHUNK).arrayBuffer();
    const mid = Math.floor(file.size / 2);
    const b = await file.slice(mid, mid + CHUNK).arrayBuffer();
    const c = await file.slice(file.size - CHUNK).arrayBuffer();
    const all = new Uint8Array(CHUNK * 3 + 8);
    all.set(new Uint8Array(a), 0);
    all.set(new Uint8Array(b), CHUNK);
    all.set(new Uint8Array(c), CHUNK * 2);
    new DataView(all.buffer).setFloat64(CHUNK * 3, file.size);
    data = all.buffer;
  }
  if (globalThis.crypto?.subtle) {
    const d = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('') + ':' + file.size;
  }
  // Repli (contexte non sécurisé) : FNV-1a 2×32 bits.
  const u8 = new Uint8Array(data);
  let h1 = 0x811c9dc5,
    h2 = 0x01000193;
  for (let i = 0; i < u8.length; i++) {
    h1 = Math.imul(h1 ^ u8[i], 16777619);
    h2 = Math.imul(h2 ^ u8[u8.length - 1 - i], 2246822519);
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + ':' + file.size;
}

// ---------- Analyse d'image (vignette) ----------
interface PixelStats {
  phash: string;
  sig: string;
  score: number;
  focus: FocusPoint;
}

export function analyzePixels(src: CanvasImageSource, sw: number, sh: number): PixelStats {
  const N = 96;
  const ratio = sw / sh;
  const w = ratio >= 1 ? N : Math.max(8, Math.round(N * ratio));
  const h = ratio >= 1 ? Math.max(8, Math.round(N / ratio)) : N;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  let sum = 0,
    rg = 0,
    yb = 0,
    rg2 = 0,
    yb2 = 0;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const r = px[i],
      gg = px[i + 1],
      b = px[i + 2];
    const y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    gray[j] = y;
    sum += y;
    const a = r - gg,
      bb = 0.5 * (r + gg) - b;
    rg += a;
    yb += bb;
    rg2 += a * a;
    yb2 += bb * bb;
  }
  const n = w * h;
  const mean = sum / n;
  let varY = 0;
  for (let i = 0; i < n; i++) varY += (gray[i] - mean) ** 2;
  const std = Math.sqrt(varY / n);
  // Netteté : variance du laplacien
  let lapSum = 0,
    lapSq = 0,
    cnt = 0;
  let fx = 0,
    fy = 0,
    fw = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      lapSum += lap;
      lapSq += lap * lap;
      cnt++;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      const mag = Math.sqrt(gx * gx + gy * gy);
      const wgt = mag * mag;
      fx += x * wgt;
      fy += y * wgt;
      fw += wgt;
    }
  }
  const lapVar = lapSq / cnt - (lapSum / cnt) ** 2;
  const sharp = Math.min(1, Math.log10(1 + lapVar) / 3.2);
  const exposure = 1 - Math.min(1, Math.abs(mean - 120) / 120);
  const contrast = Math.min(1, std / 64);
  const colorful =
    Math.min(1, (Math.sqrt(rg2 / n - (rg / n) ** 2 + (yb2 / n - (yb / n) ** 2)) + 0.3 * Math.hypot(rg / n, yb / n)) / 80);
  const score = Math.max(0, Math.min(1, 0.42 * sharp + 0.22 * exposure + 0.18 * contrast + 0.18 * colorful));
  // Point d'intérêt : barycentre de l'énergie des contours, ramené vers le centre.
  let focus: FocusPoint = { x: 0.5, y: 0.45 };
  if (fw > 0) {
    const cx = fx / fw / (w - 1);
    const cy = fy / fw / (h - 1);
    focus = { x: 0.5 + (cx - 0.5) * 0.7, y: 0.45 + (cy - 0.45) * 0.7 };
  }
  // dHash 9×8
  const d = document.createElement('canvas');
  d.width = 9;
  d.height = 8;
  const dg = d.getContext('2d', { willReadFrequently: true })!;
  dg.drawImage(c, 0, 0, 9, 8);
  const dp = dg.getImageData(0, 0, 9, 8).data;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 9 + x) * 4;
      const l = dp[i] + dp[i + 1] + dp[i + 2];
      const r = dp[i + 4] + dp[i + 5] + dp[i + 6];
      bits += l > r ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  // signature 16×16 (niveaux de gris normalisés) pour les rafales
  dg.canvas.width = 16;
  dg.canvas.height = 16;
  dg.drawImage(c, 0, 0, 16, 16);
  const sp = dg.getImageData(0, 0, 16, 16).data;
  let sig = '';
  for (let i = 0; i < sp.length; i += 4) sig += String.fromCharCode(Math.round(0.299 * sp[i] + 0.587 * sp[i + 1] + 0.114 * sp[i + 2]));
  return { phash: hex, sig, score, focus };
}

/** Écart moyen absolu entre deux signatures (0..255). */
function sigDistance(a: string, b: string): number {
  if (!a || a.length !== b.length) return 255;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a.charCodeAt(i) - b.charCodeAt(i));
  return d / a.length;
}

function hamming(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) return 64;
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) {
      x &= x - 1;
      d++;
    }
  }
  return d;
}

async function canvasToThumb(src: CanvasImageSource, sw: number, sh: number): Promise<string> {
  const T = 360;
  const s = Math.min(1, T / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * s));
  c.height = Math.max(1, Math.round(sh * s));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.82));
  return URL.createObjectURL(blob);
}

// ---------- Photos ----------
async function analyzePhoto(file: File, item: MediaItem) {
  const exif = await readExif(file);
  if (exif.date) {
    item.date = exif.date;
    item.dateSource = 'exif';
  }
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    throw new Error(
      /\.(heic|heif)$/i.test(file.name)
        ? 'HEIC non lisible par ce navigateur (utilisez Safari ou exportez en JPEG)'
        : 'Image illisible',
    );
  }
  item.width = bmp.width;
  item.height = bmp.height;
  item.thumb = await canvasToThumb(bmp, bmp.width, bmp.height);
  Object.assign(item, analyzePixels(bmp, bmp.width, bmp.height));
  bmp.close();
}

// ---------- Vidéos ----------
async function videoFrameViaElement(file: File, at: number): Promise<{ c: HTMLCanvasElement; dur: number }> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    await new Promise<void>((res, rej) => {
      v.onloadedmetadata = () => res();
      v.onerror = () => rej(new Error('Vidéo illisible'));
    });
    const dur = isFinite(v.duration) ? v.duration : 0;
    v.currentTime = Math.min(dur * at, Math.max(0, dur - 0.1));
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      setTimeout(res, 3000);
    });
    const c = document.createElement('canvas');
    c.width = v.videoWidth || 640;
    c.height = v.videoHeight || 360;
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    return { c, dur };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function analyzeVideo(file: File, item: MediaItem) {
  const created = await videoCreationDate(file);
  if (created) {
    item.date = created;
    item.dateSource = 'video';
  }
  let frame: CanvasImageSource | null = null;
  let fw = 0,
    fh = 0;
  try {
    const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const tags = await input.getMetadataTags().catch(() => ({}) as { date?: Date });
    if (!created && tags.date instanceof Date && !isNaN(tags.date.getTime()) && tags.date.getFullYear() > 1971) {
      item.date = tags.date.getTime();
      item.dateSource = 'video';
    }
    item.duration = await input.computeDuration();
    const vt = await input.getPrimaryVideoTrack();
    const at = await input.getPrimaryAudioTrack();
    item.hasAudio = !!at;
    if (vt) {
      item.width = vt.displayWidth;
      item.height = vt.displayHeight;
      if (await vt.canDecode()) {
        const sink = new CanvasSink(vt, { width: 480 });
        const wc = await sink.getCanvas(Math.min(item.duration * 0.15, 2));
        if (wc) {
          frame = wc.canvas as HTMLCanvasElement;
          fw = wc.canvas.width;
          fh = wc.canvas.height;
        }
      }
    }
    input.dispose?.();
  } catch {
    /* repli ci-dessous */
  }
  if (!frame) {
    const { c, dur } = await videoFrameViaElement(file, 0.15);
    frame = c;
    fw = c.width;
    fh = c.height;
    if (!item.duration) item.duration = dur;
    if (!item.width) {
      item.width = fw;
      item.height = fh;
    }
    item.hasAudio = true;
  }
  item.thumb = await canvasToThumb(frame, fw, fh);
  Object.assign(item, analyzePixels(frame, fw, fh));
  // Les vidéos sont précieuses : léger bonus de score.
  item.score = Math.min(1, item.score * 0.8 + 0.25);
}

export function blankItem(kind: 'photo' | 'video', name: string, path: string, size: number): MediaItem {
  return {
    id: uid(),
    kind,
    file: null,
    name,
    path,
    size,
    date: Date.now(),
    dateSource: 'file',
    width: 1920,
    height: 1080,
    duration: 0,
    hasAudio: false,
    thumb: '',
    hash: '',
    phash: '',
    sig: '',
    score: 0.5,
    focus: { x: 0.5, y: 0.45 },
    duplicateOf: null,
    similarTo: null,
    excluded: false,
  };
}

export async function analyzeFile(file: File, path: string): Promise<MediaItem | null> {
  const kind = mediaKindOf(file);
  if (!kind) return null;
  const item = blankItem(kind, file.name, path, file.size);
  item.file = file;
  item.date = file.lastModified || Date.now();
  const fromName = dateFromFilename(file.name);
  if (fromName) {
    item.date = fromName;
    item.dateSource = 'filename';
  }
  try {
    const [hash] = await Promise.all([
      exactHash(file),
      kind === 'photo' ? analyzePhoto(file, item) : analyzeVideo(file, item),
    ]);
    item.hash = hash;
  } catch (e) {
    item.error = (e as Error).message || 'Fichier illisible';
    item.excluded = true;
  }
  return item;
}

/** Repère doublons stricts, quasi-doublons (rafales, copies recompressées) et vidéos Live Photo. */
export function markDuplicates(items: MediaItem[], opts: ImportOptions) {
  for (const it of items) {
    it.duplicateOf = null;
    it.similarTo = null;
  }
  // 1. Doublons stricts (même contenu binaire)
  const byHash = new Map<string, MediaItem[]>();
  for (const it of items) {
    if (!it.hash) continue;
    const arr = byHash.get(it.hash) ?? [];
    arr.push(it);
    byHash.set(it.hash, arr);
  }
  const rank = (m: MediaItem) => ({ exif: 0, video: 0, manual: 0, filename: 1, demo: 1, file: 2 })[m.dateSource];
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => rank(a) - rank(b) || a.date - b.date || a.name.length - b.name.length);
    for (let i = 1; i < group.length; i++) group[i].duplicateOf = group[0].id;
  }
  // 2. Live Photos : vidéo courte portant le même nom qu'une photo
  const photoByBase = new Map<string, MediaItem>();
  for (const it of items)
    if (it.kind === 'photo' && !it.duplicateOf) photoByBase.set(it.name.replace(/\.[^.]+$/, '').toLowerCase(), it);
  for (const it of items) {
    if (it.kind !== 'video' || it.duplicateOf || it.duration > 4.5) continue;
    const p = photoByBase.get(it.name.replace(/\.[^.]+$/, '').toLowerCase());
    if (p) it.similarTo = p.id;
  }
  if (!opts.nearDuplicates) return;
  // 3. Quasi-doublons photo (dHash)
  const photos = items
    .filter((m) => m.kind === 'photo' && !m.duplicateOf && m.phash && !m.error)
    .sort((a, b) => a.date - b.date);
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let p = parent.get(id) ?? id;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const strict = Math.max(2, Math.round(opts.similarity * 0.5));
  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      const a = photos[i],
        b = photos[j];
      if (Math.abs(a.width / a.height - b.width / b.height) > 0.05) continue;
      const dt = b.date - a.date;
      const d = hamming(a.phash, b.phash);
      const burst = dt <= 90_000;
      const sd = d <= opts.similarity + 8 ? sigDistance(a.sig, b.sig) : 255;
      // rafale : prises à quelques secondes d'intervalle et visuellement proches
      // copie : quasi identique quelle que soit la date (recompression, capture…)
      if (burst ? d <= opts.similarity || sd <= opts.similarity * 1.1 : d <= strict && sd <= 4) union(a.id, b.id);
    }
  }
  const groups = new Map<string, MediaItem[]>();
  for (const p of photos) {
    const r = find(p.id);
    const arr = groups.get(r) ?? [];
    arr.push(p);
    groups.set(r, arr);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => b.score - a.score);
    for (let i = 1; i < g.length; i++) g[i].similarTo = g[0].id;
  }
}

/** Fichiers à partir d'un glisser-déposer (dossiers inclus). */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<{ file: File; path: string }[]> {
  const out: { file: File; path: string }[] = [];
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const e = item.webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  if (!entries.length) return Array.from(dt.files).map((f) => ({ file: f, path: f.name }));
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file: f, path: prefix + f.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, prefix + entry.name + '/');
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

/** Sélecteur de dossier natif (File System Access API) avec parcours récursif. */
export async function filesFromDirectoryHandle(): Promise<{ file: File; path: string }[] | null> {
  const w = window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> };
  if (!w.showDirectoryPicker) return null;
  const root = await w.showDirectoryPicker({ mode: 'read' });
  const out: { file: File; path: string }[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
    // @ts-expect-error itération asynchrone des entrées (API récente)
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (handle.kind === 'file') {
        const f = await (handle as FileSystemFileHandle).getFile();
        if (mediaKindOf(f)) out.push({ file: f, path: prefix + name });
      } else await walk(handle as FileSystemDirectoryHandle, prefix + name + '/');
    }
  };
  await walk(root, root.name + '/');
  return out;
}
