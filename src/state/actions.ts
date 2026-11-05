import { batch } from '@preact/signals';
import type { MediaItem, Project, ThemeId } from '../types';
import { analyzeFile, markDuplicates, mediaKindOf } from '../media/analyze';
import { makeDemo } from '../media/demo';
import { buildStory } from '../story/auto';
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
  const fresh = files.filter((f) => !known.has(`${f.file.name}|${f.file.size}|${f.file.lastModified}`));
  if (!fresh.length) {
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

export function clearMedia() {
  for (const m of media.value) if (m.thumb.startsWith('blob:')) URL.revokeObjectURL(m.thumb);
  batch(() => {
    media.value = [];
    updateProject({ clips: [] });
    selectedClip.value = null;
    playhead.value = 0;
  });
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
  const usableCount = media.value.filter((m) => !m.duplicateOf && !m.similarTo && !m.excluded && !m.error).length;
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
  toast(`Film créé : ${story.clips?.length ?? 0} plans, ${Math.round(timeline.value.total)} s.`, 'ok');
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
