// Compositeur WebGL2 : plans → transition → étalonnage → titres.
import { CLIP_FRAG, OVERLAY_FRAG, POST_FRAG, TRANS_FRAG, VERT } from './shaders';
import type { FitMode, FocusPoint, MotionId, TransitionId } from '../types';
import { clamp, hashStr, lerp } from '../util';
import type { LookParams } from '../presets';

export interface SourceFrame {
  key: string;
  image: TexImageSource;
  w: number;
  h: number;
  dynamic: boolean;
}

export interface CellDraw {
  src: SourceFrame | null;
  win: [number, number];
  center: [number, number];
  rect: [number, number, number, number]; // px, origine en haut à gauche
  radius: number;
  alpha: number;
}

export interface ClipDraw {
  cells?: CellDraw[];
  src: SourceFrame | null;
  mode: number; // voir CLIP_FRAG
  win: [number, number];
  center: [number, number];
  bgWin: [number, number];
  bgCenter: [number, number];
  dim: number;
}

export interface PostParams {
  look: LookParams;
  intensity: number;
  bloom: number;
  vignette: number;
  grain: number;
  letterbox: number;
  globalFade: number;
}

export interface FrameDesc {
  a: ClipDraw;
  b: ClipDraw | null;
  mix: number;
  transition: TransitionId;
  seed: number;
  post: PostParams;
  overlay: TexImageSource | null;
  time: number;
}

const TRANS_INDEX: Record<TransitionId, number> = {
  cut: 0, fade: 1, dipBlack: 2, dipWhite: 3, blur: 4, push: 7, lightLeak: 8, filmBurn: 9, ink: 11,
};
const NEEDS_MIPS = new Set<TransitionId>(['blur']);

interface Prog {
  p: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}
interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
}
interface CachedTex {
  tex: WebGLTexture;
  w: number;
  h: number;
  used: number;
  mips: boolean;
}

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private w = 0;
  private h = 0;
  private clipP: Prog;
  private transP: Prog;
  private postP: Prog;
  private overP: Prog;
  private tA!: Target;
  private tB!: Target;
  private tMix!: Target;
  private cache = new Map<string, CachedTex>();
  private overlayTex: WebGLTexture;
  private frameNo = 0;
  maxCached = 28;
  lost = false;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas, opts: { preserve?: boolean } = {}) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: !!opts.preserve,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 indisponible sur cet appareil');
    this.gl = gl;
    (canvas as HTMLCanvasElement).addEventListener?.('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.clipP = this.program(CLIP_FRAG, ['uTex', 'uMode', 'uWin', 'uCenter', 'uBgWin', 'uBgCenter', 'uBlurLod', 'uDim', 'uRes', 'uRadius', 'uAlpha']);
    this.transP = this.program(TRANS_FRAG, ['uA', 'uB', 'uMix', 'uType', 'uRes', 'uSeed']);
    this.postP = this.program(POST_FRAG, [
      'uSrc', 'uRes', 'uTime', 'uExposure', 'uContrast', 'uSaturation', 'uTemp', 'uTint', 'uFadeBlack', 'uSplit', 'uMono',
      'uIntensity', 'uLift', 'uGain', 'uBloom', 'uVignette', 'uGrain', 'uLetterbox', 'uGlobalFade',
    ]);
    this.overP = this.program(OVERLAY_FRAG, ['uTex']);
    this.overlayTex = this.newTex();
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
  }

  private program(frag: string, uniforms: string[]): Prog {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader : ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Programme : ' + gl.getProgramInfoLog(p));
    const u: Prog['u'] = {};
    for (const n of uniforms) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }

  private newTex(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private target(): Target {
    const gl = this.gl;
    const tex = this.newTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex };
  }

  private freeTarget(t?: Target) {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fb);
    this.gl.deleteTexture(t.tex);
  }

  resize(w: number, h: number) {
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.freeTarget(this.tA);
    this.freeTarget(this.tB);
    this.freeTarget(this.tMix);
    this.tA = this.target();
    this.tB = this.target();
    this.tMix = this.target();
  }

  get size() {
    return { w: this.w, h: this.h };
  }

  private texFor(src: SourceFrame, wantMips: boolean): CachedTex {
    const gl = this.gl;
    let c = this.cache.get(src.key);
    const fresh = !c;
    if (!c) {
      c = { tex: this.newTex(), w: src.w, h: src.h, used: 0, mips: false };
      this.cache.set(src.key, c);
      this.evict();
    }
    gl.bindTexture(gl.TEXTURE_2D, c.tex);
    if (fresh || src.dynamic) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src.image);
      c.w = src.w;
      c.h = src.h;
      c.mips = false;
    }
    if (wantMips && !c.mips) {
      gl.generateMipmap(gl.TEXTURE_2D);
      c.mips = true;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, c.mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    c.used = ++this.frameNo;
    return c;
  }

  private evict() {
    if (this.cache.size <= this.maxCached) return;
    const arr = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < arr.length - this.maxCached; i++) {
      this.gl.deleteTexture(arr[i][1].tex);
      this.cache.delete(arr[i][0]);
    }
  }

  /** Libère les textures qui ne servent plus (export : mémoire graphique maîtrisée). */
  retainOnly(keys: Set<string>) {
    for (const [k, v] of this.cache) {
      if (!keys.has(k)) {
        this.gl.deleteTexture(v.tex);
        this.cache.delete(k);
      }
    }
  }

  drop(keyPrefix: string) {
    for (const [k, v] of this.cache) {
      if (k.startsWith(keyPrefix)) {
        this.gl.deleteTexture(v.tex);
        this.cache.delete(k);
      }
    }
  }

  private drawClip(d: ClipDraw, t: Target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, this.w, this.h);
    const P = this.clipP;
    gl.useProgram(P.p);
    let mode = d.mode;
    if (!d.src && mode !== 5) mode = 4;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (d.src) {
      const needsMips = mode === 1 || mode === 3;
      const tex = this.texFor(d.src, needsMips);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex.tex);
      gl.uniform1i(P.u.uTex, 0);
      // niveau de flou indépendant de la résolution de la source
      const lod = Math.log2(Math.max(tex.w, tex.h) / 22);
      gl.uniform1f(P.u.uBlurLod, clamp(lod, 1, 9));
    }
    gl.uniform1i(P.u.uMode, mode);
    gl.uniform2f(P.u.uWin, d.win[0], d.win[1]);
    gl.uniform2f(P.u.uCenter, d.center[0], d.center[1]);
    gl.uniform2f(P.u.uBgWin, d.bgWin[0], d.bgWin[1]);
    gl.uniform2f(P.u.uBgCenter, d.bgCenter[0], d.bgCenter[1]);
    gl.uniform1f(P.u.uDim, d.dim);
    gl.uniform2f(P.u.uRes, this.w, this.h);
    gl.uniform1f(P.u.uRadius, 0);
    gl.uniform1f(P.u.uAlpha, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (d.cells?.length) this.drawCells(d.cells);
  }

  /** Cases d'une mosaïque, dessinées par-dessus le fond dans leur propre zone. */
  private drawCells(cells: CellDraw[]) {
    const gl = this.gl;
    const P = this.clipP;
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const c of cells) {
      if (!c.src || c.alpha <= 0.001) continue;
      const [x, y, w, h] = c.rect;
      const vx = Math.round(x),
        vy = Math.round(this.h - (y + h)),
        vw = Math.max(1, Math.round(w)),
        vh = Math.max(1, Math.round(h));
      gl.viewport(vx, vy, vw, vh);
      const tex = this.texFor(c.src, false);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex.tex);
      gl.uniform1i(P.u.uTex, 0);
      gl.uniform1i(P.u.uMode, 0);
      gl.uniform2f(P.u.uWin, c.win[0], c.win[1]);
      gl.uniform2f(P.u.uCenter, c.center[0], c.center[1]);
      gl.uniform2f(P.u.uRes, vw, vh);
      gl.uniform1f(P.u.uRadius, c.radius);
      gl.uniform1f(P.u.uAlpha, c.alpha);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, this.w, this.h);
  }

  render(f: FrameDesc) {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) return;
    gl.disable(gl.BLEND);

    this.drawClip(f.a, this.tA);
    let mixed: Target = this.tA;
    if (f.b && f.transition !== 'cut') {
      this.drawClip(f.b, this.tB);
      const mips = NEEDS_MIPS.has(f.transition);
      if (mips) {
        for (const t of [this.tA, this.tB]) {
          gl.bindTexture(gl.TEXTURE_2D, t.tex);
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tMix.fb);
      gl.viewport(0, 0, this.w, this.h);
      const P = this.transP;
      gl.useProgram(P.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tA.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.tB.tex);
      gl.uniform1i(P.u.uA, 0);
      gl.uniform1i(P.u.uB, 1);
      gl.uniform1f(P.u.uMix, f.mix);
      gl.uniform1i(P.u.uType, TRANS_INDEX[f.transition] ?? 1);
      gl.uniform2f(P.u.uRes, this.w, this.h);
      gl.uniform1f(P.u.uSeed, f.seed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (mips) {
        for (const t of [this.tA, this.tB]) {
          gl.bindTexture(gl.TEXTURE_2D, t.tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }
      }
      mixed = this.tMix;
    }

    // Post-traitement vers l'écran
    const bloom = f.post.bloom > 0.001;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mixed.tex);
    if (bloom) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    const P = this.postP;
    gl.useProgram(P.p);
    const L = f.post.look;
    gl.uniform1i(P.u.uSrc, 0);
    gl.uniform2f(P.u.uRes, this.w, this.h);
    gl.uniform1f(P.u.uTime, f.time);
    gl.uniform1f(P.u.uExposure, L.exposure);
    gl.uniform1f(P.u.uContrast, L.contrast);
    gl.uniform1f(P.u.uSaturation, L.saturation);
    gl.uniform1f(P.u.uTemp, L.temperature);
    gl.uniform1f(P.u.uTint, L.tint);
    gl.uniform1f(P.u.uFadeBlack, L.fade);
    gl.uniform1f(P.u.uSplit, L.split);
    gl.uniform1f(P.u.uMono, L.mono);
    gl.uniform3f(P.u.uLift, ...L.lift);
    gl.uniform3f(P.u.uGain, ...L.gain);
    gl.uniform1f(P.u.uIntensity, f.post.intensity);
    gl.uniform1f(P.u.uBloom, f.post.bloom);
    gl.uniform1f(P.u.uVignette, f.post.vignette);
    gl.uniform1f(P.u.uGrain, f.post.grain);
    gl.uniform1f(P.u.uLetterbox, f.post.letterbox);
    gl.uniform1f(P.u.uGlobalFade, f.post.globalFade);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (bloom) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

    // Titres
    if (f.overlay) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const O = this.overP;
      gl.useProgram(O.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f.overlay);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.uniform1i(O.u.uTex, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
    }
  }

  dispose() {
    for (const v of this.cache.values()) this.gl.deleteTexture(v.tex);
    this.cache.clear();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// ---------- Cadrage & mouvement ----------

const AUTO_MOTIONS: MotionId[] = ['zoomIn', 'zoomOut', 'panLeft', 'panRight', 'zoomIn', 'panUp'];

export function resolveMotion(m: MotionId, id: string): MotionId {
  return m === 'auto' ? AUTO_MOTIONS[hashStr(id) % AUTO_MOTIONS.length] : m;
}

export function framing(opts: {
  srcW: number;
  srcH: number;
  outW: number;
  outH: number;
  fit: FitMode;
  motion: MotionId;
  progress: number;
  focus: FocusPoint;
  amp: number;
  id: string;
  titleBg?: boolean;
}): Pick<ClipDraw, 'mode' | 'win' | 'center' | 'bgWin' | 'bgCenter' | 'dim'> {
  const { srcW, srcH, outW, outH } = opts;
  const sa = srcW / Math.max(1, srcH);
  const oa = outW / Math.max(1, outH);
  const p = clamp(opts.progress, 0, 1);
  const e = lerp(p, p * p * (3 - 2 * p), 0.35);
  const motion = resolveMotion(opts.motion, opts.id);
  const A = 0.11 * opts.amp;
  const cover: [number, number] = sa > oa ? [oa / sa, 1] : [1, sa / oa];
  const contain: [number, number] = sa > oa ? [1, sa / oa] : [oa / sa, 1];
  const fx = clamp(opts.focus.x, 0, 1),
    fy = clamp(opts.focus.y, 0, 1);
  // Mode effectif : si l'image a presque le même ratio que la sortie, le fond flou est inutile.
  let fit = opts.fit;
  if (fit === 'blur' && Math.abs(Math.log(sa / oa)) < 0.18) fit = 'cover';

  let scale = 1;
  let cx = 0.5,
    cy = 0.5;
  const base = fit === 'cover' ? cover : contain;
  const panRange = (w: number) => Math.max(0, 1 - w) * 0.5 * 0.85;
  switch (motion) {
    case 'zoomIn':
      scale = 1 + A * e;
      cx = lerp(0.5, fx, e * 0.8);
      cy = lerp(0.5, fy, e * 0.8);
      break;
    case 'zoomOut':
      scale = 1 + A * (1 - e);
      cx = lerp(fx, 0.5, e);
      cy = lerp(fy, 0.5, e);
      break;
    case 'panLeft':
    case 'panRight': {
      scale = 1 + A * 0.75;
      const w = base[0] / scale;
      const r = panRange(w) || A * 0.25;
      const s = motion === 'panRight' ? -1 : 1;
      cx = 0.5 + s * lerp(r, -r, e);
      cy = lerp(0.5, fy, 0.5);
      break;
    }
    case 'panUp':
    case 'panDown': {
      scale = 1 + A * 0.75;
      const h = base[1] / scale;
      const r = panRange(h) || A * 0.25;
      const s = motion === 'panDown' ? -1 : 1;
      cy = 0.5 + s * lerp(r, -r, e);
      cx = lerp(0.5, fx, 0.5);
      break;
    }
    default:
      break;
  }
  if (fit !== 'cover') scale = 1 + (scale - 1) * 0.5;
  const win: [number, number] = [base[0] / scale, base[1] / scale];
  const clampC = (c: number, w: number) => (w >= 1 ? 0.5 : clamp(c, w / 2, 1 - w / 2));
  const center: [number, number] = [clampC(cx, win[0]), clampC(cy, win[1])];
  const bgScale = 1.08 + 0.04 * e;
  const bgWin: [number, number] = [cover[0] / bgScale, cover[1] / bgScale];
  const bgCenter: [number, number] = [0.5, 0.5];
  if (opts.titleBg) return { mode: 3, win, center, bgWin, bgCenter, dim: 0.5 };
  return { mode: fit === 'cover' ? 0 : fit === 'blur' ? 1 : 2, win, center, bgWin, bgCenter, dim: 1 };
}
