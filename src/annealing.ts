/**
 * La moitié « palette » de l'abstraction (Gerstner et al. §4.3) : un recuit déterministe à masse
 * contrainte (Rose 1998).
 *
 * Chaque couleur est portée par deux sous-amas. À haute température un superpixel appartient un
 * peu à toutes les couleurs ; en refroidissant il choisit, et une couleur dont les sous-amas se
 * sont assez écartés en vaut deux. Rien n'est tiré au sort : l'écartement suit l'axe principal du
 * nuage, qui se calcule — deux exécutions donnent donc la même palette.
 */

import type { Lab, Source } from './superpixels.ts';

/** Deux sous-amas plus éloignés que ça valent deux couleurs distinctes. */
const SPLIT = 0.6;

/** De combien on écarte les deux sous-amas d'une couleur, le long de son axe principal. */
const NUDGE = 0.8;

interface Color {
  lab: Lab;
  one: Lab;
  two: Lab;
}

export interface Annealing {
  readonly colors: readonly Lab[];
  /**
   * Associe les superpixels aux couleurs puis affine celles-ci. Écrit dans `mine` la couleur
   * retenue par superpixel, et rend le déplacement **moyen** des amas.
   *
   * En moyenne et non en cumulé : une somme devient d'autant plus dure à satisfaire que la palette
   * grandit, si bien qu'elle ne converge plus, le refroidissement ne se déclenche plus, et la
   * boucle tourne jusqu'à son garde-fou en ne rendant qu'une poignée de couleurs.
   */
  readonly pass: (
    from: Float64Array,
    weight: Float64Array,
    cells: number,
    temperature: number,
    mine: Int32Array,
  ) => number;
  /** Scinde ce qui doit l'être, sans dépasser `most`, puis réécarte tous les sous-amas. */
  readonly expand: (most: number, from: Float64Array, cells: number) => void;
}

export function annealingOn(
  start: Lab,
  most: number,
  from: Float64Array,
  cells: number,
): Annealing {
  const room = Math.max(2, most) * 2;
  const palette: Color[] = [{ lab: start, one: start, two: start }];
  const odds = new Float64Array(room).fill(0);
  odds[0] = 0.5;
  odds[1] = 0.5;
  const sum = new Float64Array(room * 3);
  const mass = new Float64Array(room);
  const live = new Float64Array(room);
  const shown: Lab[] = [];

  nudgeApart(palette[0] as Color, from, cells);

  function refreshShown(): readonly Lab[] {
    shown.length = 0;
    for (const colour of palette) shown.push(colour.lab);
    return shown;
  }

  return {
    get colors() {
      return refreshShown();
    },

    pass: (colorsOf, weight, count, temperature, mine) => {
      const subs = palette.length * 2;
      sum.fill(0, 0, subs * 3);
      mass.fill(0, 0, subs);
      let alive = 0;
      for (let s = 0; s < count; s++) if ((weight[s] ?? 0) > 0) alive++;
      if (alive === 0) return 0;
      const share = 1 / alive;

      for (let s = 0; s < count; s++) {
        if ((weight[s] ?? 0) === 0) continue;
        const L = colorsOf[s * 3] ?? 0;
        const A = colorsOf[s * 3 + 1] ?? 0;
        const B = colorsOf[s * 3 + 2] ?? 0;
        let total = 0;
        for (let k = 0; k < palette.length; k++) {
          const colour = palette[k] as Color;
          for (let half = 0; half < 2; half++) {
            const c = half === 0 ? colour.one : colour.two;
            const d = Math.hypot(L - c[0], A - c[1], B - c[2]);
            const p = (odds[k * 2 + half] ?? 0) * Math.exp(-d / temperature);
            live[k * 2 + half] = p;
            total += p;
          }
        }
        if (total <= 0) continue;
        let bestK = 0;
        let bestP = -1;
        for (let k = 0; k < palette.length; k++) {
          const p = (live[k * 2] ?? 0) + (live[k * 2 + 1] ?? 0);
          if (p > bestP) {
            bestP = p;
            bestK = k;
          }
        }
        mine[s] = bestK;
        for (let i = 0; i < subs; i++) {
          const p = ((live[i] ?? 0) / total) * share;
          mass[i] = (mass[i] ?? 0) + p;
          sum[i * 3] = (sum[i * 3] ?? 0) + p * L;
          sum[i * 3 + 1] = (sum[i * 3 + 1] ?? 0) + p * A;
          sum[i * 3 + 2] = (sum[i * 3 + 2] ?? 0) + p * B;
        }
      }

      let moved = 0;
      for (let k = 0; k < palette.length; k++) {
        const colour = palette[k] as Color;
        for (let half = 0; half < 2; half++) {
          const i = k * 2 + half;
          const m = mass[i] ?? 0;
          odds[i] = m;
          if (m <= 1e-9) continue;
          const next: Lab = [
            (sum[i * 3] ?? 0) / m,
            (sum[i * 3 + 1] ?? 0) / m,
            (sum[i * 3 + 2] ?? 0) / m,
          ];
          const was = half === 0 ? colour.one : colour.two;
          moved += Math.hypot(next[0] - was[0], next[1] - was[1], next[2] - was[2]);
          if (half === 0) colour.one = next;
          else colour.two = next;
        }
        colour.lab = [
          (colour.one[0] + colour.two[0]) / 2,
          (colour.one[1] + colour.two[1]) / 2,
          (colour.one[2] + colour.two[2]) / 2,
        ];
      }
      return moved / subs;
    },

    expand: (limit, colorsOf, count) => {
      // La masse de probabilité suit les couleurs : une couleur née d'une scission hérite de celle
      // du sous-amas dont elle sort, sans quoi elle démarre avec une masse qui n'est pas la sienne.
      if (limit > 0 && palette.length < limit) {
        const was = palette.length;
        for (let k = 0; k < was && palette.length < limit; k++) {
          const colour = palette[k] as Color;
          const gap = Math.hypot(
            colour.one[0] - colour.two[0],
            colour.one[1] - colour.two[1],
            colour.one[2] - colour.two[2],
          );
          if (gap <= SPLIT) continue;
          const kept = (odds[k * 2] ?? 0) / 2;
          const born = (odds[k * 2 + 1] ?? 0) / 2;
          const child: Color = { lab: colour.two, one: colour.two, two: colour.two };
          colour.lab = colour.one;
          colour.two = colour.one;
          odds[k * 2] = kept;
          odds[k * 2 + 1] = kept;
          odds[palette.length * 2] = born;
          odds[palette.length * 2 + 1] = born;
          palette.push(child);
        }
      }
      let total = 0;
      for (let i = 0; i < palette.length * 2; i++) total += odds[i] ?? 0;
      for (let i = 0; i < palette.length * 2; i++) {
        odds[i] = total > 0 ? (odds[i] ?? 0) / total : 1 / (palette.length * 2);
      }
      for (const colour of palette) nudgeApart(colour, colorsOf, count);
    },
  };
}

