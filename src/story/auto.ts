// Montage automatique « souvenir » : chapitres temporels, sélection des meilleurs
// plans, rythme (calé sur le tempo de la musique), transitions et titres.
import type { Clip, MediaItem, MotionId, Project, TransitionId } from '../types';
import { THEMES } from '../presets';
import { autoTitle, formatDay, formatMonth, hashStr, rng, uid } from '../util';

export interface Chapter {
  index: number;
  start: number;
  end: number;
  items: MediaItem[];
  label: string;
}

export const usable = (m: MediaItem) => !m.duplicateOf && !m.similarTo && !m.excluded && !m.error;

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
  const spanDays = out.length ? (out[out.length - 1].end - out[0].start) / 86_400_000 : 0;
  for (const c of out) c.label = spanDays > 120 ? formatMonth(c.start) : formatDay(c.start);
  // plusieurs moments le même jour : on précise le moment de la journée
  const count = new Map<string, number>();
  for (const c of out) count.set(c.label, (count.get(c.label) ?? 0) + 1);
  for (const c of out) {
    if ((count.get(c.label) ?? 0) < 2 || spanDays > 120) continue;
    const h = new Date(c.start).getHours();
    c.label += h < 5 ? ' · la nuit' : h < 12 ? ' · le matin' : h < 18 ? ' · l’après-midi' : ' · le soir';
  }
  return out;
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
  const videoMax = Math.max(3, photoDur * 1.8);
  const trans = theme.transitionDuration;

  // Estimation de la durée de chaque média puis sélection selon la durée cible.
  const estimate = (m: MediaItem) => (m.kind === 'video' ? Math.min(m.duration, videoMax) : photoDur) - trans * 0.6;
  const fullLength = all.reduce((s, m) => s + estimate(m), 0);
  const target = project.targetLength > 0 ? project.targetLength - 6 : Infinity;
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
  chs.forEach((c, ci) => {
    const picks = c.items.filter((m) => selected.has(m.id));
    picks.forEach((m, k) => {
      const firstOfChapter = k === 0;
      let transition: TransitionId;
      if (clips.length === 1) transition = 'dipBlack';
      else if (firstOfChapter) transition = theme.chapterTransition;
      else transition = theme.transitions[ti++ % theme.transitions.length];
      let duration: number;
      let trimIn = 0;
      if (m.kind === 'video') {
        const len = Math.min(m.duration, videoMax);
        // segment central : on évite les premières secondes souvent tremblées
        trimIn = Math.max(0, Math.min(m.duration - len, m.duration * 0.12));
        duration = snap(len, beat, !!beat && len > beat);
        if (trimIn + duration > m.duration) duration = Math.max(0.5, m.duration - trimIn);
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
          motion: m.kind === 'video' ? 'none' : motions[mi++ % motions.length],
          fit: portraitInLandscape ? 'blur' : 'cover',
          chapter: ci,
          volume: m.hasAudio ? 0.7 : 0,
          title:
            firstOfChapter && chs.length > 1
              ? { text: c.label, sub: '', style: theme.chapterTitle, position: 'lower' }
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
