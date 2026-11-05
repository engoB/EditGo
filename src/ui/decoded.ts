// Lecture « décodée » des vidéos que la balise <video> ne sait pas lire (MTS AVCHD, AVI…) :
// images obtenues par WebCodecs via Mediabunny, rendues dans un canvas.
import { FrameReader, type Frame } from '../media/framereader';

type WrappedCanvas = Frame;

export class DecodedVideo {
  readonly canvas = document.createElement('canvas');
  ready = false;
  failed = false;
  /** Horodatage (s) de l'image affichée, -1 si aucune. */
  shown = -1;
  private ctx = this.canvas.getContext('2d')!;
  private sink: FrameReader | null = null;
  private dispose_: (() => void) | null = null;
  private seeking = false;
  private want = -1;
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private iterFrom = 0;
  private pending: WrappedCanvas | null = null;
  private pumping = false;
  private gen = 0;

  constructor(
    file: File,
    private onFrame: () => void,
    maxSide = 1280,
  ) {
    void this.init(file, maxSide);
  }

  private async init(file: File, maxSide: number) {
    try {
      const reader = await FrameReader.open(file, maxSide);
      this.dispose_ = () => reader.dispose();
      this.sink = reader;
      this.ready = true;
      if (this.want >= 0) this.seek(this.want);
    } catch {
      this.failed = true;
    }
  }

  private draw(wc: WrappedCanvas) {
    if (this.canvas.width !== wc.canvas.width || this.canvas.height !== wc.canvas.height) {
      this.canvas.width = wc.canvas.width;
      this.canvas.height = wc.canvas.height;
    }
    this.ctx.drawImage(wc.canvas as CanvasImageSource, 0, 0, this.canvas.width, this.canvas.height);
    this.shown = wc.timestamp;
    this.onFrame();
  }

  /** Affiche l'image à l'instant t (hors lecture). Les demandes rapprochées sont fusionnées. */
  seek(t: number) {
    if (this.iter) this.stop();
    if (Math.abs(t - this.want) < 1e-3 && (this.seeking || Math.abs(this.shown - t) < 0.05)) return;
    this.want = t;
    if (!this.ready || this.seeking) return;
    this.seeking = true;
    void (async () => {
      try {
        for (;;) {
          const target = this.want;
          const wc = await this.sink!.getCanvas(Math.max(0, target));
          if (wc) this.draw(wc);
          if (this.want === target) break;
        }
      } catch {
        /* image indisponible */
      }
      this.seeking = false;
    })();
  }

  /** Lecture continue : à appeler à chaque image d'affichage avec le temps source courant. */
  update(t: number) {
    if (!this.ready) {
      this.want = t;
      return;
    }
    const lagging = this.pending && this.pending.timestamp < t - 0.6;
    if (!this.iter || t < this.iterFrom - 0.05 || lagging || (!this.pending && !this.pumping && this.shown >= 0 && t - this.shown > 1.2)) this.restart(t);
    if (this.pending && this.pending.timestamp <= t) {
      const wc = this.pending;
      this.pending = null;
      this.draw(wc);
      this.pump();
    }
  }

  private restart(t: number) {
    this.stop();
    const g = ++this.gen;
    this.iterFrom = t;
    this.iter = this.sink!.frames(Math.max(0, t));
    void g;
    this.pump();
  }

  private pump() {
    if (this.pumping || !this.iter) return;
    this.pumping = true;
    const g = this.gen;
    const it = this.iter;
    it.next().then(
      (r) => {
        if (g !== this.gen) return;
        this.pumping = false;
        if (r.done) {
          this.iter = null;
          return;
        }
        this.pending = r.value;
        // première image après un redémarrage : affichage immédiat
        if (this.shown < this.iterFrom - 0.1 || this.shown > this.iterFrom + 1) {
          this.pending = null;
          this.draw(r.value);
          this.pump();
        }
      },
      () => {
        if (g === this.gen) this.pumping = false;
      },
    );
  }

  /** Arrête la lecture continue. */
  stop() {
    this.gen++;
    void this.iter?.return?.(undefined);
    this.iter = null;
    this.pending = null;
    this.pumping = false;
  }

  dispose() {
    this.stop();
    this.dispose_?.();
  }
}
