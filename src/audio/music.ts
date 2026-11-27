// Musique originale générée localement (Web Audio, OfflineAudioContext) :
// cinq ambiances distinctes (tonalité, tempo, instrument, rythmique) : piano, cordes, piano
// électrique, cloches, arpèges pincés ; nappes, basse et réverbération.
import type { MusicMood } from '../types';
import { rng } from '../util';

export const MOODS: Record<MusicMood, { label: string; bpm: number; desc: string }> = {
  cinematic: { label: 'Cinématique', bpm: 76, desc: 'Cordes amples et piano, montée lente' },
  tender: { label: 'Tendre', bpm: 70, desc: 'Piano seul, doux et intime' },
  nostalgic: { label: 'Nostalgique', bpm: 78, desc: 'Piano électrique feutré, rythme léger' },
  airy: { label: 'Aérien', bpm: 60, desc: 'Nappes et cloches, contemplatif, sans rythme' },
  upbeat: { label: 'Entraînant', bpm: 116, desc: 'Lumineux et rythmé' },
};

type KeyTimbre = 'pluck' | 'piano' | 'rhodes' | 'bell';
type PadKind = 'strings' | 'warm' | 'bright' | 'air';
type Drums = 'none' | 'soft' | 'pop' | 'lofi';
interface Spec {
  root: number; // Hz : chaque ambiance a sa propre tonalité
  prog: number[][]; // accords (demi-tons depuis la tonique)
  chordBars: number;
  keys: KeyTimbre;
  pad: PadKind;
  drums: Drums;
  step: number; // durée d'une note d'arpège, en temps
  skip: number; // probabilité de silence dans l'arpège (respiration)
  padVol: number;
  keysVol: number;
  bassVol: number;
  wet: number;
  room: number;
}
const SPEC: Record<MusicMood, Spec> = {
  // ré mineur : vi – IV – I – V, cordes lentes, piano, timbale douce
  cinematic: { root: 146.83, prog: [[9, 12, 16, 21], [5, 9, 12, 16], [0, 4, 7, 14], [7, 11, 14, 18]], chordBars: 2, keys: 'piano', pad: 'strings', drums: 'soft', step: 1, skip: 0.2, padVol: 0.1, keysVol: 0.15, bassVol: 0.2, wet: 0.45, room: 0.87 },
  // fa majeur : I – V – vi – IV, piano seul, nappe discrète
  tender: { root: 174.61, prog: [[0, 4, 7, 11], [7, 11, 14, 19], [9, 12, 16, 19], [5, 9, 12, 16]], chordBars: 2, keys: 'piano', pad: 'warm', drums: 'none', step: 1, skip: 0.1, padVol: 0.045, keysVol: 0.19, bassVol: 0.14, wet: 0.4, room: 0.86 },
  // do : vi – IV – I – V avec septièmes, piano électrique et rythmique feutrée
  nostalgic: { root: 130.81, prog: [[9, 12, 16, 19], [5, 9, 12, 16], [0, 4, 7, 11], [7, 11, 14, 17]], chordBars: 2, keys: 'rhodes', pad: 'warm', drums: 'lofi', step: 0.5, skip: 0.35, padVol: 0.05, keysVol: 0.17, bassVol: 0.22, wet: 0.3, room: 0.8 },
  // mi : I – IV – vi – V (add9), nappes et cloches, sans percussion
  airy: { root: 164.81, prog: [[0, 7, 11, 14], [5, 9, 12, 16], [9, 12, 16, 19], [7, 11, 14, 18]], chordBars: 2, keys: 'bell', pad: 'air', drums: 'none', step: 2, skip: 0.3, padVol: 0.09, keysVol: 0.12, bassVol: 0.1, wet: 0.6, room: 0.9 },
  // sol majeur : I – V – vi – IV, arpèges pincés et rythmique pop
  upbeat: { root: 196, prog: [[0, 4, 7, 12], [7, 11, 14, 19], [9, 12, 16, 21], [5, 9, 12, 17]], chordBars: 1, keys: 'pluck', pad: 'bright', drums: 'pop', step: 0.5, skip: 0, padVol: 0.05, keysVol: 0.16, bassVol: 0.32, wet: 0.22, room: 0.78 },
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

function env(ctx: BaseAudioContext, attack: number, peak: number, decayTo: number, decayTime: number, release: number) {
  const g = ctx.createGain();
  const t = 0.001;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, decayTo), t + attack + decayTime);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decayTime + release);
  return g;
}

