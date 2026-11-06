import { batch } from '@preact/signals';
import type { MediaItem, MediaSource, Project, ThemeId } from '../types';
import { uid } from '../util';
import { analyzeFile, markDuplicates, mediaKindOf } from '../media/analyze';
import { junkReason, readSidecar, refineDates, sidecarKey } from '../media/dates';
import { DATES_VERSION, applyBest, collectDates, repairPhoto, sourceOfKey } from '../media/redate';
import { forgetThumb } from '../render/images';
import { invalidateThumb } from './persist';
import { ensurePermission, groupByRoot, newSource, pickFolderHandle, scanHandle, type ScanEntry } from '../media/sources';
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
  updateClip,
  sources,
  movedIds,
  datesDirty,
} from './store';

export interface ImportReport {
  added: number;
  dups: number;
  similar: number;
  skipped: number;
  inferred: number;
  errors: number;
}

/**
 * Importe des fichiers (médias + éventuels fichiers JSON Google Takeout), puis trie intelligemment :
 * dates affinées, captures d'écran écartées, doublons repérés, ordre chronologique.
 */
export async function importFiles(list: ScanEntry[], sourceId?: string, quiet = false): Promise<ImportReport | null> {
  const sidecarFiles = list.filter((f) => /\.json$/i.test(f.file.name));
  const files = list.filter((f) => mediaKindOf(f.file));
  if (!files.length) {
    if (!quiet) toast('Aucune photo ni vidéo trouvée dans la sélection.', 'warn');
    return null;
  }
  // ignore les fichiers déjà importés (même nom, taille et date)
  const sig = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
  const known = new Set(media.value.filter((m) => m.file).map((m) => sig(m.file!)));
  let fresh = files.filter((f) => !known.has(sig(f.file)));
  // fichiers absents d'un projet rouvert : on les réassocie (même nom, même taille)
  const missing = media.value.filter((m) => m.missing);
  let relinked = 0;
  if (missing.length) {
    fresh = fresh.filter((f) => {
      const m = missing.find((x) => x.missing && x.name === f.file.name && x.size === f.file.size);
      if (!m) return true;
      m.file = f.file;
      m.missing = false;
      if (sourceId) m.sourceId = sourceId;
      relinked++;
      return false;
    });
    if (relinked) {
      touchMedia();
      if (!quiet) toast(`${relinked} fichier(s) retrouvé(s) et réassocié(s) au projet.`, 'ok');
    }
  }
  if (!fresh.length) {
    if (!relinked && !quiet) toast('Ces fichiers sont déjà dans la médiathèque.', 'info');
    return { added: 0, dups: 0, similar: 0, skipped: 0, inferred: 0, errors: 0 };
  }
  // fichiers JSON de Google Takeout : date de prise de vue par média
  const sidecars = new Map<string, File>();
  for (const f of sidecarFiles) {
    const k = sidecarKey(f.path);
    if (k) sidecars.set(k, f.file);
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
        if (item) {
          item.sourceId = sourceId;
          const sc = sidecars.get(f.path.toLowerCase());
          if (sc && item.dateSource !== 'exif' && item.dateSource !== 'video') {
            const t = await readSidecar(sc);
            if (t) {
              item.date = t;
              item.dateSource = 'sidecar';
            }
          }
          results.push(item);
        }
        importing.value = { done: (importing.value?.done ?? 0) + 1, total: fresh.length, label: f.file.name };
        if (performance.now() - lastPush > 600) {
          lastPush = performance.now();
          media.value = [...media.value, ...results.splice(0)];
        }
      }
    }),
  );
  const freshFiles = new Set(fresh.map((f) => f.file));
  const all = [...media.value, ...results];
  const freshIds = new Set(all.filter((m) => m.file && freshFiles.has(m.file)).map((m) => m.id));
  const before = new Map(all.map((m) => [m.id, m.dateSource]));
  refineDates(all);
  let skipped = 0;
  if (importOpts.value.skipJunk) {
    for (const m of all) {
      if (!freshIds.has(m.id) || m.error) continue;
      const r = junkReason(m);
      if (r) {
        m.skipReason = r;
        m.excluded = true;
        skipped++;
      }
    }
  }
  markDuplicates(all, importOpts.value);
  all.sort((a, b) => a.date - b.date);
  batch(() => {
    media.value = all;
    importing.value = null;
    if (sourceId) sources.value = sources.value.map((s) => (s.id === sourceId ? { ...s, count: all.filter((m) => m.sourceId === sourceId).length, scannedAt: Date.now() } : s));
  });
  const fr = all.filter((m) => freshIds.has(m.id));
  const report: ImportReport = {
    added: fr.length,
    dups: fr.filter((m) => m.duplicateOf).length,
    similar: fr.filter((m) => m.similarTo).length,
    skipped,
    inferred: all.filter((m) => (m.dateSource === 'sequence' || m.dateSource === 'folder') && before.get(m.id) !== m.dateSource).length + fr.filter((m) => m.dateSource === 'sidecar').length,
    errors: fr.filter((m) => m.error).length,
  };
  if (!quiet) toast(reportText(report), report.errors ? 'warn' : 'ok', 6500);
  return report;
}

