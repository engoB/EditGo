// Moteur d'aperçu temps réel : rendu WebGL, lecture synchronisée vidéo + musique.
import { effect, untracked } from '@preact/signals';
import { Compositor, type SourceFrame } from '../render/compositor';
import { buildFrame, type SourceProvider } from '../render/frame';
import { ImageCache, thumbImage } from '../render/images';
import { sourceTime, stateAt, type Placed } from '../story/timeline';
import type { MediaItem } from '../types';
import { mediaMap, musicBuffer, playhead, playing, project, timeline } from '../state/store';
import { applyMusicEnvelope, duckingSegments } from '../audio/envelope';
import { ASPECTS } from '../presets';
import { DecodedVideo } from './decoded';
import { attachVideo, detachVideo } from '../media/videohost';
import { extractAudio } from '../audio/mix';
import { decoderFailed, lowMemory, useDecoder } from '../media/playback';

class PreviewSources implements SourceProvider {
  images = lowMemory ? new ImageCache(1280, 10) : new ImageCache(1920, 24);
  videos = new Map<string, HTMLVideoElement>();
  decoded = new Map<string, DecodedVideo>();
  onReady: () => void = () => {};
  active = new Set<string>();

  frame(p: Placed, m: MediaItem | undefined, t: number): SourceFrame | null {
    if (!m) return null;
    if (m.kind === 'photo' || p.clip.type === 'title') {
      const d = this.images.get(m.id);
      if (d) return { key: 'i:' + m.id, image: d.image, w: d.w, h: d.h, dynamic: false };
      if (m.kind === 'photo') void this.images.load(m).then(() => this.onReady());
      const th = thumbImage(m);
      return th ? { key: 't:' + m.id, image: th, w: th.naturalWidth, h: th.naturalHeight, dynamic: false } : null;
    }
    if (!m.file) {
      const th0 = thumbImage(m);
      return th0 ? { key: 't:' + m.id, image: th0, w: th0.naturalWidth, h: th0.naturalHeight, dynamic: false } : null;
    }
    const target = sourceTime(p, t);
    if (useDecoder(m)) {
      const dv = this.decodedFor(p, m);
      if (dv.failed && !m.decode) {
        // décodeur indisponible pour ce fichier : lecture par la balise <video>
        decoderFailed(m);
        dv.dispose();
        this.decoded.delete(p.clip.id);
        return this.frame(p, m, t);
      }
      if (playing.value) dv.update(target);
      else dv.seek(target);
      if (dv.shown >= 0) return { key: 'dv:' + p.clip.id, image: dv.canvas, w: dv.canvas.width, h: dv.canvas.height, dynamic: true };
      const thd = thumbImage(m);
      return thd ? { key: 't:' + m.id, image: thd, w: thd.naturalWidth, h: thd.naturalHeight, dynamic: false } : null;
    }
    const v = this.video(p, m);
    this.active.add(p.clip.id);
    if (!playing.value) {
      if (Math.abs(v.currentTime - target) > 0.04 && !v.seeking) v.currentTime = target;
    }
    if (v.readyState >= 2 && v.videoWidth) return { key: 'v:' + p.clip.id, image: v, w: v.videoWidth, h: v.videoHeight, dynamic: true };
    const th = thumbImage(m);
    return th ? { key: 't:' + m.id, image: th, w: th.naturalWidth, h: th.naturalHeight, dynamic: false } : null;
  }

  still(_p: Placed, m: MediaItem): SourceFrame | null {
    const d = this.images.get(m.id);
    if (d) return { key: 'i:' + m.id, image: d.image, w: d.w, h: d.h, dynamic: false };
    void this.images.load(m).then(() => this.onReady());
    const th = thumbImage(m);
    return th ? { key: 't:' + m.id, image: th, w: th.naturalWidth, h: th.naturalHeight, dynamic: false } : null;
  }

