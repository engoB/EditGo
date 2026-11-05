import { batch } from '@preact/signals';
import type { MediaItem, Project, ThemeId } from '../types';
import { analyzeFile, markDuplicates, mediaKindOf } from '../media/analyze';
import { makeDemo } from '../media/demo';
import { buildStory, usable } from '../story/auto';
import { retime } from '../story/retime';
import { THEMES } from '../presets';
import { estimateBpm, generateMusic, MOODS } from '../audio/music';
import {
  commit,
  importOpts,
  importing,
  media,
  mediaMap,
  musicBuffer,
  musicBusy,
  musicFile,
  page,
  playhead,
  project,
  selectedClip,
  timeline,
  toast,
  touchMedia,
  updateProject,
} from './store';

export async function importFiles(list: { file: File; path: string }[]) {
  const files = list.filter((f) => mediaKindOf(f.file));
  if (!files.length) {
    toast('Aucune photo ni vidéo trouvée dans la sélection.', 'warn');
    return;
  }
  // ignore les fichiers déjà importés (même nom, taille et date)
  const known = new Set(media.value.map((m) => (m.file ? `${m.file.name}|${m.file.size}|${m.file.lastModified}` : '')));
  let fresh = files.filter((f) => !known.has(`${f.file.name}|${f.file.size}|${f.file.lastModified}`));
  // fichiers absents d'un projet rouvert : on les réassocie (même nom, même taille)
  const missing = media.value.filter((m) => m.missing);
  let relinked = 0;
  if (missing.length) {
    fresh = fresh.filter((f) => {
      const m = missing.find((x) => x.missing && x.name === f.file.name && x.size === f.file.size);
      if (!m) return true;
      m.file = f.file;
      m.missing = false;
      relinked++;
      return false;
    });
    if (relinked) {
      touchMedia();
      toast(`${relinked} fichier(s) retrouvé(s) et réassocié(s) au projet.`, 'ok');
    }
  }
  if (!fresh.length) {
    if (relinked) return;
    toast('Ces fichiers sont déjà dans la médiathèque.', 'info');
    return;
  }
  importing.value = { done: 0, total: fresh.length, label: 'Analyse des médias…' };
  const results: MediaItem[] = [];
  let i = 0;
  const workers = Math.min(navigator.hardwareConcurrency > 4 ? 4 : 2, fresh.length);
  let lastPush = performance.now();
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (i < fresh.length) {
        const f = fresh[i++];
        const item = await analyzeFile(f.file, f.path).catch(() => null);
        if (item) results.push(item);
        importing.value = { done: (importing.value?.done ?? 0) + 1, total: fresh.length, label: f.file.name };
        if (performance.now() - lastPush > 600) {
          lastPush = performance.now();
          media.value = [...media.value, ...results.splice(0)];
        }
      }
    }),
  );
  const all = [...media.value, ...results];
  markDuplicates(all, importOpts.value);
  all.sort((a, b) => a.date - b.date);
  batch(() => {
    media.value = all;
    importing.value = null;
  });
  const dups = all.filter((m) => m.duplicateOf).length;
  const sim = all.filter((m) => m.similarTo).length;
  const errs = all.filter((m) => m.error).length;
  toast(
    `${fresh.length} fichier(s) analysé(s)` + (dups ? ` · ${dups} doublon(s) ignoré(s)` : '') + (sim ? ` · ${sim} quasi-doublon(s)` : '') + (errs ? ` · ${errs} illisible(s)` : ''),
    errs ? 'warn' : 'ok',
    5200,
  );
}

export function loadDemo() {
  const items = makeDemo();
  markDuplicates(items, importOpts.value);
  media.value = [...media.value, ...items].sort((a, b) => a.date - b.date);
  toast('Démo chargée : 1 doublon strict et une rafale détectés automatiquement.', 'ok', 5000);
}

export function recomputeDuplicates() {
  markDuplicates(media.value, importOpts.value);
  touchMedia();
}

export function toggleExcluded(id: string) {
  const m = mediaMap.value.get(id);
  if (!m) return;
  m.excluded = !m.excluded;
  touchMedia();
}

