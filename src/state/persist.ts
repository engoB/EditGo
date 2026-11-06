// Sauvegarde des projets sur l'appareil.
//  - IndexedDB : liste des projets (métadonnées) et contenu (montage, médias, réglages) ;
//  - Origin Private File System (ou IndexedDB en repli) : copie des fichiers médias,
//    dédupliquée par empreinte, pour rouvrir un projet sans réimporter.
import { batch, effect, signal } from '@preact/signals';
import type { ImportOptions, MediaItem, MediaSource, Project } from '../types';
import { ensurePermission, resolveInSource } from '../media/sources';
import { importOpts, media, musicBuffer, musicFile, page, playhead, project, resetHistory, selectedClip, sources, timeline, defaultProject } from './store';
import { demoDrawer } from '../media/demo';
import { safeTransition } from '../presets';
import { uid } from '../util';

export interface ProjectMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
  duration: number;
  mediaCount: number;
  clipCount: number;
  cover: Blob | null;
}

type StoredMedia = Omit<MediaItem, 'file' | 'demo' | 'thumb'> & {
  fileKey: string | null;
  fileType: string;
  lastModified: number;
  /** Anciens projets uniquement : vignette intégrée (désormais rangée à part, une seule fois). */
  thumbBlob?: Blob | null;
};

interface ProjectData {
  id: string;
  project: Project;
  importOpts: ImportOptions;
  media: StoredMedia[];
  music: { key: string; name: string; type: string } | null;
  sources?: MediaSource[];
}

export const currentProjectId = signal<string | null>(null);
export const saveState = signal<'idle' | 'saving' | 'saved' | 'error'>('idle');
export const saveProgress = signal<{ done: number; total: number } | null>(null);
/** Heure du dernier enregistrement réussi. */
export const savedAt = signal<number>(0);
export const projectsRev = signal(0);
/** Dossiers mémorisés dont l'accès doit être réautorisé (clic requis par le navigateur). */
export const pendingAccess = signal<MediaSource[]>([]);
const DEFAULT_OPTS: ImportOptions = { nearDuplicates: true, similarity: 8, chapterGapHours: 4, skipJunk: true };

// ---------- IndexedDB ----------
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('editgo', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const [n, k] of [['meta', 'id'], ['data', 'id'], ['blobs', ''], ['handles', '']] as const)
        if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, k ? { keyPath: k } : undefined);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function store(name: 'meta' | 'data' | 'blobs' | 'handles', mode: IDBTransactionMode = 'readonly') {
  return (await db()).transaction(name, mode).objectStore(name);
}

// ---------- Fichiers médias ----------
const keyOf = (m: MediaItem) => (m.hash ? m.hash.replace(/[^a-z0-9]/gi, '-').slice(0, 120) : `${m.size}-${m.name}`.replace(/[^a-z0-9.]/gi, '-'));

async function opfsDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    const dir = await root.getDirectoryHandle('media', { create: true });
    // l'écriture nécessite createWritable (Chrome, Edge, Firefox, Safari récents)
    const probe = await dir.getFileHandle('.probe', { create: true });
    if (!('createWritable' in probe)) return null;
    return dir;
  } catch {
    return null;
  }
}
let dirp: Promise<FileSystemDirectoryHandle | null> | null = null;
const mediaDir = () => (dirp ??= opfsDir());
const persisted = new Set<string>();

async function hasBlob(key: string): Promise<boolean> {
  if (persisted.has(key)) return true;
  const dir = await mediaDir();
  try {
    if (dir) {
      const f = await (await dir.getFileHandle(key)).getFile();
      if (f.size > 0) {
        persisted.add(key);
        return true;
      }
      return false;
    }
    const n = await req((await store('blobs')).count(key));
    if (n) persisted.add(key);
    return n > 0;
  } catch {
    return false;
  }
}

