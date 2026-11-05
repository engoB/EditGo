import { computed, signal, batch } from '@preact/signals';
import type { Clip, ImportOptions, MediaItem, MediaSource, Project } from '../types';
import { THEMES } from '../presets';
import { layout } from '../story/timeline';

export function defaultProject(): Project {
  const th = THEMES.cinema;
  return {
    title: '',
    subtitle: '',
    aspect: '16:9',
    theme: 'cinema',
    look: th.look,
    lookIntensity: th.lookIntensity,
    grain: th.grain,
    vignette: th.vignette,
    bloom: th.bloom,
    letterbox: th.letterbox,
    photoDuration: th.photoDuration,
    buildMode: 'all',
    collage: 'auto',
    targetLength: 60,
    music: { kind: 'generated', mood: th.mood, fileName: '', volume: 0.8, ducking: true, beatSync: true, bpm: 84, offset: 0 },
    clips: [],
  };
}

export type Page = 'media' | 'edit' | 'export';

export const media = signal<MediaItem[]>([]);
export const mediaMap = computed(() => new Map(media.value.map((m) => [m.id, m])));
export const project = signal<Project>(defaultProject());
export const timeline = computed(() => layout(project.value.clips));
export const importOpts = signal<ImportOptions>({ nearDuplicates: true, similarity: 8, chapterGapHours: 4, skipJunk: true });
export const sources = signal<MediaSource[]>([]);
export const page = signal<Page>('media');
export const selectedClip = signal<string | null>(null);
export const playhead = signal(0);
export const playing = signal(false);
export const importing = signal<{ done: number; total: number; label: string } | null>(null);
export const musicBuffer = signal<AudioBuffer | null>(null);
export const musicFile = signal<File | null>(null);
export const musicBusy = signal(false);
export const timelineZoom = signal(60); // px par seconde
export const timelineView = signal<'timeline' | 'storyboard'>('timeline');
export const mobilePanel = signal<'viewer' | 'media' | 'inspector'>('viewer');

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'ok' | 'warn' | 'error';
}
export const toasts = signal<Toast[]>([]);
let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 3800) {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, text, kind }];
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), ms);
}

// ---------- Historique (annuler / rétablir) ----------
const undoStack: string[] = [];
const redoStack: string[] = [];
export const historyRev = signal(0);
const snap = () => JSON.stringify(project.value);

export function commit(next: Project) {
  undoStack.push(snap());
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
  project.value = next;
  historyRev.value++;
}

export function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(snap());
  project.value = JSON.parse(prev);
  historyRev.value++;
}
export function redo() {
  const nxt = redoStack.pop();
  if (!nxt) return;
  undoStack.push(snap());
  project.value = JSON.parse(nxt);
  historyRev.value++;
}
export function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  historyRev.value++;
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

/** Modifie le projet. `history: false` pour les réglages continus (curseurs) déjà historisés. */
export function updateProject(patch: Partial<Project> | ((p: Project) => Partial<Project>), history = true) {
  const p = project.value;
  const delta = typeof patch === 'function' ? patch(p) : patch;
  const next = { ...p, ...delta };
  if (history) commit(next);
  else project.value = next;
}

export function updateClip(id: string, patch: Partial<Clip>, history = true) {
  updateProject((p) => ({ clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }), history);
}

export function removeClip(id: string) {
  batch(() => {
    updateProject((p) => ({ clips: p.clips.filter((c) => c.id !== id) }));
    if (selectedClip.value === id) selectedClip.value = null;
  });
}

export function moveClip(id: string, toIndex: number) {
  updateProject((p) => {
    const arr = [...p.clips];
    const from = arr.findIndex((c) => c.id === id);
    if (from < 0) return {};
    const [c] = arr.splice(from, 1);
    arr.splice(Math.max(0, Math.min(arr.length, toIndex > from ? toIndex - 1 : toIndex)), 0, c);
    return { clips: arr };
  });
}

/** Marque le début d'un geste continu (curseur) pour qu'il soit annulable en une fois. */
export function beginGesture() {
  undoStack.push(snap());
  redoStack.length = 0;
  historyRev.value++;
}

export function touchMedia() {
  media.value = [...media.value];
}
