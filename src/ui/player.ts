// Moteur d'aperçu temps réel : rendu WebGL, lecture synchronisée vidéo + musique.
import { effect } from '@preact/signals';
import { Compositor, type SourceFrame } from '../render/compositor';
import { buildFrame, type SourceProvider } from '../render/frame';
import { ImageCache, thumbImage } from '../render/images';
import { sourceTime, stateAt, type Placed } from '../story/timeline';
import type { MediaItem } from '../types';
import { mediaMap, musicBuffer, playhead, playing, project, timeline } from '../state/store';
import { applyMusicEnvelope, duckingSegments } from '../audio/envelope';
import { ASPECTS } from '../presets';

class PreviewSources implements SourceProvider {
  images = new ImageCache(1920, 18);
  videos = new Map<string, HTMLVideoElement>();
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
    const v = this.video(p, m);
    this.active.add(p.clip.id);
    const target = sourceTime(p, t);
    if (!playing.value) {
      if (Math.abs(v.currentTime - target) > 0.04 && !v.seeking) v.currentTime = target;
    }
    if (v.readyState >= 2 && v.videoWidth) return { key: 'v:' + p.clip.id, image: v, w: v.videoWidth, h: v.videoHeight, dynamic: true };
    const th = thumbImage(m);
    return th ? { key: 't:' + m.id, image: th, w: th.naturalWidth, h: th.naturalHeight, dynamic: false } : null;
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
      v.addEventListener('seeked', () => this.onReady());
      v.addEventListener('loadeddata', () => this.onReady());
      this.videos.set(p.clip.id, v);
    }
    return v;
  }

  prefetch(placed: Placed[], t: number, media: Map<string, MediaItem>) {
    for (const p of placed) {
      if (p.end < t - 1 || p.start > t + 10) continue;
      const m = p.clip.mediaId ? media.get(p.clip.mediaId) : undefined;
      if (m?.kind === 'photo' && !this.images.has(m.id)) void this.images.load(m).then(() => this.onReady());
      if (m?.kind === 'video' && m.file && p.clip.type === 'media' && p.start > t) {
        const v = this.video(p, m);
        if (!playing.value && Math.abs(v.currentTime - p.clip.trimIn) > 0.05 && !v.seeking) v.currentTime = p.clip.trimIn;
      }
    }
  }

  gc(placed: Placed[]) {
    const keep = new Set(placed.map((p) => p.clip.id));
    for (const [id, v] of this.videos) {
      if (!keep.has(id)) {
        v.pause();
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

  constructor(readonly canvas: HTMLCanvasElement) {
    this.comp = new Compositor(canvas);
    this.comp.maxCached = 22;
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
        if (isPlaying) this.start();
        else this.stop();
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

  private stop() {
    this.stopMusic();
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
      const v = this.src.video(p, m);
      const target = sourceTime(p, t);
      v.playbackRate = p.clip.speed;
      const fadeIn = Math.min(1, (t - p.start) / Math.max(0.15, p.tIn));
      const fadeOut = Math.min(1, (p.end - t) / 0.4);
      v.volume = Math.max(0, Math.min(1, p.clip.volume * fadeIn * fadeOut));
      v.muted = p.clip.volume <= 0.01 || !m.hasAudio;
      if (force || Math.abs(v.currentTime - target) > 0.3) v.currentTime = target;
      if (v.paused) void v.play().catch(() => null);
    }
    for (const [id, v] of this.src.videos) if (!activeIds.has(id) && !v.paused) v.pause();
  }

  private lastSync = 0;
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
    const fd = buildFrame({ project: project.value, media, placed, total, t, W: size.w, H: size.h, provider: this.src, overlay: this.overlay });
    this.comp.render(fd);
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
    void this.audio?.close();
    this.disposers.forEach((d) => d());
    this.src.gc([]);
    this.src.images.clear();
    this.comp.dispose();
  }
}