function partials(ctx: BaseAudioContext, out: AudioNode, freq: number, list: [OscillatorType, number, number][]) {
  for (const [type, mul, gm] of list) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq * mul;
    const og = ctx.createGain();
    og.gain.value = gm;
    o.connect(og).connect(out);
    o.start(0.001);
  }
}

/** Notes mélodiques, un timbre par ambiance. */
function keyBuild(timbre: KeyTimbre, freq: number, len: number): Build {
  return (ctx, out) => {
    if (timbre === 'pluck') {
      const g = env(ctx, 0.006, 1, 0.25, Math.min(0.5, len), len + 1.2);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(Math.min(9000, freq * 9), 0);
      f.frequency.exponentialRampToValueAtTime(Math.max(400, freq * 2), 0.9);
      partials(ctx, f, freq, [['triangle', 1, 1], ['sine', 2, 0.35], ['sine', 3, 0.12]]);
      f.connect(g).connect(out);
    } else if (timbre === 'piano') {
      // marteau feutré : attaque nette, harmoniques qui s'éteignent plus vite que la fondamentale
      const g = env(ctx, 0.004, 1, 0.35, 0.35, 2.6);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(Math.min(7000, freq * 7), 0);
      f.frequency.exponentialRampToValueAtTime(Math.max(500, freq * 2.5), 1.4);
      partials(ctx, f, freq, [['sine', 1, 1], ['sine', 2.003, 0.45], ['triangle', 3.01, 0.18], ['sine', 4.02, 0.08]]);
      f.connect(g).connect(out);
    } else if (timbre === 'rhodes') {
      // piano électrique : fondamentale ronde, « tine » brillant très court, léger trémolo
      const g = env(ctx, 0.008, 0.9, 0.4, 0.6, 1.8);
      const trem = ctx.createGain();
      trem.gain.value = 0.85;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 4.6;
      const depth = ctx.createGain();
      depth.gain.value = 0.15;
      lfo.connect(depth).connect(trem.gain);
      lfo.start(0);
      partials(ctx, trem, freq, [['sine', 1, 1], ['sine', 2, 0.22]]);
      const tine = env(ctx, 0.002, 0.25, 0.001, 0.12, 0.05);
      partials(ctx, tine, freq, [['sine', 14, 1]]);
      tine.connect(out);
      trem.connect(g).connect(out);
    } else {
      // cloche douce : partiels inharmoniques, longue résonance
      const g = env(ctx, 0.01, 0.8, 0.3, 0.8, 3.2);
      partials(ctx, g, freq, [['sine', 1, 1], ['sine', 2.76, 0.35], ['sine', 5.4, 0.12], ['sine', 8.93, 0.04]]);
      g.connect(out);
    }
  };
}

