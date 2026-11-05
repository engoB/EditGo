import type { AspectId, LookId, MusicMood, ThemeId, TitleStyleId, TransitionId } from './types';

export const TRANSITIONS: { id: TransitionId; label: string }[] = [
  { id: 'fade', label: 'Fondu enchaîné' },
  { id: 'dipBlack', label: 'Fondu au noir' },
  { id: 'dipWhite', label: 'Flash blanc' },
  { id: 'blur', label: 'Flou dissolvant' },
  { id: 'zoom', label: 'Zoom cinétique' },
  { id: 'whip', label: 'Filé (whip pan)' },
  { id: 'push', label: 'Poussée' },
  { id: 'lightLeak', label: 'Fuite de lumière' },
  { id: 'filmBurn', label: 'Brûlure de pellicule' },
  { id: 'iris', label: 'Iris' },
  { id: 'ink', label: 'Encre' },
  { id: 'cut', label: 'Coupe franche' },
];

export interface LookParams {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number; // -1..1
  tint: number;
  lift: [number, number, number];
  gain: [number, number, number];
  fade: number; // noirs laiteux
  split: number; // teal & orange
  mono: number; // 0..1
}

const base: LookParams = {
  exposure: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
  lift: [0, 0, 0],
  gain: [1, 1, 1],
  fade: 0,
  split: 0,
  mono: 0,
};

export const LOOKS: Record<LookId, { label: string; params: LookParams; swatch: string }> = {
  natural: { label: 'Naturel', swatch: 'linear-gradient(135deg,#7aa6c9,#e2c08d)', params: { ...base, contrast: 1.04, saturation: 1.05 } },
  cinema: {
    label: 'Cinéma',
    swatch: 'linear-gradient(135deg,#0f4c5c,#e36414)',
    params: { ...base, contrast: 1.12, saturation: 0.92, split: 0.55, lift: [-0.01, 0.005, 0.02], gain: [1.03, 1, 0.96], fade: 0.02 },
  },
  golden: {
    label: 'Heure dorée',
    swatch: 'linear-gradient(135deg,#f6bd60,#c8553d)',
    params: { ...base, exposure: 0.04, contrast: 1.06, saturation: 1.08, temperature: 0.45, tint: 0.05, gain: [1.05, 1.0, 0.9], fade: 0.03 },
  },
  film: {
    label: 'Argentique',
    swatch: 'linear-gradient(135deg,#a3b18a,#dda15e)',
    params: { ...base, contrast: 0.96, saturation: 0.86, temperature: 0.18, lift: [0.03, 0.025, 0.04], gain: [1.02, 0.99, 0.93], fade: 0.09, split: 0.2 },
  },
  nordic: {
    label: 'Nordique',
    swatch: 'linear-gradient(135deg,#8ecae6,#d9e2ec)',
    params: { ...base, exposure: 0.03, contrast: 1.02, saturation: 0.78, temperature: -0.35, lift: [0.01, 0.02, 0.035], fade: 0.05 },
  },
  mono: {
    label: 'Noir & blanc',
    swatch: 'linear-gradient(135deg,#111,#eee)',
    params: { ...base, contrast: 1.22, saturation: 0, mono: 1, fade: 0.02 },
  },
  dream: {
    label: 'Rêverie',
    swatch: 'linear-gradient(135deg,#ffc8dd,#bde0fe)',
    params: { ...base, exposure: 0.06, contrast: 0.9, saturation: 0.95, temperature: 0.1, tint: 0.08, lift: [0.04, 0.03, 0.05], fade: 0.1 },
  },
  vivid: {
    label: 'Éclatant',
    swatch: 'linear-gradient(135deg,#ff006e,#3a86ff)',
    params: { ...base, contrast: 1.14, saturation: 1.3, gain: [1.02, 1.02, 1.0] },
  },
};

export interface TitleStyle {
  label: string;
  font: string;
  weight: number;
  italic: boolean;
  upper: boolean;
  tracking: number; // em
  size: number; // fraction de la hauteur
  subFont: string;
  subWeight: number;
  subUpper: boolean;
  subTracking: number;
  line: boolean; // filet décoratif
}

export const TITLE_STYLES: Record<TitleStyleId, TitleStyle> = {
  cinema: { label: 'Cinéma', font: 'Playfair Display Variable', weight: 600, italic: false, upper: false, tracking: 0.01, size: 0.105, subFont: 'Inter Variable', subWeight: 500, subUpper: true, subTracking: 0.42, line: false },
  elegant: { label: 'Élégant', font: 'Cormorant Garamond Variable', weight: 500, italic: true, upper: false, tracking: 0.0, size: 0.12, subFont: 'Cormorant Garamond Variable', subWeight: 600, subUpper: true, subTracking: 0.32, line: true },
  bold: { label: 'Impact', font: 'Bebas Neue', weight: 400, italic: false, upper: true, tracking: 0.06, size: 0.16, subFont: 'Montserrat Variable', subWeight: 600, subUpper: true, subTracking: 0.3, line: false },
  minimal: { label: 'Épuré', font: 'Inter Variable', weight: 300, italic: false, upper: false, tracking: -0.02, size: 0.085, subFont: 'Inter Variable', subWeight: 500, subUpper: true, subTracking: 0.28, line: false },
  script: { label: 'Manuscrit', font: 'Great Vibes', weight: 400, italic: false, upper: false, tracking: 0, size: 0.14, subFont: 'Montserrat Variable', subWeight: 500, subUpper: true, subTracking: 0.36, line: true },
  chapter: { label: 'Chapitre', font: 'Montserrat Variable', weight: 600, italic: false, upper: true, tracking: 0.3, size: 0.032, subFont: 'Playfair Display Variable', subWeight: 500, subUpper: false, subTracking: 0, line: true },
};

