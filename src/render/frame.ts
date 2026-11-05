// Construit la description d'une image du film à l'instant t.
import type { Clip, MediaItem, Project } from '../types';
import type { CellDraw, ClipDraw, FrameDesc, SourceFrame } from './compositor';
import { bestCollage } from '../story/collage';
import { framing } from './compositor';
import { LOOKS, THEMES } from '../presets';
import { stateAt, type Placed } from '../story/timeline';
import { drawTitle } from './titles';
import { clamp, hashStr } from '../util';

export interface SourceProvider {
  frame(p: Placed, media: MediaItem | undefined, t: number): SourceFrame | null;
  /** Photo supplémentaire d'une mosaïque. */
  still(p: Placed, media: MediaItem): SourceFrame | null;
}

/** Médias d'un plan (1 à 4). */
export function clipMedia(c: Clip, media: Map<string, MediaItem>): MediaItem[] {
  const ids = [c.mediaId, ...(c.extra ?? [])].filter(Boolean) as string[];
  return ids.map((id) => media.get(id)).filter((m): m is MediaItem => !!m);
}

/** Description d'une mosaïque : fond flouté + cases animées. */
function collageDraw(p: Placed, items: MediaItem[], t: number, W: number, fullH: number, bar: number, provider: SourceProvider, primary: SourceFrame | null, amp: number): ClipDraw {
  // zone visible : entre les bandes cinéma éventuelles
  const top = Math.round(bar * fullH);
  const H = fullH - top * 2;
  const c = p.clip;
  const aspects = items.map((m) => m.width / Math.max(1, m.height));
  const lay = bestCollage(aspects, W / H, c.layout);
  const S = Math.min(W, H);
  const gap = Math.round(S * 0.014);
  const local = t - p.start;
  const progress = local / Math.max(0.001, c.duration);
  const cells: CellDraw[] = lay.rects.map((r, i) => {
    const m = items[lay.order[i]];
    const src = lay.order[i] === 0 ? primary : provider.still(p, m);
    const x = gap + r[0] * (W - gap),
      y = top + gap + r[1] * (H - gap),
      w = r[2] * (W - gap) - gap,
      h = r[3] * (H - gap) - gap;
    // apparition décalée de chaque case, légère montée
    const delay = p.tIn * 0.35 + i * 0.16;
    const k = Math.min(1, Math.max(0, (local - delay) / 0.5));
    const e = 1 - Math.pow(1 - k, 3);
    const f = src
      ? framing({ srcW: src.w, srcH: src.h, outW: w, outH: h, fit: 'cover', motion: i % 2 ? 'zoomOut' : 'zoomIn', progress, focus: m.focus, amp: amp * 0.55, id: c.id + i })
      : { win: [1, 1] as [number, number], center: [0.5, 0.5] as [number, number] };
    return { src, win: f.win, center: f.center, rect: [x, y + (1 - e) * S * 0.03, w, h], radius: S * 0.012, alpha: e };
  });
  const bg = primary
    ? framing({ srcW: primary.w, srcH: primary.h, outW: W, outH: fullH, fit: 'cover', motion: 'none', progress, focus: items[0].focus, amp, id: c.id, titleBg: true })
    : null;
  return {
    cells,
    src: primary,
    mode: primary ? 3 : 5,
    win: bg?.win ?? [1, 1],
    center: bg?.center ?? [0.5, 0.5],
    bgWin: bg?.bgWin ?? [1, 1],
    bgCenter: bg?.bgCenter ?? [0.5, 0.5],
    dim: 0.32,
  };
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
    if (p.clip.type === 'media' && p.clip.extra?.length) {
      const items = clipMedia(p.clip, media);
      if (items.length > 1) return collageDraw(p, items, t, W, H, letterboxBar(project, W, H), provider, src, theme.motion);
    }
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