function padBuild(freqs: number[], len: number, kind: PadKind): Build {
  return (ctx, out) => {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const lo = kind === 'bright' ? 1800 : kind === 'air' ? 2400 : kind === 'strings' ? 1100 : 900;
    filter.frequency.setValueAtTime(lo, 0);
    filter.frequency.linearRampToValueAtTime(lo * 1.5, len * 0.6);
    filter.frequency.linearRampToValueAtTime(lo * 1.1, len + 1);
    filter.Q.value = 0.4;
    const g = ctx.createGain();
    const attack = kind === 'strings' || kind === 'air' ? Math.min(2.2, len * 0.45) : Math.min(1.2, len * 0.35);
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.5, attack);
    g.gain.setValueAtTime(0.5, len - 0.1);
    g.gain.linearRampToValueAtTime(0, len + 1.0);
    filter.connect(g).connect(out);
    let k = 0;
    for (const f of freqs) {
      const voices: [OscillatorType, number, number][] =
        kind === 'air'
          ? [['sine', 1, -4], ['triangle', 2, 5]]
          : [['sawtooth', 1, -7], ['sawtooth', 1, 6]];
      for (const [type, mul, det] of voices) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f * mul;
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
  const spec = SPEC[mood] ?? SPEC.cinematic;
  const { bpm } = MOODS[mood] ?? MOODS.cinematic;
  const hz = (n: number) => spec.root * Math.pow(2, n / 12);
  const beat = 60 / bpm;
  const prog = spec.prog;
  const barBeats = 4;
  const chordLen = barBeats * spec.chordBars * beat;
  // boucle d'environ 3 min au plus (nombre entier de grilles d'accords), répétée sans couture :
  // la mémoire reste faible même pour un film d'une heure
  const progDur = prog.length * chordLen;
  const total = Math.max(1, Math.ceil(Math.min(Math.max(duration, 20), 200) / progDur)) * progDur;
  const r = rng(mood.length * 1337 + Math.round(total));
  const nChords = Math.ceil(total / chordLen);
  const totalBars = Math.ceil(total / (barBeats * beat));
  const step = spec.step * beat;
  const sr = sampleRate;
  const id = `${mood}-${spec.root}`;

  // 1. Échantillons (calculés une fois, réutilisés pour toutes les occurrences)
  const pads = await Promise.all(
    prog.map((ch, i) => sample(`pad-${id}-${i}-${chordLen.toFixed(3)}`, chordLen + 1.2, sr, padBuild(ch.map(hz), chordLen, spec.pad))),
  );
  const noteLen = Math.max(step * 1.6, spec.keys === 'pluck' ? 0 : 1.2);
  const notesNeeded = new Set<number>();
  prog.forEach((ch) => [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[3] + 12, ch[2] + 24, ch[1] + 24, ch[3] + 24].forEach((n) => notesNeeded.add(n)));
  const tail = spec.keys === 'bell' ? 4.2 : spec.keys === 'piano' ? 3.2 : 2.6;
  const keys = new Map<number, AudioBuffer>();
  await Promise.all(
    [...notesNeeded].map(async (n) => keys.set(n, await sample(`key-${spec.keys}-${id}-${n}-${noteLen.toFixed(3)}`, noteLen + tail, sr, keyBuild(spec.keys, hz(n), noteLen)))),
  );
  const bassLen = beat * (spec.drums === 'pop' ? 0.9 : 2.2);
  const basses = new Map<number, AudioBuffer>();
  await Promise.all(prog.map(async (ch) => basses.set(ch[0], await sample(`bass-${id}-${ch[0]}-${bassLen.toFixed(3)}`, bassLen + 0.05, sr, bassBuild(hz(ch[0] - 12), bassLen)))));
  const kick = await sample('kick', 0.45, sr, kickBuild);
  const hat = await sample('hat', 0.08, sr, noiseHit('highpass', 7500, 0.7, 0.06));
  const clap = await sample('clap', 0.25, sr, noiseHit('bandpass', 1700, 0.8, 0.22));
  const snare = await sample('snare-soft', 0.3, sr, noiseHit('bandpass', 1100, 0.6, 0.2));

  // 2. Arrangement : mixage direct dans des tampons (bien plus rapide que des centaines de nœuds audio)
  const loopN = Math.round(total * sr);
  const N = loopN + Math.ceil(6 * sr); // + traîne (notes tenues, réverbération), repliée au début
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
  const DRUM = spec.drums === 'pop' ? 0.5 : 0.3;
  const swing = spec.drums === 'lofi' ? step * 0.18 : 0;

  for (let c = 0; c < nChords; c++) {
    const t0 = c * chordLen;
    const ci = c % prog.length;
    const chord = prog[ci];
    play(pads[ci], t0, spec.padVol, 1, 0);
    const notes =
      spec.keys === 'bell'
        ? [chord[1] + 24, chord[3] + 12, chord[2] + 24, chord[0] + 12]
        : [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[3] + 12, chord[2] + 24, chord[1] + 12];
    const arpStartBar = spec.drums === 'pop' ? 1 : 2;
    for (let k = 0; k * step < chordLen - 0.01; k++) {
      const t = t0 + k * step + (k % 2 ? swing : 0);
      if (t / (barBeats * beat) < arpStartBar) continue;
      if (r() < spec.skip) continue;
      const n = notes[(k + c) % notes.length];
      const accent = k % (spec.step >= 1 ? 4 : 8) === 0 ? 1 : 0.65;
      play(keys.get(n)!, t + (r() - 0.5) * 0.012, spec.keysVol * 0.6 * accent * (0.85 + r() * 0.3), 0.9, (r() - 0.5) * 0.5);
    }
    // note tenue aiguë toutes les deux grilles (respiration mélodique)
    if (spec.keys !== 'pluck' && c % 2 === 1 && t0 > barBeats * beat * 3) play(keys.get(chord[3] + 24)!, t0 + beat * 2, spec.keysVol * 0.45, 0.9, 0.1);
  }
  const bassStart = spec.drums === 'pop' ? 2 : 4;
  for (let bar = bassStart; bar < totalBars; bar++) {
    const t0 = bar * barBeats * beat;
    const chord = prog[Math.floor(t0 / chordLen) % prog.length];
    const hits = spec.drums === 'pop' ? [0, 1.5, 2, 3.5] : spec.drums === 'lofi' ? [0, 2.5] : spec.keys === 'bell' ? [0] : [0, 2.5];
    for (const h of hits) play(basses.get(chord[0])!, t0 + h * beat, spec.bassVol, 0.15);
  }
  const drumStart = spec.drums === 'pop' ? 2 : spec.drums === 'soft' ? 6 : 4;
  if (spec.drums !== 'none')
    for (let bar = drumStart; bar < totalBars; bar++) {
      const t0 = bar * barBeats * beat;
      if (spec.drums === 'pop') {
        for (let b = 0; b < 4; b++) play(kick, t0 + b * beat, DRUM * 0.9, 0.12);
        for (let b = 0; b < 8; b++) play(hat, t0 + b * (beat / 2), DRUM * (b % 2 ? 0.35 : 0.16), 0.12, 0.25);
        play(clap, t0 + beat, DRUM * 0.55, 0.12, -0.1);
        play(clap, t0 + 3 * beat, DRUM * 0.55, 0.12, -0.1);
      } else if (spec.drums === 'lofi') {
        play(kick, t0, DRUM * 0.7, 0.05);
        play(kick, t0 + 2.5 * beat, DRUM * 0.45, 0.05);
        play(snare, t0 + beat, DRUM * 0.38, 0.2, 0.05);
        play(snare, t0 + 3 * beat, DRUM * 0.38, 0.2, 0.05);
        for (let b = 0; b < 8; b++) play(hat, t0 + b * (beat / 2) + (b % 2 ? beat * 0.09 : 0), DRUM * (b % 2 ? 0.16 : 0.1), 0.1, 0.3);
      } else {
        play(kick, t0, DRUM * 0.55, 0.12);
        if (bar % 2 === 1) play(kick, t0 + 2.5 * beat, DRUM * 0.3, 0.12);
      }
    }
  if (spec.drums === 'soft') play(kick, 0.05, DRUM * 0.6, 0.12);

  // 3. Réverbération algorithmique (Freeverb simplifiée) puis mastering
  const revL = freeverb(sendL, sr, spec.room, 0.35, 0);
  const revR = freeverb(sendR, sr, spec.room, 0.35, 23);
  const buffer = new AudioBuffer({ length: loopN, numberOfChannels: 2, sampleRate: sr });
  const L = buffer.getChannelData(0),
    R = buffer.getChannelData(1);
  // repli de la traîne sur le début : la boucle s'enchaîne sans coupure (fondus gérés au mixage)
  for (let i = 0; i < N; i++) {
    const j = i < loopN ? i : i - loopN;
    L[j] += dryL[i] * 0.8 + revL[i] * spec.wet;
    R[j] += dryR[i] * 0.8 + revR[i] * spec.wet;
  }
  // grain de vinyle discret pour l'ambiance nostalgique
  if (spec.drums === 'lofi') {
    const rc = rng(7);
    for (let i = 0; i < loopN; i++) {
      const hiss = (rc() - 0.5) * 0.0025;
      const crackle = rc() < 0.00025 ? (rc() - 0.5) * 0.06 : 0;
      L[i] += hiss + crackle;
      R[i] += hiss + crackle * 0.8;
    }
  }
  let peak = 0;
  for (let i = 0; i < loopN; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) peak = a;
  }
  // normalisation puis saturation douce (limiteur)
  const k = peak > 0.0001 ? 1.15 / peak : 1;
  for (let i = 0; i < loopN; i++) {
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
