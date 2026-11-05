// Musique originale générée localement (Web Audio, OfflineAudioContext) :
// nappes, arpèges façon piano, basse, rythmique selon l'ambiance.
import type { MusicMood } from '../types';
import { rng } from '../util';

export const MOODS: Record<MusicMood, { label: string; bpm: number; desc: string }> = {
  cinematic: { label: 'Cinématique', bpm: 84, desc: 'Ample, émouvant, montée progressive' },
  tender: { label: 'Tendre', bpm: 72, desc: 'Piano doux et nappes chaleureuses' },
  upbeat: { label: 'Entraînant', bpm: 112, desc: 'Rythmé, lumineux, pour l’énergie' },
};

const ROOT = 146.83; // ré
const semis = (n: number) => ROOT * Math.pow(2, n / 12);
// Accords (demi-tons depuis ré) : I=0, IV=5, V=7, vi=9 (+ septièmes douces)
const PROGS: Record<MusicMood, number[][]> = {
  cinematic: [
    [9, 12, 16, 21],
    [5, 9, 12, 16],
    [0, 4, 7, 14],
    [7, 11, 14, 18],
  ],
  tender: [
    [0, 4, 7, 11],
    [7, 11, 14, 19],
    [9, 12, 16, 19],
    [5, 9, 12, 16],
  ],
  upbeat: [
    [0, 4, 7, 12],
    [7, 11, 14, 19],
    [9, 12, 16, 21],
    [5, 9, 12, 17],
  ],
};

function noiseBuffer(ctx: BaseAudioContext) {
  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const r = rng(99);
  for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
  return buf;
}

type Build = (ctx: OfflineAudioContext, out: AudioNode) => void;
const sampleCache = new Map<string, AudioBuffer>();

/** Pré-calcule un échantillon (note, frappe, accord) une seule fois. */
async function sample(key: string, seconds: number, sampleRate: number, build: Build): Promise<AudioBuffer> {
  const k = key + '@' + sampleRate;
  const hit = sampleCache.get(k);
  if (hit) return hit;
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate);
  build(ctx, ctx.destination);
  const buf = await ctx.startRendering();
  sampleCache.set(k, buf);
  return buf;
}

function pluckBuild(freq: number, len: number): Build {
  return (ctx, out) => {
    const t = 0.001;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.25, t + Math.min(0.5, len));
    g.gain.exponentialRampToValueAtTime(0.0008, t + len + 1.2);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(Math.min(9000, freq * 9), t);
    f.frequency.exponentialRampToValueAtTime(Math.max(400, freq * 2), t + 0.9);
    for (const [type, mul, gm] of [
      ['triangle', 1, 1],
      ['sine', 2, 0.35],
      ['sine', 3, 0.12],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * mul;
      const og = ctx.createGain();
      og.gain.value = gm;
      o.connect(og).connect(f);
      o.start(t);
    }
    f.connect(g).connect(out);
  };
}

function padBuild(chord: number[], len: number, bright: boolean): Build {
  return (ctx, out) => {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(bright ? 1800 : 900, 0);
    filter.frequency.linearRampToValueAtTime(bright ? 2600 : 1500, len * 0.6);
    filter.frequency.linearRampToValueAtTime(bright ? 2000 : 1000, len + 1);
    filter.Q.value = 0.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.5, Math.min(1.2, len * 0.35));
    g.gain.setValueAtTime(0.5, len - 0.1);
    g.gain.linearRampToValueAtTime(0, len + 1.0);
    filter.connect(g).connect(out);
    let k = 0;
    for (const n of chord) {
      for (const det of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = semis(n);
        o.detune.value = det + ((k++ * 37) % 5) - 2;
        o.connect(filter);
        o.start(0);
      }
    }
  };
}

function bassBuild(freq: number, len: number): Build {
  return (ctx, out) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.9, 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, len);
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = freq;
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    o.connect(g);
    o2.connect(g2).connect(g);
    g.connect(out);
    o.start(0);
    o2.start(0);
  };
}

const kickBuild: Build = (ctx, out) => {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(130, 0);
  o.frequency.exponentialRampToValueAtTime(42, 0.14);
  const g = ctx.createGain();
  g.gain.setValueAtTime(1, 0);
  g.gain.exponentialRampToValueAtTime(0.001, 0.42);
  o.connect(g).connect(out);
  o.start(0);
};

function noiseHit(type: BiquadFilterType, freq: number, q: number, decay: number): Build {
  return (ctx, out) => {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer(ctx);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(1, 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, decay);
    s.connect(f).connect(g).connect(out);
    s.start(0);
  };
}

