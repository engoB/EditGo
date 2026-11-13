import { cutOf } from '../media/cut';
// Montage automatique « souvenir » : chapitres temporels, sélection des meilleurs
// plans, rythme (calé sur le tempo de la musique), transitions et titres.
import type { Clip, MediaItem, MotionId, Project, TransitionId } from '../types';
import { ASPECTS, THEMES } from '../presets';
import { autoTitle, formatDay, formatDayShort, hashStr, rng, uid } from '../util';
import { eventFromPath } from '../media/dates';

export interface Chapter {
  index: number;
  start: number;
  end: number;
  items: MediaItem[];
  label: string;
  /** Nom d'événement tiré des dossiers (« Vacances Bretagne »), si la majorité des médias en provient. */
  event?: string;
}

export const usable = (m: MediaItem) => !m.duplicateOf && !m.similarTo && !m.excluded && !m.error && !m.missing;

export function chapters(items: MediaItem[], gapHours: number): Chapter[] {
  const sorted = items.filter(usable).sort((a, b) => a.date - b.date);
  const out: Chapter[] = [];
  let cur: MediaItem[] = [];
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].date,
      end = cur[cur.length - 1].date;
    out.push({ index: out.length, start, end, items: cur, label: '' });
    cur = [];
  };
  for (const m of sorted) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = (m.date - prev.date) / 3_600_000;
      const newDay = new Date(m.date).toDateString() !== new Date(prev.date).toDateString();
      if (gap > gapHours || (newDay && gap > Math.min(gapHours, 6))) flush();
    }
    cur.push(m);
  }
  flush();
  // libellé précis au jour près (période si le moment s'étale sur plusieurs jours)
  for (const c of out) c.label = dayRange(c.start, c.end);
  // nom d'événement issu des dossiers
  for (const c of out) {
    const count = new Map<string, number>();
    for (const m of c.items) {
      const e = eventFromPath(m.path);
      if (e) count.set(e, (count.get(e) ?? 0) + 1);
    }
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= c.items.length * 0.6) c.event = top[0];
  }
  // plusieurs moments le même jour : on précise le moment de la journée
  const count = new Map<string, number>();
  for (const c of out) count.set(c.label, (count.get(c.label) ?? 0) + 1);
  for (const c of out) {
    if ((count.get(c.label) ?? 0) < 2) continue;
    const h = new Date(c.start).getHours();
    c.label += h < 5 ? ' · la nuit' : h < 12 ? ' · le matin' : h < 18 ? ' · l’après-midi' : ' · le soir';
  }
  return out;
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** « Mardi 21 octobre 2026 », ou « 21 – 23 octobre 2026 » / « 28 sept. – 2 oct. 2026 » sur plusieurs jours. */
export function dayRange(start: number, end: number): string {
  if (sameDay(start, end)) return formatDay(start);
  const a = new Date(start),
    b = new Date(end);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth())
    return `${a.getDate()} – ${b.getDate()} ${new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(b)}`;
  const short = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
  return a.getFullYear() === b.getFullYear() ? `${short.format(a)} – ${short.format(b)} ${b.getFullYear()}` : `${formatDayShort(start)} – ${formatDayShort(end)}`;
}

export function newClip(partial: Partial<Clip>): Clip {
  return {
    id: uid(),
    type: 'media',
    mediaId: null,
    duration: 3,
    trimIn: 0,
    speed: 1,
    volume: 0.8,
    transition: 'fade',
    transitionDuration: 1,
    motion: 'auto',
    fit: 'blur',
    title: null,
    ...partial,
  };
}

/** Durée cible d'un plan photo arrondie au temps (beats) si demandé. */
function snap(d: number, beat: number, enabled: boolean): number {
  if (!enabled || beat <= 0) return d;
  const n = Math.max(1, Math.round(d / beat));
  return n * beat;
}