export function reportText(r: ImportReport, where = ''): string {
  return (
    `${r.added} média(s) ajouté(s)${where}` +
    (r.dups ? ` · ${r.dups} doublon(s) ignoré(s)` : '') +
    (r.similar ? ` · ${r.similar} quasi-doublon(s)` : '') +
    (r.skipped ? ` · ${r.skipped} capture(s)/miniature(s) écartée(s)` : '') +
    (r.inferred ? ` · ${r.inferred} date(s) retrouvée(s)` : '') +
    (r.errors ? ` · ${r.errors} illisible(s)` : '')
  );
}

// ---------- Dossiers sources ----------

async function importFromHandle(handle: FileSystemDirectoryHandle, existing?: MediaSource): Promise<ImportReport | null> {
  const src = existing ?? newSource(handle.name, handle);
  if (!existing) sources.value = [...sources.value, src];
  importing.value = { done: 0, total: 0, label: `Lecture du dossier « ${handle.name} »…` };
  const entries = await scanHandle(handle, (n) => (importing.value = { done: 0, total: 0, label: `Lecture de « ${handle.name} » : ${n} fichiers…` }));
  importing.value = null;
  // fichiers revenus ou disparus depuis la dernière lecture
  const byPath = new Map(entries.map((e) => [e.path, e]));
  let gone = 0;
  for (const m of media.value) {
    if (m.sourceId !== src.id) continue;
    const e = byPath.get(m.path);
    if (e) {
      if (!m.file || m.missing) {
        m.file = e.file;
        m.missing = false;
      }
      byPath.delete(m.path);
    } else if (!m.missing) {
      m.missing = true;
      gone++;
    }
  }
  touchMedia();
  const rest = [...byPath.values()];
  const report = rest.some((e) => mediaKindOf(e.file)) ? await importFiles(rest, src.id, true) : { added: 0, dups: 0, similar: 0, skipped: 0, inferred: 0, errors: 0 };
  sources.value = sources.value.map((s) => (s.id === src.id ? { ...s, count: media.value.filter((m) => m.sourceId === src.id).length, scannedAt: Date.now() } : s));
  if (gone) toast(`${gone} fichier(s) introuvable(s) dans « ${handle.name} » (déplacés ou supprimés).`, 'warn');
  return report;
}

/** Ajoute un dossier (sélecteur natif). Renvoie false si le navigateur ne le permet pas (repli sur <input>). */
export async function addFolderSource(): Promise<boolean> {
  let handle: FileSystemDirectoryHandle | null;
  try {
    handle = await pickFolderHandle();
  } catch {
    return true; // annulé
  }
  if (!handle) return false;
  for (const s of sources.value) {
    if (s.handle && (await s.handle.isSameEntry(handle))) {
      toast(`« ${handle.name} » est déjà un dossier source : actualisation.`, 'info');
      await rescanSource(s.id, true);
      return true;
    }
  }
  // dossier déjà connu du projet mais dont l'accès n'est plus mémorisé : on le rattache
  const orphan = sources.value.find((s) => !s.handle && s.name === handle!.name);
  if (orphan) sources.value = sources.value.map((s) => (s.id === orphan.id ? { ...s, handle: handle! } : s));
  const r = await importFromHandle(handle, orphan ? { ...orphan, handle } : undefined);
  if (r) toast(reportText(r, ` depuis « ${handle.name} »`), 'ok', 6500);
  return true;
}

/** Dossiers choisis via <input webkitdirectory> ou glisser-déposer classique : une source par dossier racine. */
export async function addPickedFolders(list: ScanEntry[]) {
  const groups = groupByRoot(list);
  for (const [root, entries] of groups) {
    if (!root) {
      await importFiles(entries);
      continue;
    }
    let src = sources.value.find((s) => !s.handle && s.name === root);
    if (!src) {
      src = newSource(root);
      sources.value = [...sources.value, src];
    }
    const r = await importFiles(entries, src.id, true);
    if (r) toast(reportText(r, ` depuis « ${root} »`), 'ok', 6500);
  }
}