/** Réverbération de type Freeverb : 8 filtres en peigne amortis + 4 passe-tout. */
function freeverb(input: Float32Array, sr: number, room: number, damp: number, spread: number): Float32Array {
  const scale = sr / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round((d + spread) * scale));
  const alls = [556, 441, 341, 225].map((d) => Math.round((d + spread) * scale));
  const out = new Float32Array(input.length);
  const n = input.length;
  for (const len of combs) {
    const buf = new Float32Array(len);
    let idx = 0,
      store = 0;
    for (let i = 0; i < n; i++) {
      const y = buf[idx];
      store = y * (1 - damp) + store * damp;
      buf[idx] = input[i] * 0.015 + store * room;
      out[i] += y;
      if (++idx >= len) idx = 0;
    }
  }
  for (const len of alls) {
    const buf = new Float32Array(len);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[idx];
      const x = out[i];
      buf[idx] = x + b * 0.5;
      out[i] = b - x;
      if (++idx >= len) idx = 0;
    }
  }
  return out;
}

export async function generateMusic(mood: MusicMood, duration: number, sampleRate = 44100): Promise<{ buffer: AudioBuffer; bpm: number }> {
  const { bpm } = MOODS[mood];
  const beat = 60 / bpm;
  const total = Math.max(4, duration + 1);
  const r = rng(mood.length * 1337 + Math.round(duration));
  const prog = PROGS[mood];
  const barBeats = 4;
  const chordBars = mood === 'upbeat' ? 1 : 2;
  const chordLen = barBeats * chordBars * beat;
  const nChords = Math.ceil(total / chordLen);
  const totalBars = Math.ceil(total / (barBeats * beat));
  const step = mood === 'tender' ? beat : beat / 2;
  const sr = sampleRate;

  // 1. Échantillons (calculés une fois, réutilisés pour toutes les occurrences)
  const pads = await Promise.all(prog.map((ch, i) => sample(`pad-${mood}-${i}-${chordLen.toFixed(3)}`, chordLen + 1.2, sr, padBuild(ch, chordLen, mood === 'upbeat'))));
  const pluckLen = step * 1.6;
  const notesNeeded = new Set<number>();
  prog.forEach((ch) => {
    [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[3] + 12, ch[2] + 24, ch[1] + 12, ch[3] + 24].forEach((n) => notesNeeded.add(n));
  });
  const plucks = new Map<number, AudioBuffer>();
  await Promise.all(
    [...notesNeeded].map(async (n) => plucks.set(n, await sample(`pluck-${n}-${pluckLen.toFixed(3)}`, pluckLen + 1.4, sr, pluckBuild(semis(n), pluckLen)))),
  );
  const longNote = new Map<number, AudioBuffer>();
  if (mood !== 'upbeat')
    await Promise.all(prog.map(async (ch) => longNote.set(ch[3] + 24, await sample(`long-${ch[3] + 24}-${beat.toFixed(3)}`, beat * 3 + 1.4, sr, pluckBuild(semis(ch[3] + 24), beat * 3)))));
  const bassLen = beat * (mood === 'upbeat' ? 0.9 : 2.2);
  const basses = new Map<number, AudioBuffer>();
  await Promise.all(prog.map(async (ch) => basses.set(ch[0], await sample(`bass-${ch[0]}-${bassLen.toFixed(3)}`, bassLen + 0.05, sr, bassBuild(semis(ch[0] - 12), bassLen)))));
  const kick = await sample('kick', 0.45, sr, kickBuild);
  const hat = await sample('hat', 0.08, sr, noiseHit('highpass', 7500, 0.7, 0.06));
  const clap = await sample('clap', 0.25, sr, noiseHit('bandpass', 1700, 0.8, 0.22));

  // 2. Arrangement : mixage direct dans des tampons (bien plus rapide que des centaines de nœuds audio)
  const N = Math.ceil(total * sr);
  const dryL = new Float32Array(N),
    dryR = new Float32Array(N),
    sendL = new Float32Array(N),
    sendR = new Float32Array(N);
  const play = (buf: AudioBuffer, t: number, vol: number, send: number, pan = 0) => {
    if (t >= total) return;
    const d = buf.getChannelData(0);
    const o = Math.max(0, Math.round(t * sr));
    const n = Math.min(d.length, N - o);
    const gl = vol * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    const gr = vol * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    for (let i = 0; i < n; i++) {
      const v = d[i];
      dryL[o + i] += v * gl;
      dryR[o + i] += v * gr;
      sendL[o + i] += v * gl * send;
      sendR[o + i] += v * gr * send;
    }
  };
  const PAD = mood === 'upbeat' ? 0.05 : 0.075,
    KEYS = 0.16,
    BASS = mood === 'upbeat' ? 0.32 : 0.22,
    DRUM = mood === 'upbeat' ? 0.5 : 0.3;

  for (let c = 0; c < nChords; c++) {
    const t0 = c * chordLen;
    const ci = c % prog.length;
    const chord = prog[ci];
    play(pads[ci], t0, PAD, 1, 0);
    const notes = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[3] + 12, chord[2] + 24, chord[1] + 12];
    const arpStartBar = mood === 'upbeat' ? 1 : 2;
    for (let k = 0; k * step < chordLen - 0.01; k++) {
      const t = t0 + k * step;
      if (t / (barBeats * beat) < arpStartBar || t > total - 2.5) continue;
      if (mood === 'cinematic' && r() < 0.18) continue;
      const n = notes[(k + c) % notes.length];
      const accent = k % (mood === 'tender' ? 4 : 8) === 0 ? 1 : 0.62;
      play(plucks.get(n)!, t + (r() - 0.5) * 0.012, KEYS * 0.55 * accent * (0.85 + r() * 0.3), 0.9, (r() - 0.5) * 0.5);
    }
    if (mood !== 'upbeat' && c % 2 === 1 && t0 > barBeats * beat * 3) play(longNote.get(chord[3] + 24)!, t0 + beat * 2, KEYS * 0.45, 0.9, 0.1);
  }
  const bassStart = mood === 'upbeat' ? 2 : 4;
  for (let bar = bassStart; bar < totalBars; bar++) {
    const t0 = bar * barBeats * beat;
    if (t0 > total - 2) break;
    const chord = prog[Math.floor(t0 / chordLen) % prog.length];
    for (const h of mood === 'upbeat' ? [0, 1.5, 2, 3.5] : [0, 2.5]) play(basses.get(chord[0])!, t0 + h * beat, BASS, 0.15);
  }
  const drumStart = mood === 'upbeat' ? 2 : mood === 'cinematic' ? 6 : 999;
  for (let bar = drumStart; bar < totalBars; bar++) {
    const t0 = bar * barBeats * beat;
    if (t0 > total - 3) break;
    if (mood === 'upbeat') {
      for (let b = 0; b < 4; b++) play(kick, t0 + b * beat, DRUM * 0.9, 0.12);
      for (let b = 0; b < 8; b++) play(hat, t0 + b * (beat / 2), DRUM * (b % 2 ? 0.35 : 0.16), 0.12, 0.25);
      play(clap, t0 + beat, DRUM * 0.55, 0.12, -0.1);
      play(clap, t0 + 3 * beat, DRUM * 0.55, 0.12, -0.1);
    } else {
      play(kick, t0, DRUM * 0.55, 0.12);
      if (bar % 2 === 1) play(kick, t0 + 2.5 * beat, DRUM * 0.3, 0.12);
    }
  }
  if (mood === 'cinematic') play(kick, 0.05, DRUM * 0.6, 0.12);

  // 3. Réverbération algorithmique (Freeverb simplifiée) puis mastering
  const wet = mood === 'upbeat' ? 0.22 : 0.42;
  const room = mood === 'upbeat' ? 0.78 : 0.86;
  const revL = freeverb(sendL, sr, room, 0.35, 0);
  const revR = freeverb(sendR, sr, room, 0.35, 23);
  const buffer = new AudioBuffer({ length: N, numberOfChannels: 2, sampleRate: sr });
  const L = buffer.getChannelData(0),
    R = buffer.getChannelData(1);
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 1.2, Math.max(0, (total - 0.3 - t) / 3.2));
    L[i] = (dryL[i] * 0.8 + revL[i] * wet) * env;
    R[i] = (dryR[i] * 0.8 + revR[i] * wet) * env;
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) peak = a;
  }
  // normalisation puis saturation douce (limiteur)
  const k = peak > 0.0001 ? 1.15 / peak : 1;
  for (let i = 0; i < N; i++) {
    L[i] = Math.tanh(L[i] * k) * 0.92;
    R[i] = Math.tanh(R[i] * k) * 0.92;
  }
  return { buffer, bpm };
}