export function buildStory(items: MediaItem[], project: Project, gapHours: number): Partial<Project> {
  const theme = THEMES[project.theme];
  const chs = chapters(items, gapHours);
  const all = chs.flatMap((c) => c.items);
  if (!all.length) return { clips: [] };
  const beat = project.music.kind !== 'none' && project.music.beatSync && project.music.bpm > 0 ? 60 / project.music.bpm : 0;
  const photoDur = project.photoDuration;
  const all_ = project.buildMode === 'all';
  // mode « tous les médias » : rien n'est écarté ni raccourci (vidéos complètes)
  const videoMax = all_ ? Infinity : Math.max(3, photoDur * 1.8);
  const trans = theme.transitionDuration;

  // Estimation de la durée de chaque média puis sélection selon la durée cible.
  const estimate = (m: MediaItem) => (m.kind === 'video' ? Math.min(cutOf(m).len, videoMax) : photoDur) - trans * 0.6;
  const fullLength = all.reduce((s, m) => s + estimate(m), 0);
  const target = !all_ && project.targetLength > 0 ? project.targetLength - 6 : Infinity;
  let selected = new Set(all.map((m) => m.id));
  if (fullLength > target) {
    // budget par chapitre proportionnel à la racine du nombre de médias (évite qu'un gros chapitre écrase les autres)
    const weights = chs.map((c) => Math.sqrt(c.items.length));
    const wsum = weights.reduce((a, b) => a + b, 0);
    selected = new Set();
    chs.forEach((c, i) => {
      const budget = (target * weights[i]) / wsum;
      const ranked = [...c.items].sort((a, b) => b.score - a.score);
      let used = 0;
      for (const m of ranked) {
        const e = estimate(m);
        if (used + e > budget && used > 0) continue;
        selected.add(m.id);
        used += e;
      }
    });
  }

  const title = project.title || autoTitle(all[0].date, all[all.length - 1].date).title;
  const subtitle = project.subtitle || autoTitle(all[0].date, all[all.length - 1].date).subtitle;
  const clips: Clip[] = [];
  const rand = rng(hashStr(all.map((m) => m.id).join('|')));

  // Carton d'ouverture sur fond flouté de la plus belle image
  const hero = [...all].filter((m) => m.kind === 'photo').sort((a, b) => b.score - a.score)[0] ?? all[0];
  clips.push(
    newClip({
      type: 'title',
      mediaId: hero.id,
      duration: snap(4.2, beat, !!beat),
      transition: 'cut',
      transitionDuration: 0,
      background: 'blur',
      title: { text: title, sub: subtitle, style: theme.title, position: 'center' },
      motion: 'zoomIn',
      fit: 'cover',
    }),
  );

  const motions: MotionId[] = ['zoomIn', 'panRight', 'zoomOut', 'panLeft', 'zoomIn', 'panUp', 'zoomOut', 'panDown'];
  let mi = Math.floor(rand() * motions.length);
  let ti = 0;
  const outAspect = ASPECTS[project.aspect].w / ASPECTS[project.aspect].h;
  chs.forEach((c, ci) => {
    const picks = c.items.filter((m) => selected.has(m.id));
    const units = groupPhotos(picks, outAspect, project.collage ?? 'auto');
    units.forEach((unit, k) => {
      const m = unit[0];
      const firstOfChapter = k === 0;
      let transition: TransitionId;
      if (clips.length === 1) transition = 'dipBlack';
      else if (firstOfChapter) transition = theme.chapterTransition;
      else transition = theme.transitions[ti++ % theme.transitions.length];
      let duration: number;
      let trimIn = 0;
      if (m.kind === 'video') {
        // extrait choisi dans la médiathèque (toute la vidéo par défaut)
        const cut = cutOf(m);
        const len = Math.min(cut.len, videoMax);
        // segment central : on évite les premières secondes souvent tremblées (sauf extrait choisi)
        trimIn = all_ || cut.set ? cut.a : cut.a + Math.max(0, Math.min(cut.len - len, cut.len * 0.12));
        // en mode « tous les médias », la vidéo garde toute sa longueur
        duration = all_ ? len : snap(len, beat, !!beat && len > beat);
        if (trimIn + duration > cut.b) duration = Math.max(0.5, cut.b - trimIn);
      } else if (unit.length > 1) {
        // une mosaïque reste plus longtemps à l'écran : il y a plus à regarder
        duration = snap(photoDur * (1 + 0.3 * (unit.length - 1)), beat, !!beat);
      } else {
        // les meilleures photos restent un peu plus longtemps
        duration = snap(photoDur * (0.85 + m.score * 0.35), beat, !!beat);
      }
      const portraitInLandscape = m.height > m.width * 1.05;
      clips.push(
        newClip({
          mediaId: m.id,
          duration,
          trimIn,
          transition,
          transitionDuration: transition === 'cut' ? 0 : firstOfChapter ? Math.max(trans, 0.8) : trans,
          motion: m.kind === 'video' || unit.length > 1 ? 'none' : motions[mi++ % motions.length],
          fit: portraitInLandscape ? 'blur' : 'cover',
          extra: unit.length > 1 ? unit.slice(1).map((x) => x.id) : undefined,
          chapter: ci,
          volume: m.hasAudio ? 0.7 : 0,
          // titre de chapitre : la date, uniquement quand le jour change
          title:
            firstOfChapter && chs.length > 1 && (ci === 0 || !sameDay(chs[ci - 1].end, c.start))
              ? { text: dayRange(c.start, c.end), sub: '', style: theme.chapterTitle, position: 'lower' }
              : null,
        }),
      );
    });
  });

  // Carton de fin
  clips.push(
    newClip({
      type: 'title',
      mediaId: hero.id,
      duration: snap(3.6, beat, !!beat),
      transition: 'dipBlack',
      transitionDuration: 1.2,
      background: 'black',
      title: { text: title, sub: 'Fin', style: theme.title, position: 'center' },
      motion: 'none',
      fit: 'cover',
    }),
  );
  return { clips, title, subtitle };
}

