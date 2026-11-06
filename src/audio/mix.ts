// Mixage audio final (export) : musique + son des vidéos, fondus et ducking.
import { ALL_FORMATS, AudioBufferSink, BlobSource, BufferTarget, EncodedAudioPacketSource, EncodedPacketSink, Input, Mp4OutputFormat, Output, type InputAudioTrack } from 'mediabunny';
import { ensureDecoder } from '../media/codecs';
import type { MediaItem, Project } from '../types';
import type { Placed } from '../story/timeline';
import { applyMusicEnvelope, duckingSegments } from './envelope';

/** Extrait le son d'une vidéo entre deux instants (s). */
export async function extractAudio(file: File, start: number, end: number): Promise<AudioBuffer | null> {
  let input: Input | null = null;
  try {
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    await ensureDecoder(track.codec);
    // temps relatifs au début de la vidéo (les flux MTS ne commencent pas à 0)
    const vt = await input.getPrimaryVideoTrack();
    const base = await (vt ?? track).getFirstTimestamp().catch(() => 0);
    start += base;
    end += base;
    const forceNoDecoder = (globalThis as { __editgoNoAudioDecoder?: boolean }).__editgoNoAudioDecoder;
    if (!forceNoDecoder && (await track.canDecode())) return await decodeRange(track, start, end);
    // pas de décodeur audio WebCodecs (iPhone, Safari) : on recopie seulement l'extrait
    // compressé dans un petit fichier, que Web Audio décode (quelques Mo au lieu du fichier entier)
    return await remuxRange(track, start, end);
  } catch {
    return null;
  } finally {
    input?.dispose?.();
  }
}

async function decodeRange(track: InputAudioTrack, start: number, end: number): Promise<AudioBuffer> {
  const sr = track.sampleRate;
  const ch = Math.min(2, track.numberOfChannels);
  const out = new AudioBuffer({ length: Math.max(1, Math.ceil((end - start) * sr)), numberOfChannels: ch, sampleRate: sr });
  const sink = new AudioBufferSink(track);
  for await (const { buffer, timestamp } of sink.buffers(start, end)) {
    const off = Math.round((timestamp - start) * sr);
    for (let c = 0; c < ch; c++) {
      const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
      const dst = out.getChannelData(c);
      const from = Math.max(0, -off);
      const n = Math.min(src.length - from, dst.length - Math.max(0, off));
      if (n > 0) dst.set(src.subarray(from, from + n), Math.max(0, off));
    }
  }
  return out;
}

async function remuxRange(track: InputAudioTrack, start: number, end: number): Promise<AudioBuffer | null> {
  const codec = track.codec;
  const cfg = await track.getDecoderConfig();
  if (!codec || !cfg) return null;
  const sink = new EncodedPacketSink(track);
  // un peu de marge avant : le décodeur AAC a besoin des paquets précédents pour démarrer proprement
  const first = (await sink.getPacket(Math.max(0, start - 0.2))) ?? (await sink.getFirstPacket());
  if (!first) return null;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const src = new EncodedAudioPacketSource(codec);
  output.addAudioTrack(src);
  await output.start();
  const t0 = first.timestamp;
  let meta: EncodedAudioChunkMetadata | undefined = { decoderConfig: cfg };
  for await (const pk of sink.packets(first)) {
    if (pk.timestamp > end + 0.1) break;
    await src.add(pk.clone({ timestamp: pk.timestamp - t0 }), meta);
    meta = undefined;
  }
  await output.finalize();
  if (!target.buffer) return null;
  const ctx = new OfflineAudioContext(1, 1, cfg.sampleRate || 48000);
  const dec = await ctx.decodeAudioData(target.buffer);
  const sr = dec.sampleRate;
  const ch = Math.min(2, dec.numberOfChannels);
  const len = Math.max(1, Math.ceil((end - start) * sr));
  const out = new AudioBuffer({ length: len, numberOfChannels: ch, sampleRate: sr });
  const off = Math.max(0, Math.round((start - t0) * sr));
  for (let c = 0; c < ch; c++) out.getChannelData(c).set(dec.getChannelData(c).subarray(off, off + len));
  return out;
}

