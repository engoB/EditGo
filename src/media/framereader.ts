// Lecture d'images vidéo par WebCodecs, sans dépendre des dimensions annoncées par le conteneur
// (contourne la lecture erronée des vidéos entrelacées 1080i des caméscopes AVCHD).
// Les temps exposés sont relatifs au début de la vidéo (0 = première image).
import type { EncodedPacket, EncodedPacketSink, Input } from 'mediabunny';
import { lazy } from '../lazy';

export interface Frame {
  canvas: HTMLCanvasElement;
  timestamp: number; // s, relatif
  duration: number;
}

export class FrameReader {
  width = 0;
  height = 0;
  duration = 0;
  offset = 0;
  /** Rotation à appliquer (vidéos d'iPhone tournées en portrait : 90°). */
  rotation = 0;
  private pool: HTMLCanvasElement[] = [];
  private poolIdx = 0;

  private constructor(
    private input: Input,
    private sink: EncodedPacketSink,
    private config: VideoDecoderConfig,
    private maxSide: number,
  ) {}

  /** `containerFirst` : essayer d'abord la configuration du conteneur (celle de l'export). */
  static async open(file: File, maxSide = 1280, containerFirst = false): Promise<FrameReader> {
    const mb = await lazy(() => import('mediabunny'));
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error('Aucune piste vidéo');
    const cfg = await vt.getDecoderConfig();
    if (!cfg) throw new Error('Codec vidéo inconnu');
    // dimensions laissées au décodeur : il les lit lui-même dans le flux
    // (Safari exige parfois les dimensions ou refuse l'espace colorimétrique : essais successifs)
    const base: VideoDecoderConfig = { codec: cfg.codec, description: cfg.description, optimizeForLatency: false };
    const tries: VideoDecoderConfig[] = [
      { ...base, colorSpace: cfg.colorSpace },
      base,
      { ...base, codedWidth: cfg.codedWidth ?? vt.codedWidth, codedHeight: cfg.codedHeight ?? vt.codedHeight },
      cfg,
    ];
    if (containerFirst) tries.unshift(cfg);
    let config: VideoDecoderConfig | null = null;
    for (const c of tries) {
      const sup = await VideoDecoder.isConfigSupported(c).catch(() => null);
      if (sup?.supported) {
        config = c;
        break;
      }
    }
    if (!config) throw new Error('Codec vidéo non pris en charge par ce navigateur');
    const r = new FrameReader(input, new mb.EncodedPacketSink(vt), config, maxSide);
    r.rotation = ((vt.rotation ?? 0) % 360 + 360) % 360;
    r.offset = await vt.getFirstTimestamp();
    r.duration = Math.max(0, (await vt.computeDuration()) - r.offset);
    // dimensions réelles : première image décodée
    const first = await r.getCanvas(0);
    if (!first) throw new Error('Aucune image décodable');
    return r;
  }

  private canvasFor(w: number, h: number): HTMLCanvasElement {
    if (!this.pool.length) for (let i = 0; i < 3; i++) this.pool.push(document.createElement('canvas'));
    const c = this.pool[this.poolIdx++ % this.pool.length];
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return c;
  }

  private toFrame(vf: VideoFrame): Frame {
    const rot = this.rotation;
    const side = rot === 90 || rot === 270;
    const dw = side ? vf.displayHeight : vf.displayWidth,
      dh = side ? vf.displayWidth : vf.displayHeight;
    const s = Math.min(1, this.maxSide / Math.max(dw, dh));
    const w = Math.max(2, Math.round(dw * s)),
      h = Math.max(2, Math.round(dh * s));
    this.width = dw;
    this.height = dh;
    const c = this.canvasFor(w, h);
    const g = c.getContext('2d')!;
    if (rot) {
      // image codée « couchée » : on la redresse selon la rotation du conteneur
      g.save();
      g.translate(w / 2, h / 2);
      g.rotate((rot * Math.PI) / 180);
      const iw = side ? h : w,
        ih = side ? w : h;
      g.drawImage(vf, -iw / 2, -ih / 2, iw, ih);
      g.restore();
    } else g.drawImage(vf, 0, 0, w, h);
    const f = { canvas: c, timestamp: vf.timestamp / 1e6 - this.offset, duration: (vf.duration ?? 40000) / 1e6 };
    vf.close();
    return f;
  }