  decodedFor(p: Placed, m: MediaItem): DecodedVideo {
    let dv = this.decoded.get(p.clip.id);
    if (!dv) {
      dv = new DecodedVideo(m.file!, () => this.onReady(), lowMemory ? 960 : 1280, !m.decode);
      this.decoded.set(p.clip.id, dv);
    }
    return dv;
  }

  video(p: Placed, m: MediaItem): HTMLVideoElement {
    let v = this.videos.get(p.clip.id);
    if (!v) {
      v = document.createElement('video');
      v.playsInline = true;
      v.preload = 'auto';
      v.muted = true;
      v.crossOrigin = 'anonymous';
      v.src = URL.createObjectURL(m.file!);
      attachVideo(v);
      v.addEventListener('seeked', () => this.onReady());
      v.addEventListener('loadeddata', () => this.onReady());
      // nouvelle image décodée : on redessine (sinon l'aperçu peut rester sur la première image)
      const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback?.bind(v);
      const el = v;
      if (rvfc) {
        const tick = () => {
          this.onReady();
          if (el.isConnected) rvfc(tick);
        };
        rvfc(tick);
      }
      // format refusé par le navigateur : bascule sur le décodage image par image
      v.addEventListener('error', () => {
        m.decode = true;
        this.onReady();
      });
      this.videos.set(p.clip.id, v);
    }
    return v;
  }

  prefetch(placed: Placed[], t: number, media: Map<string, MediaItem>) {
    for (const p of placed) {
      if (p.end < t - 1 || p.start > t + 10) continue;
      const m = p.clip.mediaId ? media.get(p.clip.mediaId) : undefined;
      if (m?.kind === 'photo' && !this.images.has(m.id)) void this.images.load(m).then(() => this.onReady());
      for (const id of p.clip.extra ?? []) {
        const x = media.get(id);
        if (x && !this.images.has(x.id)) void this.images.load(x).then(() => this.onReady());
      }
      if (m?.kind !== 'video' || !m.file || p.clip.type !== 'media' || p.start <= t) continue;
      if (useDecoder(m)) {
        // décodeur : seulement le plan suivant proche (mémoire limitée)
        if (p.start < t + 4 && !playing.value) this.decodedFor(p, m).seek(p.clip.trimIn);
      } else {
        const v = this.video(p, m);
        if (!playing.value && Math.abs(v.currentTime - p.clip.trimIn) > 0.05 && !v.seeking) v.currentTime = p.clip.trimIn;
      }
    }
  }

  /** Libère décodeurs et vidéos des plans éloignés de la tête de lecture (mémoire des téléphones). */
  trim(placed: Placed[], t: number) {
    const before = lowMemory ? 2 : 4,
      after = lowMemory ? 6 : 15;
    const near = new Set(placed.filter((p) => p.end > t - before && p.start < t + after).map((p) => p.clip.id));
    for (const [id, dv] of this.decoded) {
      if (near.has(id)) continue;
      dv.dispose();
      this.decoded.delete(id);
    }
    for (const [id, v] of this.videos) {
      if (near.has(id)) continue;
      detachVideo(v);
      URL.revokeObjectURL(v.src);
      v.removeAttribute('src');
      v.load();
      this.videos.delete(id);
      this.active.delete(id);
    }
  }

  gc(placed: Placed[]) {
    const keep = new Set(placed.map((p) => p.clip.id));
    for (const [id, dv] of this.decoded) {
      if (!keep.has(id)) {
        dv.dispose();
        this.decoded.delete(id);
      }
    }
    for (const [id, v] of this.videos) {
      if (!keep.has(id)) {
        detachVideo(v);
        URL.revokeObjectURL(v.src);
        v.removeAttribute('src');
        this.videos.delete(id);
      }
    }
  }
}

