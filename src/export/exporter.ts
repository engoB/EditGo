// Export image par image (non temps réel) en MP4 / WebM via WebCodecs + Mediabunny.
import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type VideoCodec,
  type AudioCodec,
  type WrappedCanvas,
} from 'mediabunny';
import type { MediaItem, Project } from '../types';
import { Compositor, type SourceFrame } from '../render/compositor';
import { buildFrame, type SourceProvider } from '../render/frame';
import { ImageCache } from '../render/images';
import { layout, stateAt, type Placed } from '../story/timeline';
import { mixAudio } from '../audio/mix';

export type Container = 'mp4' | 'webm';
export type QualityLevel = 'standard' | 'high' | 'max';

export interface ExportJob {
  label: string;
  width: number;
  height: number;
  fps: number;
  container: Container;
  quality: QualityLevel;
  audio: boolean;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  codec: string;
  seconds: number;
}

const VIDEO_PREFS: Record<Container, VideoCodec[]> = {
  mp4: ['avc', 'hevc', 'vp9', 'av1'],
  webm: ['vp9', 'av1', 'vp8'],
};
const AUDIO_PREFS: Record<Container, AudioCodec[]> = {
  mp4: ['aac', 'opus'],
  webm: ['opus', 'vorbis'],
};
const CODEC_LABEL: Record<string, string> = { avc: 'H.264', hevc: 'H.265 / HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8', aac: 'AAC', opus: 'Opus', vorbis: 'Vorbis' };

export async function probeCodecs(w: number, h: number) {
  const [mp4, webm] = await Promise.all([
    getFirstEncodableVideoCodec(VIDEO_PREFS.mp4, { width: w, height: h }),
    getFirstEncodableVideoCodec(VIDEO_PREFS.webm, { width: w, height: h }),
  ]);
  return { mp4: mp4 ? CODEC_LABEL[mp4] : null, webm: webm ? CODEC_LABEL[webm] : null };
}

/** Fournisseur de sources pour l'export : décodage pleine définition, synchrone image par image. */
class ExportSources implements SourceProvider {
  private images: ImageCache;
  private videoIters = new Map<string, AsyncGenerator<WrappedCanvas | null, void, unknown>>();
  private videoFallback = new Map<string, HTMLVideoElement>();
  private current = new Map<string, SourceFrame | null>();
  private inputs: Input[] = [];

  constructor(
    private media: Map<string, MediaItem>,
    private placed: Placed[],
    private fps: number,
    private frames: number,
    maxSide: number,
    private seekOnly = false,
  ) {
    this.images = new ImageCache(maxSide, 10);
  }

  private timestampsFor(p: Placed): number[] {
    const out: number[] = [];
    const m = this.media.get(p.clip.mediaId!)!;
    const f0 = Math.max(0, Math.floor(p.start * this.fps));
    const f1 = Math.min(this.frames - 1, Math.ceil(p.end * this.fps));
    for (let f = f0; f <= f1; f++) {
      const t = f / this.fps;
      if (t < p.start || t >= p.end) continue;
      out.push(Math.min(m.duration - 0.001, p.clip.trimIn + (t - p.start) * p.clip.speed));
    }
    return out;
  }

  private async videoIter(p: Placed, m: MediaItem, maxSide: number) {
    let it = this.videoIters.get(p.clip.id);
    if (it) return it;
    const input = new Input({ source: new BlobSource(m.file!), formats: ALL_FORMATS });
    this.inputs.push(input);
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('no-decode');
    const s = Math.min(1, maxSide / Math.max(track.displayWidth, track.displayHeight));
    const sink = new CanvasSink(track, { width: Math.round(track.displayWidth * s), height: Math.round(track.displayHeight * s), poolSize: 3 });
    it = sink.canvasesAtTimestamps(this.timestampsFor(p));
    this.videoIters.set(p.clip.id, it);
    return it;
  }