  /** Images successives à partir de l'instant `start` (relatif), en ordre de présentation. */
  /** `want` : instant (relatif) voulu à l'écran ; les images en retard sont jetées sans être dessinées. */
  async *frames(start = 0, want?: () => number): AsyncGenerator<Frame, void, unknown> {
    const abs = start + this.offset;
    const key: EncodedPacket | null = (await this.sink.getKeyPacket(abs, { verifyKeyPackets: true })) ?? (await this.sink.getFirstKeyPacket());
    if (!key) return;
    const queue: VideoFrame[] = [];
    let error: Error | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const dec = new VideoDecoder({
      output: (vf) => {
        queue.push(vf);
        notify();
      },
      error: (e) => {
        error = e as Error;
        notify();
      },
    });
    dec.configure(this.config);
    const it = this.sink.packets(key);
    let ended = false;
    const feed = async () => {
      for await (const pk of it) {
        if (dec.state === 'closed') return;
        dec.decode(pk.toEncodedVideoChunk());
        // contre-pression : on ne décode pas trop loin devant la lecture
        while (dec.decodeQueueSize > 6 || queue.length > 6) await new Promise<void>((r) => setTimeout(r, 4));
      }
      if (dec.state !== 'closed') await dec.flush().catch(() => null);
      ended = true;
      notify();
    };
    const feeding = feed().catch((e) => {
      error = e;
      ended = true;
      notify();
    });
    try {
      for (;;) {
        if (queue.length) {
          queue.sort((a, b) => a.timestamp - b.timestamp);
          const vf = queue.shift()!;
          // images antérieures au point demandé (ou déjà en retard sur la lecture) : décodées mais pas rendues
          const limit = want ? Math.max(abs, want() + this.offset) : abs;
          if (vf.timestamp / 1e6 + (vf.duration ?? 40000) / 1e6 <= limit + 1e-4 && (queue.length || !ended)) {
            vf.close();
            continue;
          }
          yield this.toFrame(vf);
          continue;
        }
        if (error) throw error;
        if (ended) break;
        await new Promise<void>((r) => (wake = r));
      }
    } finally {
      for (const vf of queue) vf.close();
      if (dec.state !== 'closed') dec.close();
      void it.return?.(undefined);
      void feeding;
    }
  }

  /** Image affichée à l'instant t (relatif). */
  async getCanvas(t: number): Promise<Frame | null> {
    const g = this.frames(Math.max(0, t));
    try {
      const r = await g.next();
      return r.done ? null : r.value;
    } finally {
      void g.return(undefined);
    }
  }

  /** Une image par horodatage (croissants), pour l'export. */
  async *atTimestamps(ts: number[]): AsyncGenerator<Frame | null, void, unknown> {
    if (!ts.length) return;
    let want = ts[0];
    // les images qui ne couvrent pas l'instant voulu sont jetées sans être dessinées
    const g = this.frames(Math.max(0, ts[0]), () => want - 1e-3);
    let cur: Frame | null = null;
    let next: Frame | null = null;
    let done = false;
    const pull = async () => {
      if (done) return null;
      const r = await g.next();
      if (r.done) {
        done = true;
        return null;
      }
      return r.value;
    };
    try {
      next = await pull();
      for (const t of ts) {
        want = t;
        while (next && next.timestamp <= t + 1e-4) {
          cur = next;
          next = await pull();
        }
        yield cur ?? next;
      }
    } finally {
      void g.return(undefined);
    }
  }

  dispose() {
    this.input.dispose?.();
  }
}