/** Force l'inclusion d'un quasi-doublon / doublon. */
export function forceInclude(id: string) {
  const m = mediaMap.value.get(id);
  if (!m) return;
  m.duplicateOf = null;
  m.similarTo = null;
  m.excluded = false;
  touchMedia();
}

/** Corrige la date d'un média (et donc sa place dans la chronologie). */
export function setMediaDate(id: string, date: number) {
  const m = mediaMap.value.get(id);
  if (!m || !isFinite(date)) return;
  m.date = date;
  m.dateSource = 'manual';
  media.value = [...media.value].sort((a, b) => a.date - b.date);
}

/** Déplace un plan à sa place chronologique dans le montage (cartons d'ouverture et de fin inchangés). */
export function placeClipByDate(clipId: string) {
  const p = project.value;
  const clips = [...p.clips];
  const from = clips.findIndex((c) => c.id === clipId);
  const c = clips[from];
  const m = c?.mediaId ? mediaMap.value.get(c.mediaId) : undefined;
  if (!c || !m || c.type !== 'media') return;
  clips.splice(from, 1);
  let to = clips.length;
  if (clips[to - 1]?.type === 'title') to--;
  for (let i = 0; i < clips.length; i++) {
    const o = clips[i];
    const om = o.mediaId ? mediaMap.value.get(o.mediaId) : undefined;
    if (o.type === 'media' && om && om.date > m.date) {
      to = i;
      break;
    }
  }
  clips.splice(to, 0, c);
  commit({ ...p, clips });
  if (to !== from) toast(`Plan replacé en position ${to + 1} selon sa date.`, 'ok', 2200);
  else toast('Ce plan est déjà à sa place chronologique.', 'info', 2200);
}

/** Remet tous les plans dans l'ordre chronologique. */
export function sortClipsByDate() {
  const p = project.value;
  const mm = mediaMap.value;
  const head = p.clips[0]?.type === 'title' ? [p.clips[0]] : [];
  const tail = p.clips.length > 1 && p.clips[p.clips.length - 1].type === 'title' ? [p.clips[p.clips.length - 1]] : [];
  const mid = p.clips.slice(head.length, p.clips.length - tail.length);
  const dateOf = (i: number) => {
    // un carton intermédiaire suit le plan qui le précède
    for (let j = i; j >= 0; j--) {
      const m = mid[j].mediaId ? mm.get(mid[j].mediaId!) : undefined;
      if (mid[j].type === 'media' && m) return m.date + (i - j) * 1e-3;
    }
    return -Infinity;
  };
  const order = mid.map((c, i) => ({ c, d: dateOf(i), i })).sort((a, b) => a.d - b.d || a.i - b.i);
  commit({ ...p, clips: [...head, ...order.map((o) => o.c), ...tail] });
  toast('Montage remis dans l’ordre chronologique.', 'ok', 2200);
}

/** Déplace un plan d'un cran (dir = -1 : plus tôt, +1 : plus tard). */
export function nudgeClip(clipId: string, dir: -1 | 1) {
  const p = project.value;
  const i = p.clips.findIndex((c) => c.id === clipId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= p.clips.length) return;
  const clips = [...p.clips];
  [clips[i], clips[j]] = [clips[j], clips[i]];
  commit({ ...p, clips });
}

/** Place un plan à une position donnée (0 = début). */
export function moveClipTo(clipId: string, index: number) {
  const p = project.value;
  const i = p.clips.findIndex((c) => c.id === clipId);
  if (i < 0) return;
  const clips = [...p.clips];
  const [c] = clips.splice(i, 1);
  clips.splice(Math.max(0, Math.min(clips.length, index)), 0, c);
  commit({ ...p, clips });
}

/** Allonge ou raccourcit tout le film. */
export function retimeFilm(target: number, base?: import('../types').Clip[], history = true) {
  const p = project.value;
  const clips = retime(base ?? p.clips, mediaMap.value, target);
  if (history) commit({ ...p, clips });
  else project.value = { ...p, clips };
}

