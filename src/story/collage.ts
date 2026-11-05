// Mosaïques de 2 à 4 photos : choix de la disposition qui rogne le moins les photos,
// compte tenu de leur orientation et du format du film.

export type Rect = [number, number, number, number]; // x, y, w, h (0..1, origine en haut à gauche)

export interface LayoutDef {
  id: string;
  label: string;
  n: number;
  /** Répartition paramétrée par `s` (proportion de la case principale ou de la première colonne). */
  rects: (s: number) => Rect[];
  /** Plage de `s` admise (la valeur optimale est cherchée dans cette plage). */
  s: [number, number];
}

export const LAYOUTS: LayoutDef[] = [
  { id: 'cols2', label: 'Côte à côte', n: 2, s: [0.36, 0.64], rects: (s) => [[0, 0, s, 1], [s, 0, 1 - s, 1]] },
  { id: 'rows2', label: 'Superposées', n: 2, s: [0.36, 0.64], rects: (s) => [[0, 0, 1, s], [0, s, 1, 1 - s]] },
  { id: 'bigL3', label: 'Grande à gauche', n: 3, s: [0.45, 0.7], rects: (s) => [[0, 0, s, 1], [s, 0, 1 - s, 0.5], [s, 0.5, 1 - s, 0.5]] },
  { id: 'bigR3', label: 'Grande à droite', n: 3, s: [0.3, 0.55], rects: (s) => [[0, 0, s, 0.5], [0, 0.5, s, 0.5], [s, 0, 1 - s, 1]] },
  { id: 'bigT3', label: 'Grande en haut', n: 3, s: [0.45, 0.7], rects: (s) => [[0, 0, 1, s], [0, s, 0.5, 1 - s], [0.5, s, 0.5, 1 - s]] },
  { id: 'cols3', label: 'Trois colonnes', n: 3, s: [1 / 3, 1 / 3], rects: () => [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
  { id: 'rows3', label: 'Trois bandes', n: 3, s: [1 / 3, 1 / 3], rects: () => [[0, 0, 1, 1 / 3], [0, 1 / 3, 1, 1 / 3], [0, 2 / 3, 1, 1 / 3]] },
  { id: 'grid4', label: 'Grille', n: 4, s: [0.4, 0.6], rects: (s) => [[0, 0, s, 0.5], [s, 0, 1 - s, 0.5], [0, 0.5, s, 0.5], [s, 0.5, 1 - s, 0.5]] },
  { id: 'bigL4', label: 'Grande + trois', n: 4, s: [0.5, 0.72], rects: (s) => [[0, 0, s, 1], [s, 0, 1 - s, 1 / 3], [s, 1 / 3, 1 - s, 1 / 3], [s, 2 / 3, 1 - s, 1 / 3]] },
  { id: 'bigT4', label: 'Grande + bandeau', n: 4, s: [0.5, 0.72], rects: (s) => [[0, 0, 1, s], [0, s, 1 / 3, 1 - s], [1 / 3, s, 1 / 3, 1 - s], [2 / 3, s, 1 / 3, 1 - s]] },
  { id: 'cols4', label: 'Quatre colonnes', n: 4, s: [0.25, 0.25], rects: () => [[0, 0, 0.25, 1], [0.25, 0, 0.25, 1], [0.5, 0, 0.25, 1], [0.75, 0, 0.25, 1]] },
];

export const layoutsFor = (n: number) => LAYOUTS.filter((l) => l.n === n);

function permutations(n: number): number[][] {
  if (n <= 1) return [[0]];
  const out: number[][] = [];
  const rec = (arr: number[], rest: number[]) => {
    if (!rest.length) return void out.push(arr);
    rest.forEach((v, i) => rec([...arr, v], [...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  rec([], [...Array(n).keys()]);
  return out;
}
const PERMS = [1, 2, 3, 4].map(permutations);

export interface CollageResult {
  id: string;
  rects: Rect[];
  /** order[i] = indice de la photo placée dans la case i. */
  order: number[];
  cost: number;
}

/**
 * Meilleure disposition pour des photos de ratios `aspects` dans un cadre de ratio `outAspect`.
 * `forced` impose une disposition (sinon automatique). L'ordre chronologique est légèrement favorisé.
 */
export function bestCollage(aspects: number[], outAspect: number, forced?: string | null): CollageResult {
  const n = Math.min(4, aspects.length);
  const candidates = layoutsFor(n).filter((l) => !forced || l.id === forced);
  const pool = candidates.length ? candidates : layoutsFor(n);
  let best: CollageResult = { id: pool[0].id, rects: pool[0].rects(0.5), order: [...Array(n).keys()], cost: Infinity };
  for (const l of pool) {
    const steps = l.s[0] === l.s[1] ? [l.s[0]] : [0, 0.25, 0.5, 0.75, 1].map((k) => l.s[0] + (l.s[1] - l.s[0]) * k);
    for (const s of steps) {
      const rects = l.rects(s);
      for (const order of PERMS[n - 1]) {
        let cost = 0;
        rects.forEach((r, i) => {
          const cellAspect = (r[2] * outAspect) / r[3];
          const a = aspects[order[i]];
          // rognage : écart logarithmique entre la case et la photo
          cost += Math.abs(Math.log(cellAspect / a)) * (0.6 + r[2] * r[3]);
          // case trop étroite ou trop plate
          if (cellAspect < 0.4 || cellAspect > 3.2) cost += 1.5;
        });
        // on préfère garder l'ordre chronologique et des cases équilibrées
        cost += order.reduce((c, v, i) => c + (v === i ? 0 : 0.04), 0);
        cost += Math.abs(s - 0.5) * 0.1;
        if (cost < best.cost) best = { id: l.id, rects, order, cost };
      }
    }
  }
  return best;
}