  private async seekFallback(p: Placed, m: MediaItem, t: number): Promise<SourceFrame | null> {
    let v = this.videoFallback.get(p.clip.id);
    if (!v) {
      v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.src = URL.createObjectURL(m.file!);
      await new Promise((r) => (v!.onloadeddata = r));
      this.videoFallback.set(p.clip.id, v);
    }
    const target = Math.min(m.duration - 0.01, p.clip.trimIn + (t - p.start) * p.clip.speed);
    if (Math.abs(v.currentTime - target) > 0.001) {
      v.currentTime = target;
      await new Promise<void>((r) => {
        const done = () => r();
        v!.onseeked = done;
        setTimeout(done, 2000);
      });
    }
    return { key: 'xv:' + p.clip.id, image: v, w: v.videoWidth, h: v.videoHeight, dynamic: true };
  }

  async prepare(t: number, maxSide: number) {
    const st = stateAt(this.placed, t);
    this.current.clear();
    for (const p of [st.a, st.b]) {
      if (!p || !p.clip.mediaId) continue;
      if (p.clip.type === 'title' && p.clip.background !== 'blur') continue;
      const m = this.media.get(p.clip.mediaId);
      if (!m) continue;
      for (const id of p.clip.extra ?? []) {
        const x = this.media.get(id);
        if (!x || (!x.file && !x.demo)) continue;
        const d = await this.images.load(x);
        if (d) this.current.set(p.clip.id + '|' + x.id, { key: 'xi:' + x.id, image: d.image, w: d.w, h: d.h, dynamic: false });
      }
      if (!m.file && !m.demo) {
        this.current.set(p.clip.id, null);
        continue;
      }
      if (m.kind === 'photo' || p.clip.type === 'title') {
        if (m.kind === 'video') {
          // carton-titre sur fond vidéo : vignette
          this.current.set(p.clip.id, null);
          continue;
        }
        const d = await this.images.load(m);
        this.current.set(p.clip.id, d ? { key: 'xi:' + m.id, image: d.image, w: d.w, h: d.h, dynamic: false } : null);
      } else {
        if (this.seekOnly || this.videoFallback.has(p.clip.id)) {
          this.current.set(p.clip.id, await this.seekFallback(p, m, t));
          continue;
        }
        try {
          const it = await this.videoIter(p, m, maxSide);
          const r = await it.next();
          const wc = r.done ? null : r.value;
          if (wc) this.current.set(p.clip.id, { key: 'xv:' + p.clip.id, image: wc.canvas as TexImageSource, w: wc.canvas.width, h: wc.canvas.height, dynamic: true });
          else this.current.set(p.clip.id, this.lastFrame.get(p.clip.id) ?? null);
        } catch {
          this.current.set(p.clip.id, await this.seekFallback(p, m, t));
        }
        const cur = this.current.get(p.clip.id);
        if (cur) this.lastFrame.set(p.clip.id, cur);
      }
    }
  }
  private lastFrame = new Map<string, SourceFrame>();

  frame(p: Placed): SourceFrame | null {
    return this.current.get(p.clip.id) ?? null;
  }

  still(p: Placed, m: MediaItem): SourceFrame | null {
    return this.current.get(p.clip.id + '|' + m.id) ?? null;
  }

  dispose() {
    this.images.clear();
    for (const it of this.videoIters.values()) void it.return?.();
    for (const v of this.videoFallback.values()) URL.revokeObjectURL(v.src);
    for (const i of this.inputs) i.dispose?.();
  }
}

