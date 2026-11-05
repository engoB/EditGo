// Dossiers sources : plusieurs dossiers (téléphone, PC, Google Drive synchronisé…)
// donnés à l'application, parcourus récursivement, mémorisés et actualisables.
import type { MediaSource } from '../types';
import { mediaKindOf } from './analyze';
import { uid } from '../util';

export interface ScanEntry {
  file: File;
  /** Chemin relatif à la source, nom du dossier racine compris (« Vacances/2023/IMG_1.jpg »). */
  path: string;
}

type DirPicker = (o?: object) => Promise<FileSystemDirectoryHandle>;
const picker = () => (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
export const canPickFolders = () => typeof picker() === 'function';

const SKIP_DIR = /^(\.|@eadir$|\$recycle\.bin$|system volume information$|node_modules$|\.?thumbnails?$|\.trash)/i;
const wanted = (f: File) => !!mediaKindOf(f) || /\.json$/i.test(f.name);

/** Parcourt récursivement un dossier (médias + fichiers JSON Takeout). */
export async function scanHandle(root: FileSystemDirectoryHandle, onProgress?: (n: number) => void): Promise<ScanEntry[]> {
  const out: ScanEntry[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
    // @ts-expect-error itération asynchrone des entrées
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (handle.kind === 'directory') {
        if (!SKIP_DIR.test(name)) await walk(handle as FileSystemDirectoryHandle, prefix + name + '/');
        continue;
      }
      if (!/\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?|mp4|m4v|mov|webm|mkv|3gp|avi|ogv|mts|m2ts|mod|tod|vob|mpg|mpeg|json)$/i.test(name)) continue;
      try {
        const f = await (handle as FileSystemFileHandle).getFile();
        if (wanted(f)) {
          out.push({ file: f, path: prefix + name });
          if (out.length % 50 === 0) onProgress?.(out.length);
        }
      } catch {
        /* fichier inaccessible */
      }
    }
  };
  await walk(root, root.name + '/');
  return out;
}

/** Ouvre le sélecteur de dossier natif ; null si non disponible ou annulé. */
export async function pickFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  const p = picker();
  if (!p) return null;
  try {
    return await p({ mode: 'read', id: 'editgo-sources' });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') throw e;
    return null;
  }
}

export function newSource(name: string, handle?: FileSystemDirectoryHandle): MediaSource {
  return { id: uid(), name, handle, addedAt: Date.now(), scannedAt: Date.now(), count: 0 };
}

/** Récupère les dossiers déposés sous forme d'accès mémorisables (Chrome, Edge). À appeler pendant l'événement drop. */
export function dropHandles(dt: DataTransfer): Promise<FileSystemHandle[]> | null {
  const items = Array.from(dt.items).filter((i) => i.kind === 'file');
  const get = (i: DataTransferItem) => (i as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.();
  if (!items.length || !get(items[0] as DataTransferItem)) return null;
  // les promesses doivent être créées de façon synchrone, avant tout await
  const ps = items.map((i) => get(i));
  return Promise.all(ps).then((hs) => hs.filter((h): h is FileSystemHandle => !!h));
}

type PermHandle = FileSystemHandle & {
  queryPermission?: (o: object) => Promise<PermissionState>;
  requestPermission?: (o: object) => Promise<PermissionState>;
};

/** Vérifie (et, si `ask`, demande) l'autorisation de lecture d'un dossier mémorisé. */
export async function ensurePermission(h: FileSystemHandle, ask: boolean): Promise<boolean> {
  const ph = h as PermHandle;
  try {
    if ((await ph.queryPermission?.({ mode: 'read' })) === 'granted') return true;
    if (ask && (await ph.requestPermission?.({ mode: 'read' })) === 'granted') return true;
  } catch {
    /* refusé */
  }
  return false;
}

/** Retrouve un fichier dans une source à partir de son chemin (« Racine/sous/dossier/fichier »). */
export async function resolveInSource(root: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  const parts = path.split('/').slice(1); // le premier segment est le nom de la racine
  try {
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
    return await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
  } catch {
    return null;
  }
}

/** Regroupe des fichiers choisis avec <input webkitdirectory> par dossier racine. */
export function groupByRoot(list: ScanEntry[]): Map<string, ScanEntry[]> {
  const m = new Map<string, ScanEntry[]>();
  for (const e of list) {
    const root = e.path.includes('/') ? e.path.split('/')[0] : '';
    const arr = m.get(root) ?? [];
    arr.push(e);
    m.set(root, arr);
  }
  return m;
}
