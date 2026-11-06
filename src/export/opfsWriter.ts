// Écriture d'un fichier dans l'espace disque du navigateur (OPFS) depuis un « worker »,
// avec FileSystemSyncAccessHandle : disponible aussi sur Safari / iPhone, où createWritable manque.
// Le film n'est jamais entièrement en mémoire.
import type { StreamTargetChunk } from 'mediabunny';

const WORKER = `
let h = null;
onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.t === 'open') {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('exports', { create: true });
      const fh = await dir.getFileHandle(m.name, { create: true });
      h = await fh.createSyncAccessHandle();
      await h.truncate(0);
    } else if (m.t === 'w') {
      await h.write(m.data, { at: m.pos });
    } else if (m.t === 'close') {
      await h.flush();
      await h.close();
      h = null;
    } else if (m.t === 'abort') {
      if (h) { await h.close(); h = null; }
    }
    postMessage({ id: m.id });
  } catch (err) {
    postMessage({ id: m.id, err: String(err && err.message || err) });
  }
};`;

export interface DiskStream {
  writable: WritableStream<StreamTargetChunk>;
  getFile: () => Promise<File>;
}

export async function opfsWorkerStream(name: string): Promise<DiskStream> {
  const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  let seq = 0;
  const pending = new Map<number, { res: () => void; rej: (e: Error) => void }>();
  w.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.err) p.rej(new Error(e.data.err));
    else p.res();
  };
  const call = (msg: Record<string, unknown>, transfer: Transferable[] = []) =>
    new Promise<void>((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      w.postMessage({ ...msg, id }, transfer);
    });
  await call({ t: 'open', name });
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      // copie : le tampon d'origine peut être réutilisé par l'encodeur
      const data = chunk.data.slice();
      return call({ t: 'w', pos: chunk.position, data }, [data.buffer]);
    },
    async close() {
      await call({ t: 'close' });
      w.terminate();
    },
    async abort() {
      await call({ t: 'abort' }).catch(() => null);
      w.terminate();
    },
  });
  return {
    writable,
    getFile: async () => {
      const root = await navigator.storage.getDirectory();
      return (await (await root.getDirectoryHandle('exports')).getFileHandle(name)).getFile();
    },
  };
}

/** Le navigateur sait-il écrire un fichier depuis un worker (OPFS + accès synchrone) ? */
export function canUseOpfsWorker(): boolean {
  return typeof Worker !== 'undefined' && !!navigator.storage?.getDirectory && 'FileSystemSyncAccessHandle' in globalThis;
}
