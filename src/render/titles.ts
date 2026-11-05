// Titrage animé dessiné en Canvas 2D (puis composé en WebGL).
import type { TitleSpec } from '../types';
import { TITLE_STYLES, type TitleStyle } from '../presets';
import { clamp, easeOut } from '../util';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const fontStr = (s: TitleStyle, px: number, sub = false) =>
  sub
    ? `${s.subWeight} ${px}px "${s.subFont}", "Inter Variable", system-ui, sans-serif`
    : `${s.italic ? 'italic ' : ''}${s.weight} ${px}px "${s.font}", Georgia, serif`;

function measure(ctx: Ctx, text: string, tracking: number) {
  let w = 0;
  const widths: number[] = [];
  for (const ch of text) {
    const cw = ctx.measureText(ch).width;
    widths.push(cw);
    w += cw;
  }
  return { w: w + tracking * Math.max(0, widths.length - 1), widths };
}

/** Dessine un texte avec interlettrage et animation par caractère. */
function drawTracked(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: 'center' | 'left',
  perChar?: (i: number, n: number) => { a: number; dy: number },
) {
  const chars = [...text];
  if (!perChar && Math.abs(tracking) < 0.01) {
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
    return ctx.measureText(text).width;
  }
  const { w, widths } = measure(ctx, text, tracking);
  let cx = align === 'center' ? x - w / 2 : x;
  ctx.textAlign = 'left';
  const base = ctx.globalAlpha;
  chars.forEach((ch, i) => {
    const st = perChar ? perChar(i, chars.length) : { a: 1, dy: 0 };
    if (st.a > 0.001) {
      ctx.globalAlpha = base * st.a;
      ctx.fillText(ch, cx, y + st.dy);
    }
    cx += widths[i] + tracking;
  });
  ctx.globalAlpha = base;
  return w;
}

export interface TitleDrawOpts {
  barFraction: number; // hauteur des bandes cinéma (0..0.5)
}

