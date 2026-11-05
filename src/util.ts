let counter = 0;
export const uid = () => Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6);

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => t * t * (3 - 2 * t);
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

const fmtDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDayShort = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtMonth = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const formatDay = (t: number) => cap(fmtDay.format(t));
export const formatDayShort = (t: number) => fmtDayShort.format(t);
export const formatMonth = (t: number) => cap(fmtMonth.format(t));
export const formatTime = (t: number) => fmtTime.format(t);

export function seasonOf(t: number): string {
  const d = new Date(t);
  const m = d.getMonth();
  const y = d.getFullYear();
  if (m === 11 || m <= 1) return `Hiver ${m === 11 ? y + 1 : y}`;
  if (m <= 4) return `Printemps ${y}`;
  if (m <= 7) return `Été ${y}`;
  return `Automne ${y}`;
}

/** Titre automatique à partir d'une période. */
export function autoTitle(start: number, end: number): { title: string; subtitle: string } {
  const a = new Date(start),
    b = new Date(end);
  const sameDay = a.toDateString() === b.toDateString();
  const days = (end - start) / 86_400_000;
  if (sameDay) return { title: cap(new Intl.DateTimeFormat('fr-FR', { weekday: 'long' }).format(a)) + ' souvenir', subtitle: formatDay(start) };
  if (days < 20) {
    const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
    const sub = sameMonth
      ? `${a.getDate()} – ${b.getDate()} ${new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(b)}`
      : `${formatDayShort(start)} – ${formatDayShort(end)}`;
    return { title: days < 4 ? 'Quelques jours' : 'Nos jours heureux', subtitle: sub };
  }
  if (days < 100) return { title: seasonOf(start), subtitle: `${formatMonth(start)} – ${formatMonth(end)}` };
  if (a.getFullYear() === b.getFullYear()) return { title: `L'année ${a.getFullYear()}`, subtitle: `${formatMonth(start)} – ${formatMonth(end)}` };
  return { title: 'Souvenirs', subtitle: `${a.getFullYear()} – ${b.getFullYear()}` };
}

export function timecode(t: number, fps = 30): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const f = Math.floor((s - Math.floor(s)) * fps);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

export const fmtDuration = (s: number) => {
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s % 60)).padStart(2, '0')}`;
};

export const fmtBytes = (b: number) =>
  b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(0)} Ko` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} Mo` : `${(b / 1073741824).toFixed(2)} Go`;

/** Générateur pseudo-aléatoire déterministe. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type DownloadsCap = { save: (r: { filename: string; data: Blob }) => Promise<{ status: string }> } | null;
let downloadsCap: Promise<DownloadsCap> | null = null;

/**
 * Enregistre un fichier. Dans un artefact claude.ai, passe par la capacité « downloads »
 * (le cadre bloque les téléchargements directs) ; sinon lien de téléchargement classique.
 */
export async function downloadBlob(blob: Blob, name: string): Promise<void> {
  const host = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude;
  if (host?.use) {
    downloadsCap ??= host.use('downloads') as Promise<DownloadsCap>;
    const cap = await downloadsCap;
    if (cap) {
      try {
        await cap.save({ filename: name, data: blob });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code !== 'declined') throw new Error(code === 'too_large' ? 'Fichier trop volumineux pour cet espace' : 'Enregistrement indisponible ici');
      }
      return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Enregistrement sans rejet : l'erreur éventuelle est signalée à l'utilisateur. */
export function saveFile(blob: Blob, name: string) {
  downloadBlob(blob, name).catch((e: Error) =>
    import('./state/store').then(({ toast }) => toast(e.message || 'Enregistrement impossible', 'error')),
  );
}