async function putBlob(key: string, blob: Blob) {
  if (await hasBlob(key)) return;
  const dir = await mediaDir();
  if (dir) {
    const h = await dir.getFileHandle(key, { create: true });
    const w = await (h as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    await w.write(blob);
    await w.close();
  } else {
    await req((await store('blobs', 'readwrite')).put(blob, key));
  }
  persisted.add(key);
}

async function getBlob(key: string): Promise<Blob | null> {
  const dir = await mediaDir();
  try {
    if (dir) {
      const f = await (await dir.getFileHandle(key)).getFile();
      return f.size ? f : null;
    }
    return ((await req((await store('blobs')).get(key))) as Blob | undefined) ?? null;
  } catch {
    return null;
  }
}

async function deleteBlob(key: string) {
  persisted.delete(key);
  const dir = await mediaDir();
  try {
    if (dir) await dir.removeEntry(key);
    else await req((await store('blobs', 'readwrite')).delete(key));
  } catch {
    /* déjà absent */
  }
}

// ---------- Sérialisation ----------
const thumbCache = new Map<string, Blob>();
async function thumbBlob(m: MediaItem): Promise<Blob | null> {
  if (!m.thumb) return null;
  const hit = thumbCache.get(m.thumb);
  if (hit) return hit;
  try {
    const b = await (await fetch(m.thumb)).blob();
    thumbCache.set(m.thumb, b);
    return b;
  } catch {
    return null;
  }
}

async function serializeMedia(items: MediaItem[]): Promise<StoredMedia[]> {
  return Promise.all(
    items.map(async (m) => {
      const { file, demo: _demo, thumb: _thumb, ...rest } = m;
      void _demo;
      void _thumb;
      return {
        ...rest,
        fileKey: file ? keyOf(m) : null,
        fileType: file?.type ?? '',
        lastModified: file?.lastModified ?? 0,
      };
    }),
  );
}

/** Vignettes rangées à part, écrites une seule fois par média (et non à chaque enregistrement). */
const thumbSaved = new Set<string>();
async function saveThumbs(items: MediaItem[]) {
  const todo = items.filter((m) => m.thumb && !thumbSaved.has(m.id));
  if (!todo.length) return;
  const blobs = await Promise.all(todo.map((m) => thumbBlob(m)));
  const d = await db();
  await new Promise<void>((res, rej) => {
    const tx = d.transaction('blobs', 'readwrite');
    todo.forEach((m, i) => blobs[i] && tx.objectStore('blobs').put(blobs[i], 'thumb:' + m.id));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  for (const m of todo) thumbSaved.add(m.id);
}

async function coverOf(items: MediaItem[]): Promise<Blob | null> {
  const best = [...items].filter((m) => m.thumb && !m.duplicateOf && !m.similarTo && !m.error).sort((a, b) => b.score - a.score)[0];
  return best ? thumbBlob(best) : null;
}

/** Mise à niveau des anciens projets (transitions retirées → fondu enchaîné). */
function migrateProject(p: Project): Project {
  return { ...p, clips: p.clips.map((c) => ({ ...c, transition: safeTransition(c.transition) })) };
}

// ---------- API ----------
export async function listProjects(): Promise<ProjectMeta[]> {
  try {
    const all = (await req((await store('meta')).getAll())) as ProjectMeta[];
    return all.sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

let saving: Promise<void> | null = null;
let again = false;

/** Enregistre le projet courant (crée l'entrée au premier enregistrement). */
export async function saveCurrent(): Promise<void> {
  if (saving) {
    again = true;
    return saving;
  }
  saving = (async () => {
    do {
      again = false;
      await doSave();
    } while (again);
  })().finally(() => (saving = null));
  return saving;
}

async function doSave() {
  const items = media.value;
  if (!items.length && !project.value.clips.length) return;
  saveState.value = 'saving';
  try {
    void navigator.storage?.persist?.();
    const id = currentProjectId.value ?? uid();
    const p = project.value;
    const now = Date.now();
    const prevMeta = (await req((await store('meta')).get(id))) as ProjectMeta | undefined;
    const data: ProjectData = {
      id,
      project: p,
      importOpts: importOpts.value,
      media: await serializeMedia(items),
      sources: sources.value.map(({ handle: _h, ...x }) => (void _h, { ...x, linked: !!_h })),
      music: musicFile.value ? { key: 'music-' + musicFile.value.size + '-' + musicFile.value.name.replace(/[^a-z0-9.]/gi, '-'), name: musicFile.value.name, type: musicFile.value.type } : null,
    };
    const meta: ProjectMeta = {
      id,
      name: p.title || prevMeta?.name || 'Projet du ' + new Date(now).toLocaleDateString('fr-FR'),
      created: prevMeta?.created ?? now,
      updated: now,
      duration: timeline.value.total,
      mediaCount: items.length,
      clipCount: p.clips.length,
      cover: await coverOf(items),
    };
    const d = await db();
    await new Promise<void>((res, rej) => {
      const tx = d.transaction(['meta', 'data', 'handles'], 'readwrite');
      tx.objectStore('meta').put(meta);
      tx.objectStore('data').put(data);
      // accès aux dossiers : rangés à part, relus seulement à l'ouverture du projet
      for (const x of sources.value) if (x.handle) tx.objectStore('handles').put(x.handle, id + ':' + x.id);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    if (!currentProjectId.value) currentProjectId.value = id;
    await saveThumbs(items);
    projectsRev.value++;
    saveState.value = 'saved';
    savedAt.value = Date.now();
    void copyMedia(items, data.music ? data.music.key : null);
  } catch (e) {
    console.error(e);
    saveProgress.value = null;
    saveState.value = 'error';
  }
}

/**
 * Copie de sécurité des médias qui ne peuvent pas être relus autrement (fichiers importés un par un,
 * dossiers sans accès mémorisé). Les dossiers mémorisés ne sont jamais recopiés, ni les fichiers de plus de 150 Mo.
 */
let copying = false;
async function copyMedia(items: MediaItem[], musicKey: string | null) {
  if (copying) return;
  copying = true;
  try {
    if (musicKey && musicFile.value) await putBlob(musicKey, musicFile.value);
    const linked = new Set(sources.value.filter((x) => x.handle).map((x) => x.id));
    const todo = items.filter((m) => m.file && m.file.size <= 150 * 1024 * 1024 && !(m.sourceId && linked.has(m.sourceId)) && !persisted.has(keyOf(m)));
    for (let i = 0; i < todo.length; i++) {
      saveProgress.value = { done: i, total: todo.length };
      if (!(await hasBlob(keyOf(todo[i])))) await putBlob(keyOf(todo[i]), todo[i].file!);
    }
  } catch (e) {
    console.error(e);
  } finally {
    saveProgress.value = null;
    copying = false;
  }
}

async function restoreMedia(list: StoredMedia[], srcs: MediaSource[] = []): Promise<MediaItem[]> {
  const thumbs = new Map<string, Blob>();
  try {
    const st = await store('blobs');
    await Promise.all(
      list.map(async (x) => {
        if (x.thumbBlob) return;
        const b = (await req(st.get('thumb:' + x.id))) as Blob | undefined;
        if (b) {
          thumbs.set(x.id, b);
          thumbSaved.add(x.id);
        }
      }),
    );
  } catch {
    /* vignettes indisponibles */
  }
  const granted = new Map<string, boolean>();
  for (const x of srcs) if (x.handle) granted.set(x.id, await ensurePermission(x.handle, false));
  return Promise.all(
    list.map(async (s) => {
      const { fileKey, fileType, lastModified, thumbBlob: tb0, ...rest } = s;
      const tb = tb0 ?? thumbs.get(s.id) ?? null;
      const item: MediaItem = { ...rest, file: null, thumb: tb ? URL.createObjectURL(tb) : '' };
      if (tb) thumbCache.set(item.thumb, tb);
      const src = s.sourceId ? srcs.find((x) => x.id === s.sourceId) : undefined;
      if (s.demoSpec) item.demo = demoDrawer(s.demoSpec, s.width, s.height);
      else if (src?.handle && granted.get(src.id) && (item.file = await resolveInSource(src.handle, s.path))) {
        item.missing = false;
      } else if (fileKey) {
        const b = await getBlob(fileKey);
        if (b) {
          persisted.add(fileKey);
          item.file = new File([b], s.name, { type: fileType || b.type, lastModified });
          item.missing = false;
        } else {
          item.missing = true;
        }
      }
      return item;
    }),
  );
}

export async function openProject(id: string) {
  const data = (await req((await store('data')).get(id))) as ProjectData | undefined;
  if (!data) throw new Error('Projet introuvable');
  const srcs = await attachHandles(id, data.sources ?? []);
  const items = await restoreMedia(data.media, srcs);
  let mfile: File | null = null;
  if (data.music) {
    const b = await getBlob(data.music.key);
    if (b) mfile = new File([b], data.music.name, { type: data.music.type || b.type });
  }
  quiet();
  batch(() => {
    currentProjectId.value = id;
    media.value = items;
    project.value = migrateProject({ ...defaultProject(), ...data.project, music: { ...defaultProject().music, ...data.project.music } });
    importOpts.value = { ...DEFAULT_OPTS, ...data.importOpts };
    sources.value = srcs;
    musicFile.value = mfile;
    musicBuffer.value = null;
    selectedClip.value = null;
    playhead.value = 0;
    page.value = data.project.clips.length ? 'edit' : 'media';
    saveState.value = 'saved';
  });
  resetHistory();
  // dossiers mémorisés : accès à réautoriser, sinon actualisation automatique (nouveaux fichiers)
  const pending: MediaSource[] = [];
  for (const x of srcs) if (x.handle && !(await ensurePermission(x.handle, false))) pending.push(x);
  pendingAccess.value = pending;
  const actions = await import('./actions');
  void actions.prepareMusic(true);
  if (srcs.some((x) => x.handle) && !pending.length) void actions.rescanAll(false).then(() => actions.rereadDates(true));
  else void actions.rereadDates(true);
  return items.filter((m) => m.missing && !(m.sourceId && pending.some((x) => x.id === m.sourceId))).length;
}

export function newProject() {
  for (const m of media.value) if (m.thumb.startsWith('blob:')) URL.revokeObjectURL(m.thumb);
  quiet();
  clearTimeout(timer);
  batch(() => {
    currentProjectId.value = null;
    media.value = [];
    sources.value = [];
    pendingAccess.value = [];
    project.value = defaultProject();
    musicFile.value = null;
    musicBuffer.value = null;
    selectedClip.value = null;
    playhead.value = 0;
    page.value = 'media';
    saveState.value = 'idle';
  });
  resetHistory();
}

export async function renameProject(id: string, name: string) {
  const s = await store('meta', 'readwrite');
  const meta = (await req(s.get(id))) as ProjectMeta | undefined;
  if (!meta) return;
  meta.name = name;
  await req((await store('meta', 'readwrite')).put(meta));
  if (id === currentProjectId.value) project.value = { ...project.value, title: name };
  projectsRev.value++;
}

/** Supprime un projet et les fichiers que plus aucun projet n'utilise. */
export async function deleteProject(id: string) {
  const d = await db();
  // vignettes du projet supprimé
  try {
    const data = (await req((await store('data')).get(id))) as ProjectData | undefined;
    if (data) {
      const st = await store('blobs', 'readwrite');
      for (const m of data.media) st.delete('thumb:' + m.id);
    }
  } catch {
    /* rien */
  }
  await new Promise<void>((res, rej) => {
    const tx = d.transaction(['meta', 'data', 'handles'], 'readwrite');
    tx.objectStore('meta').delete(id);
    tx.objectStore('data').delete(id);
    tx.objectStore('handles').delete(IDBKeyRange.bound(id + ':', id + ':\uffff'));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  if (currentProjectId.value === id) currentProjectId.value = null;
  // ramasse-miettes des fichiers orphelins
  const all = (await req((await store('data')).getAll())) as ProjectData[];
  const used = new Set<string>();
  for (const p of all) {
    for (const m of p.media) if (m.fileKey) used.add(m.fileKey);
    if (p.music) used.add(p.music.key);
  }
  for (const m of media.value) if (m.file) used.add(keyOf(m));
  const dir = await mediaDir();
  const keys: string[] = [];
  if (dir) {
    // @ts-expect-error itération asynchrone des entrées
    for await (const [name] of dir.entries()) if (name !== '.probe') keys.push(name);
  } else keys.push(...((await req((await store('blobs')).getAllKeys())) as string[]).filter((k) => !String(k).startsWith('thumb:')));
  for (const k of keys) if (!used.has(k)) await deleteBlob(k);
  projectsRev.value++;
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

// ---------- Fichier projet (sauvegarde / transfert) ----------
export async function exportProjectFile(): Promise<{ blob: Blob; name: string }> {
  const items = await serializeMedia(media.value);
  const body = {
    app: 'editgo',
    version: 1,
    savedAt: new Date().toISOString(),
    project: project.value,
    importOpts: importOpts.value,
    media: items,
  };
  const name = (project.value.title || 'projet').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').toLowerCase();
  return { blob: new Blob([JSON.stringify(body)], { type: 'application/json' }), name: `${name || 'projet'}.editgo.json` };
}

export async function importProjectFile(file: File): Promise<number> {
  const body = JSON.parse(await file.text());
  if (body?.app !== 'editgo' || !Array.isArray(body.media)) throw new Error('Ce fichier n’est pas un projet EditGo.');
  newProject();
  const items = await restoreMedia(body.media.map((m: StoredMedia) => ({ ...m, thumbBlob: null })));
  // vignettes régénérées pour les fichiers retrouvés sur l'appareil
  const { analyzeFile } = await import('../media/analyze');
  for (const it of items) {
    if (it.file && !it.thumb) {
      const a = await analyzeFile(it.file, it.path).catch(() => null);
      if (a) it.thumb = a.thumb;
    } else if (it.demo && !it.thumb) it.thumb = it.demo.draw(240, Math.round((240 * it.height) / it.width)).toDataURL('image/jpeg', 0.8);
  }
  batch(() => {
    media.value = items;
    project.value = migrateProject({ ...defaultProject(), ...body.project });
    importOpts.value = body.importOpts ?? importOpts.value;
    page.value = body.project?.clips?.length ? 'edit' : 'media';
  });
  resetHistory();
  await saveCurrent();
  return items.filter((m) => m.missing).length;
}

// ---------- Sauvegarde automatique ----------
let timer = 0;
let armed = false;
/** Évite de réenregistrer juste après une ouverture. */
let quietUntil = 0;
const quiet = () => (quietUntil = Date.now() + 800);
export function startAutosave() {
  if (armed) return;
  armed = true;
  let first = true;
  effect(() => {
    void project.value;
    void media.value;
    void importOpts.value;
    void musicFile.value;
    void sources.value;
    if (first) {
      first = false;
      return;
    }
    if (!media.peek().length || Date.now() < quietUntil) return;
    clearTimeout(timer);
    // peek() : lire l'état sans s'y abonner (sinon chaque enregistrement en relançait un autre, en boucle)
    if (saveState.peek() !== 'saving') saveState.value = 'idle';
    timer = window.setTimeout(() => void saveCurrent(), 3000);
  });
}

const GUARD = 'editgo-reading-handles';
/** Vrai si une relecture d'accès aux dossiers a fait planter le navigateur au lancement précédent. */
export const handlesUnsafe = signal((() => {
  try {
    return false;
  } catch {
    return false;
  }
})());
try {
  // un témoin resté posé = le navigateur s'est arrêté pendant la relecture
  if (localStorage.getItem(GUARD) === 'reading') {
    handlesUnsafe.value = true;
  }
  // la prochaine ouverture retentera la relecture
  localStorage.removeItem(GUARD);
} catch {
  /* stockage indisponible */
}

/** Relit les accès mémorisés aux dossiers d'un projet (avec garde-fou anti-plantage). */
async function attachHandles(projectId: string, srcs: (MediaSource & { linked?: boolean })[]): Promise<MediaSource[]> {
  const out = srcs.map(({ linked: _l, ...x }) => (void _l, { ...x }) as MediaSource);
  if (!srcs.some((x) => x.linked || x.handle) || handlesUnsafe.value) return out;
  try {
    localStorage.setItem(GUARD, 'reading');
  } catch {
    /* sans garde-fou */
  }
  try {
    const st = await store('handles');
    for (const x of out) {
      const h = (await req(st.get(projectId + ':' + x.id))) as FileSystemDirectoryHandle | undefined;
      if (h) x.handle = h;
    }
  } catch {
    /* accès non relisibles : on continue sans */
  }
  try {
    localStorage.removeItem(GUARD);
  } catch {
    /* rien */
  }
  return out;
}

/** Réautorise l'accès aux dossiers mémorisés (doit suivre un clic), puis réassocie et actualise. */
export async function grantPendingAccess() {
  const list = pendingAccess.value;
  const ok: MediaSource[] = [];
  for (const x of list) if (x.handle && (await ensurePermission(x.handle, true))) ok.push(x);
  pendingAccess.value = list.filter((x) => !ok.includes(x));
  for (const x of ok) {
    for (const m of media.value) {
      if (m.sourceId !== x.id || (m.file && !m.missing)) continue;
      const f = await resolveInSource(x.handle!, m.path);
      if (f) {
        m.file = f;
        m.missing = false;
      }
    }
  }
  media.value = [...media.value];
  const actions = await import('./actions');
  for (const x of ok) await actions.rescanSource(x.id, false);
}
