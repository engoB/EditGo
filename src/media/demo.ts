// Médias de démonstration générés procéduralement (paysages d'un court voyage),
// pour essayer l'application sans fichiers. Inclut volontairement des doublons
// et une rafale pour montrer la détection.
import type { MediaItem } from '../types';
import { blankItem, analyzePixels } from './analyze';
import { rng } from '../util';

type Scene = 'sunset' | 'mountain' | 'sea' | 'city' | 'forest' | 'aurora' | 'desert' | 'lake';

function drawScene(scene: Scene, seed: number, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const r = rng(seed * 7919 + 13);
  const pal: Record<Scene, [string, string, string]> = {
    sunset: ['#1d1a4a', '#e8576b', '#ffc56b'],
    mountain: ['#5d86c4', '#a9c8ea', '#f3efe6'],
    sea: ['#3c7fc4', '#8fd0f0', '#e9f6ff'],
    city: ['#05060f', '#1b1f45', '#43307a'],
    forest: ['#7fb4c8', '#cfe3d4', '#f1efe1'],
    aurora: ['#030812', '#0a1b33', '#123b4a'],
    desert: ['#e98a52', '#f5c487', '#ffe9c4'],
    lake: ['#f0a87a', '#f6d1b2', '#fbeee2'],
  };
  const [c1, c2, c3] = pal[scene];
  const sky = g.createLinearGradient(0, 0, 0, h * 0.75);
  sky.addColorStop(0, c1);
  sky.addColorStop(0.6, c2);
  sky.addColorStop(1, c3);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  const horizon = h * (0.55 + r() * 0.12);
  const S = Math.min(w, h);

  if (scene === 'aurora' || scene === 'city') {
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(255,255,255,${r() * 0.8})`;
      const s = r() * 1.6 + 0.3;
      g.fillRect(r() * w, r() * horizon, s * (S / 900), s * (S / 900));
    }
  }
  if (scene === 'aurora') {
    for (let k = 0; k < 3; k++) {
      g.save();
      g.globalCompositeOperation = 'screen';
      const grad = g.createLinearGradient(0, h * 0.1, 0, h * 0.6);
      grad.addColorStop(0, 'rgba(80,255,170,0)');
      grad.addColorStop(0.5, `rgba(${60 + k * 40},255,${160 + k * 30},0.35)`);
      grad.addColorStop(1, 'rgba(80,255,170,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, h * 0.5);
      for (let x = 0; x <= w; x += w / 40) g.lineTo(x, h * (0.25 + 0.12 * Math.sin(x / w * 6 + k * 2 + seed) + k * 0.05));
      g.lineTo(w, h * 0.6);
      g.lineTo(0, h * 0.6);
      g.fill();
      g.restore();
    }
  }
  // Soleil / lune
  if (scene !== 'city' && scene !== 'aurora') {
    const sx = w * (0.25 + r() * 0.5),
      sy = horizon - h * (0.08 + r() * 0.25);
    const rad = S * (0.05 + r() * 0.04);
    const glow = g.createRadialGradient(sx, sy, rad * 0.2, sx, sy, rad * 6);
    glow.addColorStop(0, 'rgba(255,245,220,0.95)');
    glow.addColorStop(0.15, 'rgba(255,220,170,0.45)');
    glow.addColorStop(1, 'rgba(255,200,150,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,250,235,0.95)';
    g.beginPath();
    g.arc(sx, sy, rad, 0, Math.PI * 2);
    g.fill();
  }
  // Reliefs en couches (perspective atmosphérique)
  const layers = scene === 'sea' ? 1 : scene === 'city' ? 0 : 4;
  for (let l = 0; l < layers; l++) {
    const depth = l / Math.max(1, layers - 1);
    const base = horizon + depth * h * 0.18 - h * 0.05;
    const amp = h * (scene === 'mountain' ? 0.28 : scene === 'desert' ? 0.08 : 0.14) * (1 - depth * 0.45);
    const col = scene === 'sunset' ? [40 - depth * 25, 25 - depth * 15, 70 - depth * 40]
      : scene === 'forest' ? [70 - depth * 45, 110 - depth * 60, 90 - depth * 55]
      : scene === 'desert' ? [200 - depth * 70, 120 - depth * 50, 70 - depth * 30]
      : scene === 'lake' ? [120 - depth * 70, 100 - depth * 55, 120 - depth * 60]
      : scene === 'aurora' ? [10, 18 - depth * 8, 28 - depth * 12]
      : [90 - depth * 55, 110 - depth * 60, 140 - depth * 70];
    g.fillStyle = `rgb(${col.map((v) => Math.max(0, Math.round(v))).join(',')})`;
    g.beginPath();
    g.moveTo(0, h);
    const ph = r() * 10;
    for (let x = 0; x <= w; x += w / 120) {
      const u = x / w;
      const y = base - amp * (0.5 + 0.35 * Math.sin(u * 5 + ph) + 0.15 * Math.sin(u * 17 + ph * 2) + 0.08 * Math.sin(u * 41 + ph * 3)) * (scene === 'mountain' ? 1 - Math.abs(u - 0.5) * 0.6 : 1);
      g.lineTo(x, y);
    }
    g.lineTo(w, h);
    g.fill();
    if (scene === 'mountain' && l === 0) {
      g.save();
      g.clip();
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.fillRect(0, 0, w, base - amp * 0.62);
      g.restore();
    }
    if (scene === 'forest' && l >= 2) {
      for (let i = 0; i < 70; i++) {
        const x = r() * w,
          th = h * (0.08 + r() * 0.1) * (0.6 + depth);
        const y = base - amp * 0.2 + r() * h * 0.05;
        g.beginPath();
        g.moveTo(x, y - th);
        g.lineTo(x - th * 0.22, y);
        g.lineTo(x + th * 0.22, y);
        g.fill();
      }
    }
  }
  // Eau avec reflets
  if (scene === 'sea' || scene === 'lake' || scene === 'sunset') {
    const wy = scene === 'sunset' ? horizon + h * 0.08 : horizon;
    const water = g.createLinearGradient(0, wy, 0, h);
    water.addColorStop(0, scene === 'sunset' ? '#e07a74' : scene === 'lake' ? '#d9a68a' : '#2f6fa8');
    water.addColorStop(1, scene === 'sunset' ? '#241b45' : scene === 'lake' ? '#6b5a73' : '#0f3255');
    g.fillStyle = water;
    g.fillRect(0, wy, w, h - wy);
    g.globalAlpha = 0.35;
    for (let i = 0; i < 160; i++) {
      const y = wy + Math.pow(r(), 1.6) * (h - wy);
      const lw = (0.02 + r() * 0.08) * w * (0.3 + (y - wy) / (h - wy));
      g.fillStyle = r() > 0.5 ? '#fff4e0' : '#ffffff';
      g.fillRect(w * (0.3 + r() * 0.4) - lw / 2 + (r() - 0.5) * w * 0.4, y, lw, Math.max(1, S * 0.002));
    }
    g.globalAlpha = 1;
  }
  if (scene === 'city') {
    for (let i = 0; i < 46; i++) {
      const bw = w * (0.03 + r() * 0.05),
        bh = h * (0.15 + r() * 0.45);
      const x = (i / 46) * w * 1.1 - w * 0.05;
      g.fillStyle = `rgb(${12 + r() * 14},${12 + r() * 14},${30 + r() * 20})`;
      g.fillRect(x, h - bh, bw, bh);
      for (let k = 0; k < 40; k++) {
        if (r() > 0.55) continue;
        g.fillStyle = r() > 0.3 ? 'rgba(255,210,120,0.9)' : 'rgba(150,200,255,0.9)';
        g.fillRect(x + r() * bw * 0.9, h - bh + r() * bh * 0.95, S * 0.004, S * 0.006);
      }
    }
    const glow = g.createLinearGradient(0, h * 0.6, 0, h);
    glow.addColorStop(0, 'rgba(255,120,80,0)');
    glow.addColorStop(1, 'rgba(255,120,80,0.25)');
    g.fillStyle = glow;
    g.fillRect(0, h * 0.6, w, h * 0.4);
  }
  // Silhouette au premier plan (personnes) pour certaines scènes
  if (seed % 3 === 0 && scene !== 'city') {
    g.fillStyle = 'rgba(10,8,15,0.92)';
    const n = 1 + (seed % 2);
    for (let i = 0; i < n; i++) {
      const px = w * (0.42 + i * 0.07 + r() * 0.06),
        ph = h * 0.22;
      const py = h - h * 0.04;
      g.beginPath();
      g.ellipse(px, py - ph, ph * 0.08, ph * 0.1, 0, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(px - ph * 0.13, py);
      g.quadraticCurveTo(px - ph * 0.16, py - ph * 0.75, px, py - ph * 0.86);
      g.quadraticCurveTo(px + ph * 0.16, py - ph * 0.75, px + ph * 0.13, py);
      g.fill();
    }
  }
  return c;
}

export function makeDemo(): MediaItem[] {
  const start = new Date();
  start.setMonth(6, 12);
  start.setHours(9, 20, 0, 0);
  const base = start.getTime();
  const H = 3_600_000;
  const plan: { scene: Scene; at: number; portrait?: boolean; dup?: boolean; burst?: number }[] = [
    { scene: 'lake', at: 0 },
    { scene: 'mountain', at: 1.2 },
    { scene: 'mountain', at: 1.25, portrait: true },
    { scene: 'forest', at: 3.1 },
    { scene: 'sunset', at: 10.4, burst: 3 },
    { scene: 'city', at: 13.2 },
    { scene: 'sea', at: 24.5 },
    { scene: 'sea', at: 25.1, portrait: true },
    { scene: 'desert', at: 27.8, dup: true },
    { scene: 'sunset', at: 34.2 },
    { scene: 'aurora', at: 38.1 },
    { scene: 'lake', at: 49.0, portrait: true },
    { scene: 'forest', at: 50.3 },
    { scene: 'mountain', at: 52.6 },
    { scene: 'sunset', at: 58.4 },
    { scene: 'city', at: 61.0 },
  ];
  const items: MediaItem[] = [];
  plan.forEach((p, i) => {
    const copies = p.burst ?? 1;
    for (let k = 0; k < copies; k++) {
      const seed = i * 11 + 3 + (p.burst ? 0 : k);
      const w = p.portrait ? 1080 : 1920,
        h = p.portrait ? 1440 : 1080;
      const it = blankItem('photo', `IMG_${String(4200 + items.length).padStart(4, '0')}.JPG`, 'Démo/Voyage', 2_400_000 + seed * 1000);
      it.width = w;
      it.height = h;
      it.date = base + p.at * H + k * 1500;
      it.dateSource = 'demo';
      const shift = k * 0.012;
      it.demo = {
        draw: (cw, ch) => {
          const src = drawScene(p.scene, seed, w, h);
          const c = document.createElement('canvas');
          c.width = cw;
          c.height = ch;
          const g = c.getContext('2d')!;
          // rafale : léger décalage de cadrage entre les vues
          g.drawImage(src, -shift * cw, 0, cw * (1 + shift), ch * (1 + shift * 0.5));
          return c;
        },
      };
      const small = it.demo.draw(Math.round(w / 5), Math.round(h / 5));
      Object.assign(it, analyzePixels(small, small.width, small.height));
      it.thumb = small.toDataURL('image/jpeg', 0.8);
      it.hash = 'demo-' + seed + '-' + k;
      items.push(it);
      if (p.dup) {
        const d = { ...it, id: it.id + 'd', name: it.name.replace('.JPG', ' (1).JPG') };
        items.push(d);
      }
    }
  });
  return items;
}