export class Player {
  comp: Compositor;
  private src = new PreviewSources();
  private overlay: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
  private raf = 0;
  private dirty = true;
  private clockStart = 0;
  private tStart = 0;
  private audio: AudioContext | null = null;
  private musicNode: AudioBufferSourceNode | null = null;
  private musicGain: GainNode | null = null;
  private disposers: (() => void)[] = [];
  private box = { w: 640, h: 360 };
  quality = 1;
  private renderMs = 8;

  constructor(readonly canvas: HTMLCanvasElement) {
    (globalThis as { __editgoPlayer?: unknown }).__editgoPlayer = this; // diagnostic
    this.comp = new Compositor(canvas);
    this.comp.maxCached = lowMemory ? 10 : 22;
    const oc = document.createElement('canvas');
    this.overlay = { canvas: oc, ctx: oc.getContext('2d')! };
    this.src.onReady = () => (this.dirty = true);
    this.disposers.push(
      effect(() => {
        void project.value;
        void mediaMap.value;
        void playhead.value;
        this.dirty = true;
      }),
      effect(() => {
        const isPlaying = playing.value;
        // untracked : start() lit la tête de lecture ; sans cela, chaque image relançait la lecture
        untracked(() => (isPlaying ? this.start() : this.stop()));
      }),
      effect(() => {
        this.src.gc(timeline.value.placed);
      }),
    );
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  setBox(w: number, h: number) {
    this.box = { w, h };
    this.dirty = true;
  }

  private outputSize() {
    const a = ASPECTS[project.value.aspect];
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = this.box.w,
      h = (w * a.h) / a.w;
    if (h > this.box.h) {
      h = this.box.h;
      w = (h * a.w) / a.h;
    }
    const k = Math.min(dpr * this.quality, 1920 / Math.max(w, h));
    return { cssW: w, cssH: h, w: Math.round(w * k), h: Math.round(h * k) };
  }

  private start() {
    const { total } = timeline.value;
    if (playhead.value >= total - 0.05) playhead.value = 0;
    this.tStart = playhead.value;
    this.clockStart = performance.now();
    this.startMusic(this.tStart);
    this.syncVideos(this.tStart, true);
  }

  /** Son des vidéos décodées (MTS…) : extrait puis joué via Web Audio. */
  private decAudio = new Map<string, { buf: AudioBuffer | null; key: string }>();
  /** Plans dont la vidéo a dû être lue sans son (le son est alors joué par Web Audio). */
  private forcedMute = new Set<string>();
  private decNodes = new Map<string, { node: AudioBufferSourceNode; gain: GainNode }>();

  private ensureAudio(): AudioContext {
    this.audio ??= new AudioContext({ latencyHint: 'playback' });
    void this.audio.resume();
    return this.audio;
  }

  private loadDecAudio(p: Placed, m: MediaItem) {
    const c = p.clip;
    const key = `${c.trimIn}|${c.duration}|${c.speed}`;
    const cur = this.decAudio.get(c.id);
    if (cur && cur.key === key) return cur.buf;
    this.decAudio.set(c.id, { buf: null, key });
    void extractAudio(m.file!, c.trimIn, Math.min(m.duration, c.trimIn + c.duration * c.speed + 0.1)).then((buf) => {
      const e = this.decAudio.get(c.id);
      if (e && e.key === key) e.buf = buf;
    });
    return null;
  }

  private stopDecAudio(id?: string) {
    for (const [k, n] of this.decNodes) {
      if (id && k !== id) continue;
      try {
        n.node.stop();
      } catch {
        /* déjà arrêté */
      }
      n.node.disconnect();
      this.decNodes.delete(k);
    }
  }

  private stop() {
    this.quality = 1;
    this.stopMusic();
    this.stopDecAudio();
    for (const dv of this.src.decoded.values()) dv.stop();
    for (const v of this.src.videos.values()) {
      v.pause();
      v.muted = true;
    }
    this.dirty = true;
  }

  private startMusic(t: number) {
    this.stopMusic();
    const buf = musicBuffer.value;
    const p = project.value;
    if (!buf || p.music.kind === 'none') return;
    if (!this.audio) this.audio = new AudioContext({ latencyHint: 'playback' });
    void this.audio.resume();
    const ctx = this.audio;
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.loop = buf.duration < timeline.value.total + p.music.offset;
    const gain = ctx.createGain();
    node.connect(gain).connect(ctx.destination);
    const { placed, total } = timeline.value;
    // automation relative au temps du contexte audio
    const startAt = ctx.currentTime + 0.03;
    const param = gain.gain;
    // les automatisations sont exprimées en temps relatif : on les décale de startAt
    const shifted = {
      cancelScheduledValues: (x: number) => param.cancelScheduledValues(x + startAt),
      setValueAtTime: (v: number, x: number) => param.setValueAtTime(v, x + startAt),
      linearRampToValueAtTime: (v: number, x: number) => param.linearRampToValueAtTime(v, x + startAt),
    } as unknown as AudioParam;
    applyMusicEnvelope(shifted, p, total, duckingSegments(placed, mediaMap.value), t);
    const off = (p.music.offset + t) % buf.duration;
    node.start(startAt, off);
    this.musicNode = node;
    this.musicGain = gain;
    this.clockStart = performance.now() + 30;
  }

  private stopMusic() {
    try {
      this.musicNode?.stop();
    } catch {
      /* déjà arrêté */
    }
    this.musicNode?.disconnect();
    this.musicGain?.disconnect();
    this.musicNode = null;
    this.musicGain = null;
  }

  /** Lance / cale les vidéos actives pendant la lecture. */
  private syncVideos(t: number, force = false) {
    const { placed } = timeline.value;
    const st = stateAt(placed, t);
    const activeIds = new Set<string>();
    const media = mediaMap.value;
    for (const p of [st.a, st.b]) {
      if (!p || p.clip.type !== 'media') continue;
      const m = p.clip.mediaId ? media.get(p.clip.mediaId) : undefined;
      if (m?.kind !== 'video' || !m.file) continue;
      activeIds.add(p.clip.id);
      const dec = useDecoder(m);
      if (dec || this.forcedMute.has(p.clip.id)) {
        if (!dec) {
          // vidéo lue sans son (refus du navigateur) : l'image avance, le son passe par Web Audio
          const v = this.src.video(p, m);
          const target = sourceTime(p, t);
          v.muted = true;
          v.playbackRate = p.clip.speed;
          if (force || Math.abs(v.currentTime - target) > 0.3) v.currentTime = target;
          if (v.paused) void v.play().catch(() => null);
        }
        if (!m.hasAudio || p.clip.volume <= 0.01) continue;
        const buf = this.loadDecAudio(p, m);
        if (buf && !this.decNodes.has(p.clip.id)) {
          const ctx = this.ensureAudio();
          const node = ctx.createBufferSource();
          node.buffer = buf;
          node.playbackRate.value = p.clip.speed;
          const gain = ctx.createGain();
          const now = ctx.currentTime;
          const local = t - p.start;
          const fadeEnd = Math.max(0, p.tIn - local);
          gain.gain.setValueAtTime(fadeEnd > 0 ? 0 : p.clip.volume, now);
          if (fadeEnd > 0) gain.gain.linearRampToValueAtTime(p.clip.volume, now + fadeEnd);
          const remain = p.end - t;
          gain.gain.setValueAtTime(p.clip.volume, now + Math.max(0, remain - 0.4));
          gain.gain.linearRampToValueAtTime(0, now + Math.max(0.01, remain));
          node.connect(gain).connect(ctx.destination);
          node.start(now, Math.max(0, local * p.clip.speed));
          node.stop(now + Math.max(0.01, remain));
          this.decNodes.set(p.clip.id, { node, gain });
        }
        continue;
      }
      const v = this.src.video(p, m);
      const target = sourceTime(p, t);
      v.playbackRate = p.clip.speed;
      const fadeIn = Math.min(1, (t - p.start) / Math.max(0.15, p.tIn));
      const fadeOut = Math.min(1, (p.end - t) / 0.4);
      v.volume = Math.max(0, Math.min(1, p.clip.volume * fadeIn * fadeOut));
      v.muted = p.clip.volume <= 0.01 || !m.hasAudio;
      if (force || Math.abs(v.currentTime - target) > 0.3) v.currentTime = target;
      if (v.paused)
        void v.play().catch(() => {
          // lecture avec le son refusée (iPhone hors toucher direct) : on relance sans le son
          this.forcedMute.add(p.clip.id);
          v.muted = true;
          void v.play().catch(() => null);
        });
    }
    for (const [id, v] of this.src.videos) if (!activeIds.has(id) && !v.paused) v.pause();
    for (const id of [...this.decNodes.keys()]) if (!activeIds.has(id)) this.stopDecAudio(id);
    // préchargement du son des prochains plans décodés
    for (const p of placed) {
      if (p.start < t || p.start > t + 6 || p.clip.type !== 'media') continue;
      const m = p.clip.mediaId ? media.get(p.clip.mediaId) : undefined;
      if (m?.kind === 'video' && m.file && useDecoder(m) && m.hasAudio && p.clip.volume > 0.01) this.loadDecAudio(p, m);
    }
  }

  private lastSync = 0;
  private lastTrim = 0;
  /** Sons extraits des plans éloignés : libérés. */
  private trimAudio(placed: Placed[], t: number) {
    const near = new Set(placed.filter((p) => p.end > t - 3 && p.start < t + 10).map((p) => p.clip.id));
    for (const id of [...this.decAudio.keys()]) if (!near.has(id) && !this.decNodes.has(id)) this.decAudio.delete(id);
  }
  private loop() {
    this.raf = requestAnimationFrame(this.loop);
    if (this.comp.lost) return;
    const { placed, total } = timeline.value;
    if (playing.value) {
      const t = this.tStart + Math.max(0, performance.now() - this.clockStart) / 1000;
      if (t >= total) {
        playing.value = false;
        playhead.value = total;
        return;
      }
      playhead.value = t;
      const now = performance.now();
      if (now - this.lastSync > 200) {
        this.lastSync = now;
        this.syncVideos(t);
      }
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const size = this.outputSize();
    this.canvas.style.width = size.cssW + 'px';
    this.canvas.style.height = size.cssH + 'px';
    this.comp.resize(size.w, size.h);
    const t = Math.min(playhead.value, Math.max(0, total - 0.001));
    const media = mediaMap.value;
    this.src.prefetch(placed, t, media);
    if (performance.now() - this.lastTrim > 1000) {
      this.lastTrim = performance.now();
      this.src.trim(placed, t);
      this.trimAudio(placed, t);
    }
    const t0 = performance.now();
    const fd = buildFrame({ project: project.value, media, placed, total, t, W: size.w, H: size.h, provider: this.src, overlay: this.overlay });
    this.comp.render(fd);
    // résolution adaptative pendant la lecture : fluidité d'abord sur les machines modestes
    if (playing.value) {
      const ms = performance.now() - t0;
      this.renderMs = this.renderMs * 0.9 + ms * 0.1;
      if (this.renderMs > 18 && this.quality > 0.5) this.quality = Math.max(0.5, this.quality * 0.85);
      else if (this.renderMs < 7 && this.quality < 1) this.quality = Math.min(1, this.quality * 1.05);
    }
  }

  /** Image courante en PNG (aperçu). */
  snapshot(): Promise<Blob | null> {
    this.dirty = true;
    this.loop();
    return new Promise((r) => this.canvas.toBlob(r, 'image/png'));
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.stopMusic();
    this.stopDecAudio();
    void this.audio?.close();
    this.disposers.forEach((d) => d());
    this.src.gc([]);
    this.src.images.clear();
    this.comp.dispose();
  }
}