export interface Theme {
  label: string;
  tagline: string;
  look: LookId;
  lookIntensity: number;
  grain: number;
  vignette: number;
  bloom: number;
  letterbox: boolean;
  title: TitleStyleId;
  chapterTitle: TitleStyleId;
  transitions: TransitionId[];
  chapterTransition: TransitionId;
  transitionDuration: number;
  photoDuration: number;
  mood: MusicMood;
  motion: number; // amplitude Ken Burns
}

export const THEMES: Record<ThemeId, Theme> = {
  cinema: {
    label: 'Cinéma', tagline: 'Cadre large, teintes ciné, rythme posé', look: 'cinema', lookIntensity: 1, grain: 0.25, vignette: 0.45, bloom: 0.15,
    letterbox: true, title: 'cinema', chapterTitle: 'chapter', transitions: ['fade', 'zoom', 'fade', 'blur'], chapterTransition: 'dipBlack',
    transitionDuration: 1.0, photoDuration: 3.4, mood: 'cinematic', motion: 1,
  },
  douceur: {
    label: 'Douceur', tagline: 'Lumière tendre, pastel et halo', look: 'dream', lookIntensity: 1, grain: 0.12, vignette: 0.25, bloom: 0.55,
    letterbox: false, title: 'elegant', chapterTitle: 'elegant', transitions: ['blur', 'fade', 'lightLeak', 'fade'], chapterTransition: 'lightLeak',
    transitionDuration: 1.3, photoDuration: 3.8, mood: 'tender', motion: 0.8,
  },
  energie: {
    label: 'Énergie', tagline: 'Coupes rythmées, couleurs vives', look: 'vivid', lookIntensity: 1, grain: 0.08, vignette: 0.3, bloom: 0.2,
    letterbox: false, title: 'bold', chapterTitle: 'bold', transitions: ['whip', 'zoom', 'cut', 'push', 'dipWhite'], chapterTransition: 'dipWhite',
    transitionDuration: 0.45, photoDuration: 1.9, mood: 'upbeat', motion: 1.3,
  },
  argentique: {
    label: 'Argentique', tagline: 'Pellicule, grain et brûlures', look: 'film', lookIntensity: 1, grain: 0.6, vignette: 0.5, bloom: 0.3,
    letterbox: false, title: 'script', chapterTitle: 'chapter', transitions: ['fade', 'filmBurn', 'fade', 'lightLeak'], chapterTransition: 'filmBurn',
    transitionDuration: 1.1, photoDuration: 3.2, mood: 'tender', motion: 0.9,
  },
  noirblanc: {
    label: 'Noir & blanc', tagline: 'Intemporel, contrasté', look: 'mono', lookIntensity: 1, grain: 0.4, vignette: 0.55, bloom: 0.1,
    letterbox: true, title: 'cinema', chapterTitle: 'chapter', transitions: ['fade', 'dipBlack', 'iris', 'fade'], chapterTransition: 'dipBlack',
    transitionDuration: 1.0, photoDuration: 3.4, mood: 'cinematic', motion: 0.8,
  },
  epure: {
    label: 'Épure', tagline: 'Naturel, net, minimal', look: 'natural', lookIntensity: 1, grain: 0.05, vignette: 0.15, bloom: 0.05,
    letterbox: false, title: 'minimal', chapterTitle: 'minimal', transitions: ['fade', 'push', 'fade', 'ink'], chapterTransition: 'fade',
    transitionDuration: 0.8, photoDuration: 2.8, mood: 'cinematic', motion: 0.7,
  },
};

export const ASPECTS: Record<AspectId, { label: string; w: number; h: number }> = {
  '16:9': { label: 'Paysage 16:9', w: 16, h: 9 },
  '9:16': { label: 'Story 9:16', w: 9, h: 16 },
  '1:1': { label: 'Carré 1:1', w: 1, h: 1 },
  '4:5': { label: 'Portrait 4:5', w: 4, h: 5 },
  '21:9': { label: 'Scope 21:9', w: 21, h: 9 },
};

export interface ExportPreset {
  id: string;
  label: string;
  aspect: AspectId | 'project';
  short: number; // côté court (px)
  hint: string;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: 'proj-1080', label: 'Format du projet · Full HD', aspect: 'project', short: 1080, hint: 'Qualité master' },
  { id: 'proj-2160', label: 'Format du projet · 4K UHD', aspect: 'project', short: 2160, hint: 'Ultra haute définition' },
  { id: 'yt-1440', label: 'YouTube 1440p 16:9', aspect: '16:9', short: 1440, hint: '2560 × 1440' },
  { id: 'hd-720', label: 'HD 720p 16:9', aspect: '16:9', short: 720, hint: 'Léger, partage rapide' },
  { id: 'story', label: 'Story / Reels 9:16', aspect: '9:16', short: 1080, hint: '1080 × 1920' },
  { id: 'square', label: 'Carré 1:1', aspect: '1:1', short: 1080, hint: '1080 × 1080' },
  { id: 'portrait', label: 'Portrait 4:5', aspect: '4:5', short: 1080, hint: '1080 × 1350' },
  { id: 'scope', label: 'Cinémascope 21:9', aspect: '21:9', short: 1080, hint: '2520 × 1080' },
];

export function dimsFor(aspect: AspectId, short: number): { w: number; h: number } {
  const a = ASPECTS[aspect];
  const even = (v: number) => Math.round(v / 2) * 2;
  if (a.w >= a.h) return { w: even((short * a.w) / a.h), h: short };
  return { w: short, h: even((short * a.h) / a.w) };
}