export async function mixAudio(opts: {
  project: Project;
  media: Map<string, MediaItem>;
  placed: Placed[];
  total: number;
  music: AudioBuffer | null;
  sampleRate?: number;
  onProgress?: (f: number) => void;
}): Promise<AudioBuffer> {
  const { project, media, placed, total, music } = opts;
  const sr = opts.sampleRate ?? 48000;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * sr)), sr);
  const segs = duckingSegments(placed, media);
  if (music && project.music.kind !== 'none') {
    const src = ctx.createBufferSource();
    src.buffer = music;
    src.loop = music.duration < total + project.music.offset;
    const g = ctx.createGain();
    applyMusicEnvelope(g.gain, project, total, segs);
    src.connect(g).connect(ctx.destination);
    src.start(0, Math.min(project.music.offset, Math.max(0, music.duration - 0.1)));
  }
  const vids = placed.filter((p) => {
    const m = p.clip.mediaId ? media.get(p.clip.mediaId) : undefined;
    return p.clip.type === 'media' && m?.kind === 'video' && m.file && m.hasAudio && p.clip.volume > 0.01;
  });
  let done = 0;
  for (const p of vids) {
    const m = media.get(p.clip.mediaId!)!;
    const c = p.clip;
    const buf = await extractAudio(m.file!, c.trimIn, Math.min(m.duration, c.trimIn + c.duration * c.speed + 0.05));
    opts.onProgress?.(++done / vids.length);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = c.speed;
    const g = ctx.createGain();
    const next = placed[p.index + 1];
    const fadeIn = Math.max(0.12, p.tIn);
    const fadeOut = Math.max(0.15, next ? next.tIn : 0.3);
    g.gain.setValueAtTime(0, p.start);
    g.gain.linearRampToValueAtTime(c.volume, p.start + fadeIn);
    g.gain.setValueAtTime(c.volume, Math.max(p.start + fadeIn, p.end - fadeOut));
    g.gain.linearRampToValueAtTime(0, p.end);
    src.connect(g).connect(ctx.destination);
    src.start(p.start);
    src.stop(p.end + 0.01);
  }
  return ctx.startRendering();
}

/**
 * Mixage d'une tranche [s0, s0 + n/sr) du film (export long : mémoire constante).
 * Les tranches successives s'enchaînent à l'échantillon près.
 */
export async function mixAudioChunk(opts: {
  project: Project;
  media: Map<string, MediaItem>;
  placed: Placed[];
  total: number;
  music: AudioBuffer | null;
  s0: number;
  n: number;
  sampleRate: number;
}): Promise<AudioBuffer> {
  const { project, media, placed, total, music, s0, n, sampleRate: sr } = opts;
  const s1 = s0 + n / sr;
  const ctx = new OfflineAudioContext(2, n, sr);
  const segs = duckingSegments(placed, media);
  if (music && project.music.kind !== 'none') {
    const loop = music.duration < total + project.music.offset;
    const off = project.music.offset + s0;
    if (loop || off < music.duration) {
      const src = ctx.createBufferSource();
      src.buffer = music;
      src.loop = loop;
      const g = ctx.createGain();
      applyMusicEnvelope(g.gain, project, total, segs, s0);
      src.connect(g).connect(ctx.destination);
      src.start(0, loop ? off % music.duration : off);
    }
  }
  for (const p of placed) {
    if (p.end <= s0 || p.start >= s1) continue;
    const m = p.clip.mediaId ? media.get(p.clip.mediaId) : undefined;
    const c = p.clip;
    if (c.type !== 'media' || m?.kind !== 'video' || !m.file || !m.hasAudio || c.volume <= 0.01) continue;
    const a = Math.max(s0, p.start),
      b = Math.min(s1, p.end);
    const buf = await extractAudio(m.file, c.trimIn + (a - p.start) * c.speed, Math.min(m.duration, c.trimIn + (b - p.start) * c.speed + 0.05));
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = c.speed;
    const g = ctx.createGain();
    const next = placed[p.index + 1];
    const fi = Math.max(0.12, p.tIn),
      fo = Math.max(0.15, next ? next.tIn : 0.3);
    // enveloppe (temps absolus) ramenée à la tranche
    const env = (t: number) => c.volume * Math.max(0, Math.min(1, (t - p.start) / fi, (p.end - t) / fo));
    const pts = [a, p.start + fi, p.end - fo, b].filter((t) => t >= a && t <= b).sort((x, y) => x - y);
    g.gain.setValueAtTime(env(a), a - s0);
    for (const t of pts.slice(1)) g.gain.linearRampToValueAtTime(env(t), t - s0);
    src.connect(g).connect(ctx.destination);
    src.start(a - s0);
    src.stop(b - s0 + 0.01);
  }
  return ctx.startRendering();
}
