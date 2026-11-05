// Mixage audio final (export) : musique + son des vidéos, fondus et ducking.
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import { ensureDecoder } from '../media/codecs';
import type { MediaItem, Project } from '../types';
import type { Placed } from '../story/timeline';
import { applyMusicEnvelope, duckingSegments } from './envelope';

/** Extrait le son d'une vidéo entre deux instants (s). */
export async function extractAudio(file: File, start: number, end: number): Promise<AudioBuffer | null> {
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (track) await ensureDecoder(track.codec);
    if (!track || !(await track.canDecode())) throw new Error('no-decode');
    // temps relatifs au début de la vidéo (les flux MTS ne commencent pas à 0)
    const vt = await input.getPrimaryVideoTrack();
    const base = await (vt ?? track).getFirstTimestamp().catch(() => 0);
    start += base;
    end += base;
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
    input.dispose?.();
    return out;
  } catch {
    try {
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      const full = await ctx.decodeAudioData(await file.arrayBuffer());
      const sr = full.sampleRate;
      const a = Math.floor(start * sr),
        b = Math.min(full.length, Math.ceil(end * sr));
      const out = new AudioBuffer({ length: Math.max(1, b - a), numberOfChannels: full.numberOfChannels, sampleRate: sr });
      for (let c = 0; c < full.numberOfChannels; c++) out.getChannelData(c).set(full.getChannelData(c).subarray(a, b));
      return out;
    } catch {
      return null;
    }
  }
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