export async function runExport(opts: {
  project: Project;
  media: Map<string, MediaItem>;
  job: ExportJob;
  music: AudioBuffer | null;
  onProgress: (fraction: number, stage: string, preview?: HTMLCanvasElement) => void;
  signal: AbortSignal;
}): Promise<ExportResult> {
  const { project, media, job, signal } = opts;
  const t0 = performance.now();
  const { placed, total } = layout(project.clips);
  if (!placed.length || total <= 0) throw new Error('Le montage est vide.');
  const W = job.width,
    H = job.height;
  const quality = job.quality === 'max' ? QUALITY_VERY_HIGH : job.quality === 'high' ? QUALITY_HIGH : QUALITY_MEDIUM;
  const vcodec = await getFirstEncodableVideoCodec(VIDEO_PREFS[job.container], { width: W, height: H, quality, frameRate: job.fps });
  if (!vcodec) throw new Error(`Aucun encodeur vidéo ${job.container.toUpperCase()} disponible pour ${W}×${H} sur ce navigateur.`);
  let acodec: AudioCodec | null = null;
  if (job.audio) acodec = await getFirstEncodableAudioCodec(AUDIO_PREFS[job.container], { numberOfChannels: 2, sampleRate: 48000 });

  const canvas = document.createElement('canvas');
  const comp = new Compositor(canvas, { preserve: true });
  comp.maxCached = 12;
  comp.resize(W, H);
  const overlayCanvas = document.createElement('canvas');
  const overlay = { canvas: overlayCanvas, ctx: overlayCanvas.getContext('2d')! };
  const frames = Math.max(1, Math.round(total * job.fps));
  const maxSide = Math.min(4096, Math.round(Math.max(W, H) * 1.2));
  const sources = new ExportSources(media, placed, job.fps, frames, maxSide);

  const output = new Output({
    format: job.container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, { codec: vcodec, bitrate: quality, keyFrameInterval: 2, latencyMode: 'quality' } as ConstructorParameters<typeof CanvasSource>[1]);
  output.addVideoTrack(videoSource, { frameRate: job.fps });
  let audioSource: AudioBufferSource | null = null;
  if (acodec) {
    audioSource = new AudioBufferSource({ codec: acodec, bitrate: job.quality === 'standard' ? 160_000 : 256_000 });
    output.addAudioTrack(audioSource);
  }
  output.setMetadataTags({ title: project.title, date: new Date(), comment: 'Créé avec EditGo' });

  try {
    await output.start();
    if (audioSource) {
      opts.onProgress(0, 'Mixage audio');
      const mixed = await mixAudio({ project, media, placed, total, music: opts.music, onProgress: (f) => opts.onProgress(f * 0.04, 'Mixage audio') });
      if (signal.aborted) throw new DOMException('Annulé', 'AbortError');
      await audioSource.add(mixed);
      audioSource.close();
    }
    const dt = 1 / job.fps;
    let lastUi = 0;
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new DOMException('Annulé', 'AbortError');
      const t = i * dt;
      await sources.prepare(t, maxSide);
      const fd = buildFrame({ project, media, placed, total, t, W, H, provider: sources, overlay });
      comp.render(fd);
      await videoSource.add(t, dt);
      const now = performance.now();
      if (now - lastUi > 120 || i === frames - 1) {
        lastUi = now;
        opts.onProgress(0.04 + 0.94 * ((i + 1) / frames), `Image ${i + 1} / ${frames}`, canvas);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    videoSource.close();
    opts.onProgress(0.99, 'Finalisation');
    await output.finalize();
  } catch (e) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => null);
    throw e;
  } finally {
    sources.dispose();
    comp.dispose();
  }
  const buf = (output.target as BufferTarget).buffer!;
  const mime = job.container === 'mp4' ? 'video/mp4' : 'video/webm';
  const safe = (project.title || 'souvenir').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return {
    blob: new Blob([buf], { type: mime }),
    fileName: `${safe || 'souvenir'}-${W}x${H}-${job.fps}fps.${job.container}`,
    codec: CODEC_LABEL[vcodec] + (acodec ? ' + ' + CODEC_LABEL[acodec] : ''),
    seconds: (performance.now() - t0) / 1000,
  };
}

/** Image fixe (PNG) à l'instant t, pleine définition. */
export async function exportStill(opts: { project: Project; media: Map<string, MediaItem>; t: number; width: number; height: number }): Promise<Blob> {
  const { placed, total } = layout(opts.project.clips);
  const canvas = document.createElement('canvas');
  const comp = new Compositor(canvas, { preserve: true });
  comp.resize(opts.width, opts.height);
  const overlayCanvas = document.createElement('canvas');
  const overlay = { canvas: overlayCanvas, ctx: overlayCanvas.getContext('2d')! };
  const fps = 30;
  const frames = Math.round(total * fps);
  const maxSide = Math.min(4096, Math.max(opts.width, opts.height) * 1.2);
  const src = new ExportSources(opts.media, placed, fps, frames, maxSide, true);
  try {
    // pour une vidéo, on se place à l'image voulue en parcourant depuis le début du plan
    await src.prepare(opts.t, maxSide);
    comp.render(buildFrame({ project: opts.project, media: opts.media, placed, total, t: opts.t, W: opts.width, H: opts.height, provider: src, overlay }));
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG'))), 'image/png'));
  } finally {
    src.dispose();
    comp.dispose();
  }
}
