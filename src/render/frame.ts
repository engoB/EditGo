// Construit la description d'une image du film à l'instant t.
import type { Clip, MediaItem, Project } from '../types';
import type { ClipDraw, FrameDesc, SourceFrame } from './compositor';
import { framing } from './compositor';
import { LOOKS, THEMES } from '../presets';
import { stateAt, type Placed } from '../story/timeline';
import { drawTitle } from './titles';
import { clamp, hashStr } from '../util';

export interface SourceProvider {
  frame(p: Placed, media: MediaItem | undefined, t: number): SourceFrame | null;
}

export function letterboxBar(project: Project, W: number, H: number): number {
  if (!project.letterbox || W / H < 1.3) return 0;
  return Math.max(0, (1 - 1 / 2.39 / (H / W)) * 0.5);
}

function clipDraw(p: Placed, media: MediaItem | undefined, t: number, W: number, H: number, src: SourceFrame | null, amp: number): ClipDraw {
  const c: Clip = p.clip;
  const progress = (t - p.start) / Math.max(0.001, c.duration);
  if (c.type === 'title') {
    if (c.background === 'black' || !src) return { src: null, mode: 4, win: [1, 1], center: [0.5, 0.5], bgWin: [1, 1], bgCenter: [0.5, 0.5], dim: 1 };
    if (c.background === 'gradient') return { src: null, mode: 5, win: [1, 1], center: [0.5, 0.5], bgWin: [1, 1], bgCenter: [0.5, 0.5], dim: 1 };
  }
  if (!src) return { src: null, mode: 4, win: [1, 1], center: [0.5, 0.5], bgWin: [1, 1], bgCenter: [0.5, 0.5], dim: 1 };
  const f = framing({
    srcW: src.w,
    srcH: src.h,
    outW: W,
    outH: H,
    fit: c.fit,
    motion: media?.kind === 'video' && c.motion === 'auto' ? 'none' : c.motion,
    progress,
    focus: media?.kind === 'video' ? { x: 0.5, y: 0.5 } : (media?.focus ?? { x: 0.5, y: 0.5 }),
    amp,
    id: c.id,
    titleBg: c.type === 'title',
  });
  return { src, ...f };
}

export function buildFrame(opts: {
  project: Project;
  media: Map<string, MediaItem>;
  placed: Placed[];
  total: number;
  t: number;
  W: number;
  H: number;
  provider: SourceProvider;
  overlay: { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D };
}): FrameDesc {
  const { project, media, placed, total, t, W, H, provider, overlay } = opts;
  const theme = THEMES[project.theme];
  const st = stateAt(placed, t);
  const mk = (p: Placed | null): ClipDraw => {
    if (!p) return { src: null, mode: 4, win: [1, 1], center: [0.5, 0.5], bgWin: [1, 1], bgCenter: [0.5, 0.5], dim: 1 };
    const m = p.clip.mediaId ? media.get(p.clip.mediaId) : undefined;
    const needsSrc = !(p.clip.type === 'title' && p.clip.background !== 'blur');
    const src = needsSrc ? provider.frame(p, m, t) : null;
    return clipDraw(p, m, t, W, H, src, theme.motion);
  };
  const a = mk(st.a);
  const b = st.b ? mk(st.b) : null;

  // Titres
  let hasOverlay = false;
  const bar = letterboxBar(project, W, H);
  if (overlay.canvas.width !== W || overlay.canvas.height !== H) {
    overlay.canvas.width = W;
    overlay.canvas.height = H;
  }
  for (const p of [st.a, st.b]) {
    if (!p?.clip.title || !p.clip.title.text) continue;
    // le titre démarre à mi-transition d'entrée, pour ne pas se superposer au plan sortant
    const delay = p.tIn * 0.5;
    const local = t - p.start - delay;
    const dur = p.clip.duration - delay;
    if (local < 0 || local > dur) continue;
    if (!hasOverlay) overlay.ctx.clearRect(0, 0, W, H);
    hasOverlay = true;
    drawTitle(overlay.ctx, W, H, p.clip.title, local, dur, { barFraction: bar });
  }

  const fadeIn = clamp(t / 0.8, 0, 1);
  const fadeOut = clamp((total - t) / 1.0, 0, 1);
  const look = LOOKS[project.look].params;
  return {
    a,
    b,
    mix: st.mix,
    transition: st.b ? st.b.clip.transition : 'cut',
    seed: st.b ? (hashStr(st.b.clip.id) % 1000) / 37 : 0,
    post: {
      look,
      intensity: project.lookIntensity,
      bloom: project.bloom,
      vignette: project.vignette,
      grain: project.grain,
      letterbox: bar > 0 ? 1 : 0,
      globalFade: Math.min(fadeIn * fadeIn * (3 - 2 * fadeIn), fadeOut * fadeOut * (3 - 2 * fadeOut)),
    },
    overlay: hasOverlay ? (overlay.canvas as TexImageSource) : null,
    time: t,
  };
}