/** Dossiers déposés avec accès mémorisable. */
export async function addDroppedHandles(handles: FileSystemHandle[]) {
  const loose: ScanEntry[] = [];
  for (const h of handles) {
    if (h.kind === 'directory') {
      const r = await importFromHandle(h as FileSystemDirectoryHandle);
      if (r) toast(reportText(r, ` depuis « ${h.name} »`), 'ok', 6500);
    } else {
      const f = await (h as FileSystemFileHandle).getFile();
      loose.push({ file: f, path: f.name });
    }
  }
  if (loose.length) await importFiles(loose);
}

/** Relit un dossier source : nouveaux fichiers importés, fichiers disparus signalés. */
export async function rescanSource(id: string, ask: boolean): Promise<ImportReport | null> {
  const src = sources.value.find((s) => s.id === id);
  if (!src?.handle) {
    if (ask) toast('Ce dossier a été ajouté sans accès mémorisé : ajoutez-le à nouveau pour l’actualiser.', 'warn');
    return null;
  }
  if (!(await ensurePermission(src.handle, ask))) {
    if (ask) toast(`Accès à « ${src.name} » refusé.`, 'warn');
    return null;
  }
  const r = await importFromHandle(src.handle, src);
  if (r && ask) toast(r.added ? reportText(r, ` dans « ${src.name} »`) : `« ${src.name} » est à jour.`, 'ok', 5000);
  return r;
}

/** Actualise toutes les sources accessibles (silencieux sauf nouveautés). */
export async function rescanAll(ask: boolean) {
  let added = 0;
  for (const s of sources.value) {
    if (!s.handle) continue;
    const r = await rescanSource(s.id, ask);
    added += r?.added ?? 0;
  }
  if (!ask && added) toast(`${added} nouveau(x) média(s) trouvé(s) dans vos dossiers.`, 'ok', 5000);
}

/** Retire un dossier source et ses médias (et les plans qui les utilisent). */
export function removeSource(id: string) {
  const gone = new Set(media.value.filter((m) => m.sourceId === id).map((m) => m.id));
  batch(() => {
    media.value = media.value.filter((m) => !gone.has(m.id));
    sources.value = sources.value.filter((s) => s.id !== id);
    const p = project.value;
    const clips = p.clips
      .filter((c) => !c.mediaId || !gone.has(c.mediaId) || c.type === 'title')
      .map((c) => (c.extra?.length ? { ...c, extra: c.extra.filter((x) => !gone.has(x)) } : c))
      .map((c) => (c.type === 'title' && c.mediaId && gone.has(c.mediaId) ? { ...c, mediaId: null, background: 'gradient' as const } : c));
    if (clips.length !== p.clips.length || gone.size) commit({ ...p, clips });
  });
  recomputeDuplicates();
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
  if (!m.excluded) m.skipReason = undefined;
  touchMedia();
}

/** Force l'inclusion d'un quasi-doublon / doublon. */
export function forceInclude(id: string) {
  const m = mediaMap.value.get(id);
  if (!m) return;
  m.duplicateOf = null;
  m.similarTo = null;
  m.excluded = false;
  m.skipReason = undefined;
  touchMedia();
}