export function drawTitle(ctx: Ctx, W: number, H: number, spec: TitleSpec, local: number, duration: number, opts: TitleDrawOpts) {
  const s = TITLE_STYLES[spec.style];
  const unit = Math.min(H, W * 0.92);
  const inT = clamp(local / 1.0, 0, 1);
  const outT = clamp((duration - local) / 0.7, 0, 1);
  const fadeOut = easeOut(outT);
  const text = s.upper ? spec.text.toLocaleUpperCase('fr-FR') : spec.text;
  const sub = s.subUpper ? spec.sub.toLocaleUpperCase('fr-FR') : spec.sub;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  const shadow = (k = 1) => {
    ctx.shadowColor = `rgba(0,0,0,${0.5 * k})`;
    ctx.shadowBlur = unit * 0.025;
    ctx.shadowOffsetY = unit * 0.003;
  };

  if (spec.style === 'chapter' || (spec.position === 'lower' && spec.style !== 'bold')) {
    // Tiers inférieur : voile dégradé + étiquette + filet
    const margin = W * 0.07;
    const baseY = H * (1 - Math.max(0.1, opts.barFraction + 0.06));
    const scrimA = 0.5 * easeOut(inT) * fadeOut;
    const g = ctx.createLinearGradient(0, H * 0.55, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${scrimA})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.55, W, H * 0.45);
    ctx.fillStyle = '#fff';
    const isChapter = spec.style === 'chapter';
    let px = isChapter ? unit * 0.034 : unit * s.size * 0.42;
    ctx.font = isChapter ? fontStr(s, px) : fontStr(s, px);
    const tr = (isChapter ? s.tracking : s.tracking) * px;
    let tw = measure(ctx, text, tr).w;
    if (tw > W - margin * 2) {
      px *= (W - margin * 2) / tw;
      ctx.font = fontStr(s, px);
      tw = measure(ctx, text, s.tracking * px).w;
    }
    shadow(0.8);
    ctx.globalAlpha = fadeOut;
    const lineW = Math.min(W * 0.18, unit * 0.16) * easeOut(clamp((local - 0.1) / 0.9, 0, 1));
    ctx.fillRect(margin, baseY - px * 1.55, lineW, Math.max(1, unit * 0.0022));
    drawTracked(ctx, text, margin, baseY, s.tracking * px, 'left', (i) => {
      const k = easeOut(clamp((local - 0.15 - i * 0.025) / 0.55, 0, 1));
      return { a: k, dy: (1 - k) * px * 0.35 };
    });
    if (sub) {
      const spx = unit * 0.03;
      ctx.font = fontStr(s, spx, true);
      ctx.globalAlpha = fadeOut * easeOut(clamp((local - 0.5) / 0.7, 0, 1));
      drawTracked(ctx, sub, margin, baseY + spx * 1.6, s.subTracking * spx, 'left');
    }
    ctx.restore();
    return;
  }

  const cy = spec.position === 'top' ? H * (0.2 + opts.barFraction) : spec.position === 'lower' ? H * 0.78 : H * 0.5;
  let px = unit * s.size;
  ctx.font = fontStr(s, px);
  let tw = measure(ctx, text, s.tracking * px).w;
  const maxW = W * 0.84;
  if (tw > maxW) {
    px *= maxW / tw;
    ctx.font = fontStr(s, px);
    tw = measure(ctx, text, s.tracking * px).w;
  }
  const spx = Math.max(unit * 0.022, px * (spec.style === 'bold' ? 0.2 : 0.2));
  const hasSub = !!sub;
  const titleY = hasSub ? cy + px * 0.12 : cy + px * 0.33;
  const subY = titleY + px * 0.42 + spx * 1.5;
  shadow();

  switch (spec.style) {
    case 'cinema': {
      // interlettrage qui se resserre + léger poussé sur toute la durée
      const k = easeOut(inT);
      const push = 1 + 0.035 * clamp(local / duration, 0, 1);
      ctx.translate(W / 2, cy);
      ctx.scale(push, push);
      ctx.translate(-W / 2, -cy);
      ctx.globalAlpha = k * fadeOut;
      const track = (s.tracking + (1 - k) * 0.12) * px;
      drawTracked(ctx, text, W / 2, titleY - (1 - k) * px * 0.08, track, 'center');
      break;
    }
    case 'bold': {
      // révélation par masque + effet « punch »
      const k = easeOut(clamp(inT * 1.4, 0, 1));
      const sc = 1.18 - 0.18 * k;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, titleY - px * 0.95, W, px * 1.05 * k + 1);
      ctx.clip();
      ctx.translate(W / 2, titleY);
      ctx.scale(sc, sc);
      ctx.globalAlpha = fadeOut;
      drawTracked(ctx, text, 0, 0, s.tracking * px, 'center');
      ctx.restore();
      break;
    }
    case 'minimal': {
      const k = easeOut(inT);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, titleY - px * 1.1, W, px * 1.35);
      ctx.clip();
      ctx.globalAlpha = fadeOut;
      drawTracked(ctx, text, W / 2, titleY + (1 - k) * px * 1.1, s.tracking * px, 'center');
      ctx.restore();
      break;
    }
    default: {
      // élégant / manuscrit : apparition lettre à lettre
      ctx.globalAlpha = fadeOut;
      const n = [...text].length;
      const stagger = Math.min(0.05, 0.9 / Math.max(1, n));
      drawTracked(ctx, text, W / 2, titleY, s.tracking * px, 'center', (i) => {
        const k = easeOut(clamp((local - i * stagger) / 0.7, 0, 1));
        return { a: k, dy: (1 - k) * px * 0.12 };
      });
    }
  }

  if (s.line) {
    const k = easeOut(clamp((local - 0.3) / 1.0, 0, 1));
    const lw = Math.min(tw * 0.5, unit * 0.22) * k;
    ctx.globalAlpha = 0.85 * fadeOut;
    ctx.shadowBlur = 0;
    ctx.fillRect(W / 2 - lw / 2, titleY + px * 0.22, lw, Math.max(1, unit * 0.0022));
    shadow();
  }
  if (hasSub) {
    ctx.font = fontStr(s, spx, true);
    const k = easeOut(clamp((local - 0.45) / 0.8, 0, 1));
    ctx.globalAlpha = k * fadeOut * 0.92;
    drawTracked(ctx, sub, W / 2, subY + (1 - k) * spx * 0.6, s.subTracking * spx, 'center');
  }
  ctx.restore();
}

export const TITLE_FONTS = [
  '600 40px "Playfair Display Variable"',
  'italic 500 40px "Cormorant Garamond Variable"',
  '600 40px "Cormorant Garamond Variable"',
  '400 40px "Bebas Neue"',
  '400 40px "Great Vibes"',
  '600 40px "Montserrat Variable"',
  '300 40px "Inter Variable"',
  '500 40px "Inter Variable"',
];

export async function loadTitleFonts() {
  if (!document.fonts) return;
  await Promise.all(TITLE_FONTS.map((f) => document.fonts.load(f, 'AÉaé').catch(() => null)));
}
