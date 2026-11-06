// Chargement des modules à la demande, robuste aux mises à jour de l'application.
//
// Quand une nouvelle version est publiée pendant qu'une page plus ancienne est ouverte,
// les fichiers chargés à la demande de l'ancienne version n'existent plus sur le serveur
// (« Importing a module script failed » sous Safari, « Failed to fetch dynamically imported module » ailleurs).
// On enregistre alors le projet, on recharge la nouvelle version et on rouvre le projet là où on en était.

const RESUME = 'editgo-resume';

export function isStaleChunkError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS|module script/i.test(m);
}

let recovering = false;
async function recover(): Promise<never> {
  if (!recovering) {
    recovering = true;
    try {
      const { saveCurrent, currentProjectId } = await import('./state/persist');
      const { page, toast } = await import('./state/store');
      toast('EditGo vient d’être mis à jour : rechargement, votre projet va se rouvrir…', 'info', 8000);
      await saveCurrent().catch(() => null);
      sessionStorage.setItem(RESUME, JSON.stringify({ id: currentProjectId.value, page: page.value, at: Date.now() }));
    } catch {
      /* rechargement quand même */
    }
    setTimeout(() => location.reload(), 600);
  }
  return new Promise<never>(() => {});
}

/** import() qui, en cas de fichier disparu après une mise à jour, recharge proprement l'application. */
export async function lazy<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    if (!isStaleChunkError(e)) throw e;
    // second essai (coupure réseau passagère), puis reprise sur la nouvelle version
    try {
      return await load();
    } catch {
      return recover();
    }
  }
}

/** Au démarrage : rouvre le projet si l'application vient d'être rechargée pour une mise à jour. */
export async function resumeAfterUpdate() {
  let data: { id: string | null; page: string; at: number } | null = null;
  try {
    data = JSON.parse(sessionStorage.getItem(RESUME) || 'null');
    sessionStorage.removeItem(RESUME);
  } catch {
    return;
  }
  if (!data || Date.now() - data.at > 5 * 60_000) return;
  const { openProject } = await import('./state/persist');
  const { page, toast } = await import('./state/store');
  if (data.id) await openProject(data.id).catch(() => null);
  if (data.page === 'media' || data.page === 'edit' || data.page === 'export') page.value = data.page;
  toast('EditGo a été mis à jour et votre projet rouvert. Vous pouvez reprendre (relancer l’export si besoin).', 'ok', 9000);
}

/** Précharge en arrière-plan les modules lourds pour qu'ils soient prêts au moment voulu. */
export function prefetchModules() {
  const go = () => {
    void import('./export/exporter').catch(() => null);
    // encodeur AAC de secours : seulement si l'appareil n'a pas d'encodeur audio (certains iPhone)
    if (typeof (globalThis as { AudioEncoder?: unknown }).AudioEncoder === 'undefined') void import('@mediabunny/aac-encoder').catch(() => null);
  };
  const ric = (globalThis as { requestIdleCallback?: (f: () => void, o?: object) => void }).requestIdleCallback;
  if (ric) ric(go, { timeout: 6000 });
  else setTimeout(go, 3000);
}
