// Export image par image (non temps réel) en MP4 / WebM via WebCodecs + Mediabunny.
import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  StreamTarget,
  type StreamTargetChunk,
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
  canEncodeAudio,
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
import { mixAudioChunk } from '../audio/mix';
import { lazy } from '../lazy';
import { FrameReader } from '../media/framereader';

export type Container = 'mp4' | 'webm';
export type QualityLevel = 'standard' | 'high' | 'max';

/** Destination de l'export : fichier sur disque (flux) ou mémoire (courts exports). */
export type ExportDest =
  | { kind: 'buffer' }
  | { kind: 'stream'; writable: WritableStream<StreamTargetChunk> | FileSystemWritableFileStream; getFile: () => Promise<File>; where: string };

export function fileNameFor(project: Project, job: ExportJob): string {
  const safe = (project.title || 'souvenir').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return `${safe || 'souvenir'}-${job.width}x${job.height}-${job.fps}fps.${job.container}`;
}

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
  warnings: string[];
  /** Emplacement du fichier quand il est écrit directement sur le disque. */
  savedTo?: string;
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
const TIMEOUT = Symbol('timeout');
/** Attend une promesse au plus `ms` millisecondes (les décodeurs matériels mobiles peuvent caler sans erreur). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer = 0;
  const t = new Promise<typeof TIMEOUT>((r) => (timer = window.setTimeout(() => r(TIMEOUT), ms)));
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

class ExportSources implements SourceProvider {
  private images: ImageCache;
  private videoIters = new Map<string, AsyncGenerator<WrappedCanvas | null, void, unknown>>();
  /** Libération des ressources d'un plan (décodeur, fichier) dès qu'il est terminé. */
  private releasers = new Map<string, () => void>();
  /** Plans vidéo dont le décodage a calé : rendus avec leur vignette. */
  stalled = new Set<string>();
  private videoFallback = new Map<string, HTMLVideoElement>();
  private current = new Map<string, SourceFrame | null>();

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
    if (m.decode) {
      // lecture directe par le décodeur (MTS AVCHD, entrelacé…)
      const reader = await FrameReader.open(m.file!, maxSide);
      it = reader.atTimestamps(this.timestampsFor(p)) as unknown as AsyncGenerator<WrappedCanvas | null, void, unknown>;
      this.videoIters.set(p.clip.id, it);
      const it0 = it;
      this.releasers.set(p.clip.id, () => {
        void it0.return?.(undefined);
        reader.dispose();
      });
      return it;
    }
    const input = new Input({ source: new BlobSource(m.file!), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('no-decode');
    const s = Math.min(1, maxSide / Math.max(track.displayWidth, track.displayHeight));
    const sink = new CanvasSink(track, { width: Math.round(track.displayWidth * s), height: Math.round(track.displayHeight * s), poolSize: 3 });
    const first = await track.getFirstTimestamp().catch(() => 0);
    it = sink.canvasesAtTimestamps(this.timestampsFor(p).map((t) => t + first));
    this.videoIters.set(p.clip.id, it);
    const it0 = it;
    this.releasers.set(p.clip.id, () => {
      void it0.return?.(undefined);
      input.dispose?.();
    });
    return it;
  }

  /** Ferme les décodeurs des plans terminés (un téléphone n'en a que quelques-uns). */
  private releaseFinished(t: number) {
    for (const p of this.placed) {
      if (p.end > t) continue;
      const rel = this.releasers.get(p.clip.id);
      if (rel) {
        rel();
        this.releasers.delete(p.clip.id);
        this.videoIters.delete(p.clip.id);
      }
      const v = this.videoFallback.get(p.clip.id);
      if (v) {
        URL.revokeObjectURL(v.src);
        v.removeAttribute('src');
        this.videoFallback.delete(p.clip.id);
      }
    }
  }

  /** Libellé du plan en cours (affiché dans la progression). */
  describe(t: number): string {
    const st = stateAt(this.placed, t);
    const p = st.b ?? st.a;
    if (!p) return '';
    const m = p.clip.mediaId ? this.media.get(p.clip.mediaId) : undefined;
    return `plan ${p.index + 1}/${this.placed.length}${m ? ' · ' + m.name : ''}`;
  }

  private async seekFallback(p: Placed, m: MediaItem, t: number): Promise<SourceFrame | null> {
    let v = this.videoFallback.get(p.clip.id);
    if (!v) {
      v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.src = URL.createObjectURL(m.file!);
      const ok = await within(
        new Promise<boolean>((r) => {
          v!.onloadeddata = () => r(true);
          v!.onerror = () => r(false);
        }),
        8000,
      );
      if (ok !== true) {
        URL.revokeObjectURL(v.src);
        return null;
      }
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
    this.releaseFinished(t);
    for (const p of [st.a, st.b]) {
      if (!p || !p.clip.mediaId) continue;
      if (p.clip.type === 'title' && p.clip.background !== 'blur') continue;
      const m = this.media.get(p.clip.mediaId);
      if (!m) continue;
      for (const id of p.clip.extra ?? []) {
        const x = this.media.get(id);
        if (!x) continue;
        const d = x.file || x.demo ? await this.images.load(x) : null;
        this.current.set(p.clip.id + '|' + x.id, d ? { key: 'xi:' + x.id, image: d.image, w: d.w, h: d.h, dynamic: false } : await this.thumbFrame(x));
      }
      if (!m.file && !m.demo) {
        this.current.set(p.clip.id, await this.thumbFrame(m));
        continue;
      }
      if (m.kind === 'photo' || p.clip.type === 'title') {
        if (m.kind === 'video') {
          // carton-titre sur fond vidéo : vignette
          this.current.set(p.clip.id, await this.thumbFrame(m));
          continue;
        }
        const r = await within(this.images.load(m), 20000);
        const d = r === TIMEOUT ? null : r;
        this.current.set(p.clip.id, d ? { key: 'xi:' + m.id, image: d.image, w: d.w, h: d.h, dynamic: false } : await this.thumbFrame(m));
      } else {
        if (this.seekOnly || this.videoFallback.has(p.clip.id)) {
          this.current.set(p.clip.id, await this.seekFallback(p, m, t));
          continue;
        }
        if (this.stalled.has(p.clip.id)) {
          this.current.set(p.clip.id, this.lastFrame.get(p.clip.id) ?? (await this.thumbFrame(m)));
          continue;
        }
        try {
          const itR = await within(this.videoIter(p, m, maxSide), 15000);
          if (itR === TIMEOUT) throw new Error('stall');
          const r = await within(itR.next(), 10000);
          if (r === TIMEOUT) {
            // décodeur figé : on libère et on continue avec la dernière image (ou la vignette)
            this.stalled.add(p.clip.id);
            this.releasers.get(p.clip.id)?.();
            this.releasers.delete(p.clip.id);
            this.fallbacks.add(m.id);
            this.current.set(p.clip.id, this.lastFrame.get(p.clip.id) ?? (await this.thumbFrame(m)));
            continue;
          }
          const wc = r.done ? null : r.value;
          if (wc) this.current.set(p.clip.id, { key: 'xv:' + p.clip.id, image: wc.canvas as TexImageSource, w: wc.canvas.width, h: wc.canvas.height, dynamic: true });
          else this.current.set(p.clip.id, this.lastFrame.get(p.clip.id) ?? (await this.thumbFrame(m)));
        } catch {
          const f = (await within(this.seekFallback(p, m, t).catch(() => null), 10000)) as SourceFrame | null | typeof TIMEOUT;
          if (f === TIMEOUT || !f) this.stalled.add(p.clip.id);
          this.current.set(p.clip.id, f && f !== TIMEOUT ? f : await this.thumbFrame(m));
        }
        const cur = this.current.get(p.clip.id);
        if (cur) this.lastFrame.set(p.clip.id, cur);
      }
    }
  }
  private lastFrame = new Map<string, SourceFrame>();
  private thumbs = new Map<string, HTMLImageElement | null>();
  /** Médias rendus avec leur vignette faute de fichier lisible. */
  fallbacks = new Set<string>();

  /** Vignette du média (repli quand le fichier est absent ou illisible : jamais d'image noire). */
  private async thumbFrame(m: MediaItem): Promise<SourceFrame | null> {
    this.fallbacks.add(m.id);
    if (!this.thumbs.has(m.id)) {
      let im: HTMLImageElement | null = null;
      if (m.thumb) {
        im = new Image();
        im.src = m.thumb;
        try {
          await im.decode();
        } catch {
          im = null;
        }
      }
      this.thumbs.set(m.id, im);
    }
    const im = this.thumbs.get(m.id);
    return im ? { key: 'xt:' + m.id, image: im, w: im.naturalWidth, h: im.naturalHeight, dynamic: false } : null;
  }

  /** Clés de textures utilisées par l'image courante. */
  activeKeys(): Set<string> {
    const k = new Set<string>();
    for (const f of this.current.values()) if (f) k.add(f.key);
    return k;
  }

  frame(p: Placed): SourceFrame | null {
    return this.current.get(p.clip.id) ?? null;
  }

  still(p: Placed, m: MediaItem): SourceFrame | null {
    return this.current.get(p.clip.id + '|' + m.id) ?? null;
  }

  dispose() {
    this.images.clear();
    for (const rel of this.releasers.values()) rel();
    this.releasers.clear();
    for (const v of this.videoFallback.values()) URL.revokeObjectURL(v.src);
  }
}

export async function runExport(opts: {
  project: Project;
  media: Map<string, MediaItem>;
  job: ExportJob;
  music: AudioBuffer | null;
  onProgress: (fraction: number, stage: string, preview?: HTMLCanvasElement) => void;
  signal: AbortSignal;
  dest?: ExportDest;
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
  // son : on vérifie aussi le débit (l'encodeur AAC de Windows plafonne à 192 kbit/s)
  let acodec: AudioCodec | null = null;
  let abitrate = 0;
  if (job.audio) {
    const rates = job.quality === 'standard' ? [160_000, 128_000, 96_000] : [256_000, 192_000, 160_000, 128_000];
    search: for (const c of AUDIO_PREFS[job.container]) {
      for (const br of rates) {
        if (await canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000, bitrate: br }).catch(() => false)) {
          acodec = c;
          abitrate = br;
          break search;
        }
      }
    }
    if (!acodec) acodec = await getFirstEncodableAudioCodec(AUDIO_PREFS[job.container], { numberOfChannels: 2, sampleRate: 48000 });
    // pas d'encodeur audio dans ce navigateur (certains iPhone) : encodeur AAC de secours, chargé à la demande
    if (!acodec && job.container === 'mp4') {
      try {
        const { registerAacEncoder } = await lazy(() => import('@mediabunny/aac-encoder'));
        registerAacEncoder();
        for (const br of [192_000, 160_000, 128_000]) {
          if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: br }).catch(() => false)) {
            acodec = 'aac';
            abitrate = br;
            break;
          }
        }
      } catch {
        /* encodeur indisponible : export sans son */
      }
    }
    if (!acodec) opts.onProgress(0, 'Aucun encodeur audio disponible : export sans son');
  }

  // Rendu WebGL copié dans un canvas 2D encodé : si le contexte graphique est perdu
  // (mémoire GPU, pilote), on recrée le compositeur sans interrompre l'export.
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const out2d = canvas.getContext('2d', { alpha: false })!;
  let comp = newComp();
  function newComp() {
    const c = new Compositor(document.createElement('canvas'), { preserve: true });
    c.maxCached = 10;
    c.resize(W, H);
    return c;
  }
  const overlayCanvas = document.createElement('canvas');
  const overlay = { canvas: overlayCanvas, ctx: overlayCanvas.getContext('2d')! };
  const frames = Math.max(1, Math.round(total * job.fps));
  const maxSide = Math.min(4096, Math.round(Math.max(W, H) * 1.2));
  const sources = new ExportSources(media, placed, job.fps, frames, maxSide);

  // destination : fichier sur disque écrit au fil de l'eau (exports longs), sinon mémoire
  const dest = opts.dest ?? { kind: 'buffer' as const };
  const output = new Output({
    format: job.container === 'mp4' ? new Mp4OutputFormat({ fastStart: dest.kind === 'stream' ? false : 'in-memory' }) : new WebMOutputFormat(),
    target:
      dest.kind === 'stream'
        ? new StreamTarget(dest.writable as unknown as WritableStream<StreamTargetChunk>, { chunked: true, chunkSize: 16 * 1024 * 1024 })
        : new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, { codec: vcodec, bitrate: quality, keyFrameInterval: 2, latencyMode: 'quality' } as ConstructorParameters<typeof CanvasSource>[1]);
  output.addVideoTrack(videoSource, { frameRate: job.fps });
  let audioSource: AudioBufferSource | null = null;
  if (acodec) {
    audioSource = new AudioBufferSource(abitrate ? { codec: acodec, bitrate: abitrate } : { codec: acodec, bitrate: QUALITY_HIGH });
    output.addAudioTrack(audioSource);
  }
  output.setMetadataTags({ title: project.title, date: new Date(), comment: 'Créé avec EditGo' });

  let audioGaps = 0;
  try {
    await output.start();
    // son mixé par tranches de 30 s, au fil du rendu des images (mémoire constante)
    const SR = 48000,
      CHUNK = 30 * SR,
      totalSamples = Math.ceil(total * SR);
    let audioDone = 0;
    const feedAudio = async (until: number) => {
      if (!audioSource) return;
      while (audioDone < totalSamples && audioDone / SR < until) {
        const n = Math.min(CHUNK, totalSamples - audioDone);
        const mixed = await within(mixAudioChunk({ project, media, placed, total, music: opts.music, s0: audioDone / SR, n, sampleRate: SR }), 60000);
        // tranche impossible à mixer (décodage figé) : silence plutôt que blocage
        const buf = mixed === TIMEOUT ? new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: SR }) : mixed;
        if (mixed === TIMEOUT) audioGaps++;
        if ((await within(audioSource.add(buf), 60000)) === TIMEOUT) throw new Error('L’encodeur audio de l’appareil ne répond plus. Réessayez sans le son ou au format WebM.');
        audioDone += n;
      }
      if (audioDone >= totalSamples) {
        audioSource.close();
        audioSource = null;
      }
    };
    const dt = 1 / job.fps;
    let lastUi = 0;
    let lost = 0;
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new DOMException('Annulé', 'AbortError');
      const t = i * dt;
      if (audioSource && audioDone / SR < t + 1) await feedAudio(t + 30);
      await sources.prepare(t, maxSide);
      const fd = buildFrame({ project, media, placed, total, t, W, H, provider: sources, overlay });
      for (let attempt = 0; attempt < 3; attempt++) {
        if (comp.lost || comp.gl.isContextLost()) {
          comp.dispose();
          await new Promise((r) => setTimeout(r, 300));
          comp = newComp();
          lost++;
        }
        comp.render(fd);
        if (!comp.lost && !comp.gl.isContextLost()) break;
      }
      comp.retainOnly(sources.activeKeys());
      out2d.drawImage(comp.canvas as HTMLCanvasElement, 0, 0, W, H);
      if ((await within(videoSource.add(t, dt), 45000)) === TIMEOUT)
        throw new Error(`L’encodeur vidéo de l’appareil ne répond plus (image ${i + 1}). Réessayez en HD 720p, ou au format WebM.`);
      const now = performance.now();
      if (now - lastUi > 120 || i === frames - 1) {
        lastUi = now;
        opts.onProgress(0.04 + 0.94 * ((i + 1) / frames), `Image ${i + 1} / ${frames} · ${sources.describe(t)}`, canvas);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await feedAudio(Infinity);
    videoSource.close();
    opts.onProgress(0.99, 'Finalisation');
    await output.finalize();
    if (dest.kind === 'stream') await dest.writable.close().catch(() => null);
  } catch (e) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => null);
    if (dest.kind === 'stream') await dest.writable.abort().catch(() => null);
    throw e;
  } finally {
    sources.dispose();
    comp.dispose();
  }
  const mime = job.container === 'mp4' ? 'video/mp4' : 'video/webm';
  const blob: Blob = dest.kind === 'stream' ? await dest.getFile() : new Blob([(output.target as BufferTarget).buffer!], { type: mime });
  return {
    blob,
    savedTo: dest.kind === 'stream' ? dest.where : undefined,
    fileName: fileNameFor(project, job),
    warnings: [
      ...(audioGaps ? [`${audioGaps * 30} s de son n’ont pas pu être mixées (silence à la place)`] : []),
      ...(sources.fallbacks.size ? [`${sources.fallbacks.size} média(s) introuvable(s), illisible(s) ou dont le décodage a calé, rendu(s) avec leur vignette`] : []),
    ],
    codec: CODEC_LABEL[vcodec] + (acodec ? ` + ${CODEC_LABEL[acodec]}${abitrate ? ' ' + abitrate / 1000 + ' kbit/s' : ''}` : job.audio ? ' (sans son : aucun encodeur audio)' : ''),
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