/** Corrige la date d'un média (et donc sa place dans la chronologie). */
export function setMediaDate(id: string, date: number) {
  const m = mediaMap.value.get(id);
  if (!m || !isFinite(date)) return;
  m.date = date;
  m.dateSource = 'manual';
  afterDateChange(undefined, [id]);
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
  datesDirty.value = false;
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
    datesDirty.value = false;
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
      if (!force && cur && (cur as AudioBuffer & { mood?: string }).mood === p.music.mood) return;
      const { buffer, bpm } = await generateMusic(p.music.mood, total);
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

// ---------- Mosaïques ----------
const isPhotoClip = (c: import('../types').Clip | undefined) => {
  const m = c?.mediaId ? mediaMap.value.get(c.mediaId) : undefined;
  return !!c && c.type === 'media' && m?.kind === 'photo';
};
const idsOf = (c: import('../types').Clip) => [c.mediaId!, ...(c.extra ?? [])];

/** Assemble le plan `sourceId` dans le plan `targetId` (4 photos au maximum). */
export function mergeClips(targetId: string, sourceId: string): boolean {
  const p = project.value;
  const t = p.clips.find((c) => c.id === targetId);
  const s = p.clips.find((c) => c.id === sourceId);
  if (!t || !s || t === s || !isPhotoClip(t) || !isPhotoClip(s)) {
    toast('Seules des photos peuvent être assemblées sur une même image.', 'warn');
    return false;
  }
  const ids = [...idsOf(t), ...idsOf(s)];
  if (ids.length > 4) {
    toast('Une image peut réunir 4 photos au maximum.', 'warn');
    return false;
  }
  // ordre chronologique dans la mosaïque
  ids.sort((a, b) => (mediaMap.value.get(a)?.date ?? 0) - (mediaMap.value.get(b)?.date ?? 0));
  const merged = { ...t, mediaId: ids[0], extra: ids.slice(1), layout: null, motion: 'none' as const, duration: Math.max(t.duration, s.duration) + 0.6 };
  commit({ ...p, clips: p.clips.filter((c) => c.id !== sourceId).map((c) => (c.id === targetId ? merged : c)) });
  selectedClip.value = targetId;
  toast(`${ids.length} photos réunies sur une même image.`, 'ok', 2000);
  return true;
}

export function mergeWithNext(clipId: string) {
  const p = project.value;
  const i = p.clips.findIndex((c) => c.id === clipId);
  const next = p.clips.slice(i + 1).find((c) => isPhotoClip(c));
  if (!next || p.clips[i + 1]?.id !== next.id) return toast('Le plan suivant n’est pas une photo.', 'warn');
  mergeClips(clipId, next.id);
}

/** Sépare une mosaïque en plans individuels. */
export function splitCollage(clipId: string) {
  const p = project.value;
  const i = p.clips.findIndex((c) => c.id === clipId);
  const c = p.clips[i];
  if (!c?.extra?.length) return;
  const ids = idsOf(c);
  const d = Math.max(1.5, c.duration / ids.length + 0.8);
  const parts = ids.map((id, k) => {
    const m = mediaMap.value.get(id)!;
    return {
      ...c,
      id: k === 0 ? c.id : uid(),
      mediaId: id,
      extra: undefined,
      layout: null,
      duration: d,
      motion: 'auto' as const,
      fit: m.height > m.width * 1.05 ? ('blur' as const) : ('cover' as const),
      title: k === 0 ? c.title : null,
      transition: k === 0 ? c.transition : ('fade' as const),
      transitionDuration: k === 0 ? c.transitionDuration : 0.6,
    };
  });
  const clips = [...p.clips];
  clips.splice(i, 1, ...parts);
  commit({ ...p, clips });
}

/** Retire une photo d'une mosaïque ; elle devient un plan à part, juste après. */
export function detachFromCollage(clipId: string, mediaId: string) {
  const p = project.value;
  const i = p.clips.findIndex((c) => c.id === clipId);
  const c = p.clips[i];
  if (!c?.extra?.length) return;
  const rest = idsOf(c).filter((id) => id !== mediaId);
  const m = mediaMap.value.get(mediaId)!;
  const kept = { ...c, mediaId: rest[0], extra: rest.slice(1), layout: rest.length > 1 ? c.layout : null, motion: rest.length > 1 ? c.motion : ('auto' as const) };
  const solo = { ...c, id: uid(), mediaId, extra: undefined, layout: null, title: null, motion: 'auto' as const, fit: m.height > m.width * 1.05 ? ('blur' as const) : ('cover' as const), transition: 'fade' as const, transitionDuration: 0.6, duration: Math.max(2, c.duration * 0.6) };
  const clips = [...p.clips];
  clips.splice(i, 1, kept, solo);
  commit({ ...p, clips });
}

/** Change la photo de place à l'intérieur de la mosaïque. */
export function shiftInCollage(clipId: string, mediaId: string, dir: -1 | 1) {
  const p = project.value;
  const c = p.clips.find((x) => x.id === clipId);
  if (!c) return;
  const ids = idsOf(c);
  const i = ids.indexOf(mediaId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  updateClip(clipId, { mediaId: ids[0], extra: ids.slice(1) });
}

/** Regroupe à nouveau les photos de tout le montage selon le réglage de mosaïque. */
export function regroupCollages(mode: 'off' | 'auto' | 'more') {
  const p = { ...project.value, collage: mode };
  commit({ ...p, ...buildStory(media.value, p, importOpts.value.chapterGapHours), title: p.title, subtitle: p.subtitle });
}

// ---------- Dates : relecture, choix d'une source, décalage d'un dossier ----------
const dirOf = (m: MediaItem) => (m.sourceId ?? '') + '|' + m.path.split('/').slice(0, -1).join('/');

/** Médias du même dossier (même source, même sous-dossier). */
export function sameFolder(m: MediaItem): MediaItem[] {
  const d = dirOf(m);
  return media.value.filter((x) => dirOf(x) === d);
}

function afterDateChange(msg?: string, moved: string[] = []) {
  refineDates(media.value);
  markDuplicates(media.value, importOpts.value);
  batch(() => {
    media.value = [...media.value].sort((a, b) => a.date - b.date);
    if (moved.length) movedIds.value = moved;
    if (moved.length && project.value.clips.some((c) => c.mediaId && moved.includes(c.mediaId))) datesDirty.value = true;
  });
  if (msg) toast(msg, 'ok', 5000);
}

/** Relit les dates dans les fichiers (projets créés avant l'amélioration, ou à la demande). */
export async function rereadDates(onlyMissing: boolean) {
  const list = media.value.filter((m) => m.file && !m.demo && (!onlyMissing || !m.dates || (m.datesV ?? 1) < DATES_VERSION));
  if (!list.length) return;
  importing.value = { done: 0, total: list.length, label: 'Relecture des dates…' };
  let changed = 0,
    repaired = 0;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    try {
      const before = m.datesV ?? 1;
      if (applyBest(m, await collectDates(m.file!, m.kind))) changed++;
      // projets antérieurs : photos aux proportions faussées (vignette et dimensions réparées)
      if (before < 3 && (await repairPhoto(m))) {
        repaired++;
        forgetThumb(m.id);
        invalidateThumb(m.id);
      }
    } catch {
      /* fichier illisible */
    }
    if (i % 20 === 0) importing.value = { done: i, total: list.length, label: 'Relecture des dates…' };
  }
  importing.value = null;
  if (repaired) toast(`${repaired} photo(s) aux proportions faussées réparée(s).`, 'ok', 6000);
  afterDateChange(changed ? `Dates relues dans les fichiers : ${changed} média(s) redaté(s).` : onlyMissing ? undefined : 'Dates relues : aucune modification.');
}

/** Utilise une date trouvée dans le fichier ; avec `folder`, le même type de date pour tout le dossier. */
export function useDateCandidate(id: string, key: string, folder: boolean) {
  const m = mediaMap.value.get(id);
  if (!m) return;
  const targets = folder ? sameFolder(m) : [m];
  let n = 0;
  for (const x of targets) {
    const c = x.dates?.find((d) => d.key === key);
    if (!c) continue;
    x.date = c.t;
    // choix explicite : une date fiable garde son origine, une date faible devient « corrigée » (plus d'écrasement automatique)
    const src = sourceOfKey(key, x.kind);
    x.dateSource = src === 'exif' || src === 'video' ? src : 'manual';
    n++;
  }
  afterDateChange(folder ? `${n} média(s) du dossier redaté(s) avec « ${m.dates?.find((d) => d.key === key)?.label} ».` : undefined, targets.map((x) => x.id));
}

/** Décale toutes les dates d'un dossier pour que `id` soit à `correct` (horloge d'appareil mal réglée). */
export function shiftFolderDates(id: string, correct: number) {
  const m = mediaMap.value.get(id);
  if (!m || !isFinite(correct)) return;
  const delta = correct - m.date;
  const list = sameFolder(m);
  for (const x of list) {
    x.date += delta;
    x.dateSource = 'manual';
  }
  const days = Math.round(Math.abs(delta) / 86_400_000);
  const hours = Math.round((Math.abs(delta) % 86_400_000) / 3_600_000);
  afterDateChange(`${list.length} média(s) décalé(s) de ${delta < 0 ? '−' : '+'}${days ? days + ' j ' : ''}${hours} h.`, list.map((x) => x.id));
}

/** Vide le montage (annulable). */
export function clearMontage() {
  const p = project.value;
  commit({ ...p, clips: [] });
  selectedClip.value = null;
  playhead.value = 0;
  datesDirty.value = false;
  toast('Montage vidé (Ctrl+Z pour annuler).', 'info', 3500);
}

/** Définit le point d'entrée ou de sortie (temps source, s) d'un plan vidéo. */
export function setVideoBounds(clipId: string, inT: number | null, outT: number | null) {
  const p = project.value;
  const c = p.clips.find((x) => x.id === clipId);
  const m = c?.mediaId ? mediaMap.value.get(c.mediaId) : undefined;
  if (!c || m?.kind !== 'video') return;
  const curOut = c.trimIn + c.duration * c.speed;
  let a = inT ?? c.trimIn,
    b = outT ?? curOut;
  a = Math.max(0, Math.min(a, m.duration - 0.2));
  b = Math.max(a + 0.2, Math.min(b, m.duration));
  updateClip(clipId, { trimIn: Math.round(a * 100) / 100, duration: Math.round(((b - a) / c.speed) * 100) / 100 });
}