/** Les deux sous-amas d'une couleur, écartés le long de l'axe principal du nuage. */
function nudgeApart(colour: Color, from: Float64Array, cells: number): void {
  const axis = dominantOf(covarianceOf(from, cells, colour.lab));
  colour.one = [
    colour.lab[0] + NUDGE * axis[0],
    colour.lab[1] + NUDGE * axis[1],
    colour.lab[2] + NUDGE * axis[2],
  ];
  colour.two = [
    colour.lab[0] - NUDGE * axis[0],
    colour.lab[1] - NUDGE * axis[1],
    colour.lab[2] - NUDGE * axis[2],
  ];
}

/** La couleur moyenne du sujet, d'où part la palette. */
export function meanColorOf(source: Source): Lab {
  let L = 0;
  let A = 0;
  let B = 0;
  let count = 0;
  for (let at = 0; at < source.on.length; at++) {
    if ((source.on[at] ?? 0) === 0) continue;
    L += source.lab[at * 3] ?? 0;
    A += source.lab[at * 3 + 1] ?? 0;
    B += source.lab[at * 3 + 2] ?? 0;
    count++;
  }
  return count === 0 ? [0, 0, 0] : [L / count, A / count, B / count];
}

/**
 * La température à laquelle un amas se scinde naturellement : deux fois la variance le long de
 * l'axe principal du nuage (Rose 1998). Partir juste au-dessus garantit qu'on commence bien avec
 * une seule couleur.
 */
export function criticalTemperature(source: Source, centre: Lab): number {
  const cov = new Float64Array(9);
  let count = 0;
  for (let at = 0; at < source.on.length; at++) {
    if ((source.on[at] ?? 0) === 0) continue;
    addSpread(
      cov,
      (source.lab[at * 3] ?? 0) - centre[0],
      (source.lab[at * 3 + 1] ?? 0) - centre[1],
      (source.lab[at * 3 + 2] ?? 0) - centre[2],
    );
    count++;
  }
  if (count === 0) return 1;
  const axis = dominantOf(cov);
  let sum = 0;
  for (let at = 0; at < source.on.length; at++) {
    if ((source.on[at] ?? 0) === 0) continue;
    const d =
      ((source.lab[at * 3] ?? 0) - centre[0]) * axis[0] +
      ((source.lab[at * 3 + 1] ?? 0) - centre[1]) * axis[1] +
      ((source.lab[at * 3 + 2] ?? 0) - centre[2]) * axis[2];
    sum += d * d;
  }
  return (2 * sum) / count;
}

function covarianceOf(from: Float64Array, cells: number, centre: Lab): Float64Array {
  const cov = new Float64Array(9);
  for (let s = 0; s < cells; s++) {
    addSpread(
      cov,
      (from[s * 3] ?? 0) - centre[0],
      (from[s * 3 + 1] ?? 0) - centre[1],
      (from[s * 3 + 2] ?? 0) - centre[2],
    );
  }
  return cov;
}

function addSpread(cov: Float64Array, dL: number, dA: number, dB: number): void {
  const d = [dL, dA, dB];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      cov[i * 3 + j] = (cov[i * 3 + j] ?? 0) + (d[i] ?? 0) * (d[j] ?? 0);
    }
  }
}

/** Le vecteur propre dominant d'une covariance 3×3, par itération de puissance. */
function dominantOf(cov: Float64Array): Lab {
  let v: Lab = [1, 1, 1];
  for (let turn = 0; turn < 24; turn++) {
    const n: Lab = [
      (cov[0] ?? 0) * v[0] + (cov[1] ?? 0) * v[1] + (cov[2] ?? 0) * v[2],
      (cov[3] ?? 0) * v[0] + (cov[4] ?? 0) * v[1] + (cov[5] ?? 0) * v[2],
      (cov[6] ?? 0) * v[0] + (cov[7] ?? 0) * v[1] + (cov[8] ?? 0) * v[2],
    ];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-12) return [1, 0, 0];
    v = [n[0] / len, n[1] / len, n[2] / len];
  }
  return v;
}