/**
 * Regroupe intelligemment des photos en mosaïques de 2 à 4 :
 *  - photos prises à peu d'intervalle (même scène) ;
 *  - en priorité celles dont l'orientation ne correspond pas au film
 *    (un portrait seul dans un film paysage laisserait de grandes marges) ;
 *  - les plus belles photos bien orientées restent seules, en plein cadre.
 */
export function groupPhotos(items: MediaItem[], outAspect: number, mode: 'off' | 'auto' | 'more'): MediaItem[][] {
  if (mode === 'off') return items.map((m) => [m]);
  const more = mode === 'more';
  const H = 3_600_000;
  const W1 = (more ? 8 : 3) * H; // orientation inadaptée : réunies entre elles
  const W2 = (more ? 3 : 0.4) * H; // photos secondaires prises à quelques minutes d'écart
  const W3 = (more ? 6 : 2) * H; // portrait isolé : rejoint sa voisine
  const isPhoto = (m: MediaItem) => m.kind === 'photo';
  const mismatch = (m: MediaItem) => isPhoto(m) && Math.abs(Math.log(m.width / Math.max(1, m.height) / outAspect)) > 0.45;
  const scores = items.filter(isPhoto).map((m) => m.score).sort((a, b) => b - a);
  const soloQ = scores[Math.floor(scores.length * (more ? 0.15 : 0.4))] ?? 1;
  const solo = (m: MediaItem) => !mismatch(m) && m.score >= soloQ;
  const units: MediaItem[][] = items.map((m) => [m]);
  const photoUnit = (u: MediaItem[]) => u.every(isPhoto);
  const first = (u: MediaItem[]) => u[0].date;
  const last = (u: MediaItem[]) => u[u.length - 1].date;

  // 1. photos d'orientation inadaptée (ex. portraits dans un film paysage) : réunies entre elles
  const maxMis = more ? 4 : 3;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.length !== 1 || !mismatch(u[0])) continue;
    for (let j = i + 1; j < units.length && u.length < maxMis; j++) {
      const v = units[j];
      if (first(v) - last(u) > W1) break;
      if (v.length === 1 && mismatch(v[0])) {
        u.push(v[0]);
        units.splice(j--, 1);
      }
    }
  }
  // 2. photos secondaires consécutives prises à peu d'intervalle
  const maxN = more ? 4 : 3;
  for (let i = 0; i < units.length - 1; i++) {
    const u = units[i];
    if (u.length !== 1 || !isPhoto(u[0]) || solo(u[0]) || mismatch(u[0])) continue;
    while (i + 1 < units.length && u.length < maxN) {
      const v = units[i + 1];
      if (v.length !== 1 || !isPhoto(v[0]) || solo(v[0]) || mismatch(v[0]) || first(v) - last(u) > W2) break;
      u.push(v[0]);
      units.splice(i + 1, 1);
    }
  }
  // 3. une photo d'orientation inadaptée restée seule rejoint sa voisine la plus proche dans le temps
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.length !== 1 || !mismatch(u[0])) continue;
    const prev = units[i - 1],
      next = units[i + 1];
    const cand = [prev, next]
      .filter((v): v is MediaItem[] => !!v && photoUnit(v) && v.length < maxN)
      .map((v) => ({ v, gap: Math.min(Math.abs(first(v) - u[0].date), Math.abs(last(v) - u[0].date)) }))
      .filter((x) => x.gap <= W3)
      .sort((a, b) => a.gap - b.gap)[0];
    if (!cand) continue;
    cand.v.push(u[0]);
    cand.v.sort((a, b) => a.date - b.date);
    units.splice(i--, 1);
  }
  return units;
}