export function applyTheme(id: ThemeId, rebuild = true) {
  const th = THEMES[id];
  const p = project.value;
  const next: Project = {
    ...p,
    theme: id,
    look: th.look,
    lookIntensity: th.lookIntensity,
    grain: th.grain,
    vignette: th.vignette,
    bloom: th.bloom,
    letterbox: th.letterbox,
    photoDuration: th.photoDuration,
    music: { ...p.music, mood: p.music.kind === 'generated' ? th.mood : p.music.mood, bpm: p.music.kind === 'generated' ? MOODS[th.mood].bpm : p.music.bpm },
  };
  if (rebuild && p.clips.length) {
    Object.assign(next, buildStory(media.value, next, importOpts.value.chapterGapHours));
  }
  commit(next);
  if (next.music.kind === 'generated' && next.music.mood !== p.music.mood) void prepareMusic(true);
}

export async function autoCreate() {
  const usableCount = media.value.filter(usable).length;
  if (!usableCount) {
    toast('Importez d’abord des photos ou des vidéos.', 'warn');
    return;
  }
  const p = project.value;
  const story = buildStory(media.value, { ...p, title: '', subtitle: '' }, importOpts.value.chapterGapHours);
  batch(() => {
    commit({ ...p, ...story, title: p.title || story.title || '', subtitle: p.subtitle || story.subtitle || '' });
    page.value = 'edit';
    playhead.value = 0;
    selectedClip.value = null;
  });
  await prepareMusic();
  const t = Math.round(timeline.value.total);
  toast(
    `Film créé : ${story.clips?.length ?? 0} plans, ${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')}` +
      (p.buildMode === 'all' ? ' (tous les médias). Ajustez la durée dans « Style ».' : '.'),
    'ok',
    5000,
  );
}

/** Regénère le montage en gardant le titre. */
export function rebuildStory() {
  const p = project.value;
  commit({ ...p, ...buildStory(media.value, p, importOpts.value.chapterGapHours), title: p.title, subtitle: p.subtitle });
}

let musicJob = 0;
/** Prépare la piste musicale (génération ou décodage) pour l'aperçu et l'export. */
export async function prepareMusic(force = false) {
  const p = project.value;
  const total = timeline.value.total;
  if (p.music.kind === 'none') {
    musicBuffer.value = null;
    return;
  }
  if (p.music.kind === 'file') {
    if (!musicFile.value) return;
    if (musicBuffer.value && !force) return;
  }
  const job = ++musicJob;
  musicBusy.value = true;
  try {
    if (p.music.kind === 'generated') {
      const cur = musicBuffer.value;
      if (!force && cur && cur.duration >= total + 1 && (cur as AudioBuffer & { mood?: string }).mood === p.music.mood) return;
      const { buffer, bpm } = await generateMusic(p.music.mood, Math.max(30, total + 8));
      if (job !== musicJob) return;
      (buffer as AudioBuffer & { mood?: string }).mood = p.music.mood;
      musicBuffer.value = buffer;
      if (bpm !== project.value.music.bpm) updateProject((q) => ({ music: { ...q.music, bpm } }), false);
    } else {
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      const buf = await ctx.decodeAudioData(await musicFile.value!.arrayBuffer());
      if (job !== musicJob) return;
      musicBuffer.value = buf;
      const { bpm, offset } = estimateBpm(buf);
      updateProject((q) => ({ music: { ...q.music, bpm, offset: q.music.offset || offset } }), false);
      toast(`Musique analysée : tempo ≈ ${bpm} BPM`, 'ok');
    }
  } catch (e) {
    toast('Musique : ' + ((e as Error).message || 'échec du décodage'), 'error');
  } finally {
    if (job === musicJob) musicBusy.value = false;
  }
}

export async function setMusicFile(f: File) {
  musicFile.value = f;
  musicBuffer.value = null;
  updateProject((p) => ({ music: { ...p.music, kind: 'file', fileName: f.name, offset: 0 } }));
  await prepareMusic(true);
}