/** Estimation du tempo (BPM) d'un morceau importé par autocorrélation de l'enveloppe d'attaques. */
export function estimateBpm(buf: AudioBuffer): { bpm: number; offset: number } {
  const sr = buf.sampleRate;
  const hop = 512;
  const len = Math.min(buf.length, sr * 90);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const frames = Math.floor(len / hop);
  const env = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      let s = 0;
      for (const c of chans) s += c[i];
      e += s * s;
    }
    e = Math.log1p(e * 100);
    env[f] = Math.max(0, e - prev);
    prev = e;
  }
  const fps = sr / hop;
  let best = 0,
    bestLag = 0;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    for (let f = 0; f + lag * 2 < frames; f++) {
      const i1 = Math.round(f + lag),
        i2 = Math.round(f + lag * 2);
      s += env[f] * (env[i1] + 0.5 * env[i2]);
    }
    const prior = Math.exp(-Math.pow(Math.log2(bpm / 115), 2) * 2.5);
    s *= prior;
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  const bpm = bestLag ? Math.round((60 / (bestLag / fps)) * 2) / 2 : 100;
  // phase du premier temps
  const period = (60 / bpm) * fps;
  let bestPhase = 0,
    bestScore = -1;
  for (let ph = 0; ph < period; ph++) {
    let s = 0;
    for (let f = ph; f < frames; f += period) s += env[Math.round(f)] ?? 0;
    if (s > bestScore) {
      bestScore = s;
      bestPhase = ph;
    }
  }
  return { bpm, offset: bestPhase / fps };
}
