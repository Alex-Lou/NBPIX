/**
 * L'abstraction en pixels de Gerstner et al., *Pixelated Image Abstraction* (NPAR 2012) —
 * l'algorithme que l'en-tête de pixelize.ts nommait déjà en le remettant à plus tard.
 *
 * **Pourquoi ce module existe à côté de pixelize.ts et non à sa place.** La chaîne historique
 * réduit *puis* quantifie : deux étapes indépendantes, donc une photo réduite dont on a limité les
 * couleurs. C'est un filtre, et ses défauts ont été réglés pour minimiser le ΔE — la fidélité à la
 * photo — ce qui est exactement l'inverse de ce qu'on demande à du pixel art. Ici les deux étapes
 * sont résolues **ensemble** : la découpe de l'image et la palette s'optimisent l'une contre
 * l'autre jusqu'à converger. Les auteurs montrent par une étude avec des pixel artists que ça bat
 * les méthodes naïves.
 *
 * Les deux chaînes cohabitent : celle d'origine reste testée et mesurée, celle-ci se juge à l'œil.
 *
 * L'algorithme, tel que le papier le pose (§4) :
 *
 *     initialiser superpixels, palette, température T
 *     tant que T > Tf :
 *         affiner les superpixels (un pas de SLIC modifié)
 *         associer les superpixels aux couleurs de la palette
 *         affiner les couleurs de la palette
 *         si la palette a convergé : T ← αT, puis étendre la palette
 *     saturer la palette
 *
 * Trois écarts au SLIC d'origine, et c'est là que tout se joue :
 *
 * 1. La couleur d'un superpixel dans le calcul de distance est **celle de la palette** qui lui est
 *    associée, pas sa moyenne. Sans ça les pixels se regroupent sur des couleurs qui n'existeront
 *    pas dans l'image finale.
 * 2. Un lissage laplacien des centres, parce que SLIC tend vers un voisinage hexagonal quand la
 *    sortie, elle, est une grille rectangulaire : sans lui les formes se tordent.
 * 3. Un filtre bilatéral sur les couleurs représentatives, pour qu'un dégradé continu le reste
 *    une fois pixelisé.
 */

import type { Rgba } from './game/png.ts';
import { fromLab, toLab } from './game/lab.ts';
import type { Bitmap, Box } from './pixels.ts';
import { bitmap, widthOf } from './pixels.ts';

/** Le poids de la distance spatiale. Le papier prend 45 là où SLIC d'origine prend 10 : la palette
 * fait porter l'erreur de couleur, donc on tient à des superpixels de taille régulière. */
const COMPACTNESS = 45;

/** Part du chemin parcourue vers la moyenne des 4 voisins, à chaque pas (papier : 40 %). */
const LAPLACIAN = 0.4;

/** De combien la température baisse quand la palette a convergé (papier : 0,7). */
const COOLING = 0.7;

/** La température finale. Le papier s'arrête à 1 pour éviter les erreurs de troncature. */
const FINAL_TEMPERATURE = 1;

/**
 * La palette a convergé quand ses amas ont bougé, **en moyenne**, moins que ça en unités Lab.
 *
 * En moyenne et non en cumulé : une somme devient d'autant plus dure à satisfaire que la palette
 * grandit, si bien qu'au-delà de quelques couleurs elle ne converge plus jamais, le refroidissement
 * ne se déclenche plus et la boucle tourne jusqu'à son garde-fou.
 */
const PALETTE_SETTLED = 0.25;

/** Deux sous-amas plus éloignés que ça valent deux couleurs distinctes. */
const CLUSTER_SPLIT = 0.6;

/** De combien on écarte les deux sous-amas d'une couleur, le long de son axe principal. */
const NUDGE = 0.8;

/** Garde-fou : une image pathologique ne doit pas faire tourner la boucle indéfiniment. */
const MAX_PASSES = 400;

export interface AbstractOptions {
  /** La taille de la sortie, en pixels. */
  readonly width: number;
  readonly height: number;
  /** Combien de couleurs au plus, la transparence à part. */
  readonly colors: number;
  /**
   * Saturation finale : les canaux a et b multipliés par ça. Le papier prend 1,1 pour toutes ses
   * images et appelle ça « une technique habituelle du pixel artist ». C'en est une.
   */
  readonly saturation: number;
  /**
   * Combien de pixels de source par pixel de sortie, sur un axe. L'algorithme coûte à peu près
   * `width × height × detail²` par passe : c'est le seul bouton qui achète du temps contre de la
   * finesse de découpe. Au-delà de 6 le gain devient invisible et l'attente, non.
   */
  readonly detail: number;
}

export interface Abstracted {
  readonly cell: Bitmap;
  readonly palette: readonly Rgba[];
  /** Combien de passes il a fallu : ce qu'on regarde quand on se demande pourquoi c'est lent. */
  readonly passes: number;
}

/** Un amas de la palette : sa couleur, et les deux sous-amas dont la séparation la fera scinder. */
interface Color {
  lab: [number, number, number];
  one: [number, number, number];
  two: [number, number, number];
}

/**
 * Le sujet d'une image, rendu sur une grille de `width × height` pixels et une palette d'au plus
 * `colors` couleurs, les deux résolus ensemble.
 *
 * `on` dit quels pixels de `image` sont le sujet ; seuls ceux-là comptent, et un pixel de sortie
 * qui n'en couvre aucun reste transparent. Déterministe : mêmes entrées, même sortie, sans tirage
 * aléatoire nulle part — la perturbation des sous-amas suit l'axe principal, qui est calculé.
 */
export function abstractToPixels(
  image: Bitmap,
  on: Uint8Array,
  box: Box,
  options: AbstractOptions,
): Abstracted {
  const outW = Math.max(1, Math.round(options.width));
  const outH = Math.max(1, Math.round(options.height));
  const source = sampled(image, on, box, outW * options.detail, outH * options.detail);
  return run(source, outW, outH, options);
}

/** La source ramenée à une taille qui tient le coût, en Lab, avec le sujet marqué. */
interface Source {
  readonly width: number;
  readonly height: number;
  /** L, a, b par pixel. */
  readonly lab: Float32Array;
  /** 1 si le pixel appartient au sujet. */
  readonly on: Uint8Array;
}

/**
 * La boîte du sujet rééchantillonnée à au plus `maxW × maxH`, au plus proche voisin. Au plus
 * proche et non en moyenne : moyenner mêlerait le sujet au fond sur tout le contour, et c'est
 * précisément le bord qu'on cherche à garder franc.
 */
function sampled(image: Bitmap, on: Uint8Array, box: Box, maxW: number, maxH: number): Source {
  const inW = widthOf(box);
  const inH = box.bottom - box.top + 1;
  const width = Math.max(1, Math.min(inW, Math.round(maxW)));
  const height = Math.max(1, Math.min(inH, Math.round(maxH)));
  const lab = new Float32Array(width * height * 3);
  const kept = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = box.top + Math.min(inH - 1, Math.floor(((y + 0.5) * inH) / height));
    for (let x = 0; x < width; x++) {
      const sx = box.left + Math.min(inW - 1, Math.floor(((x + 0.5) * inW) / width));
      const from = sy * image.width + sx;
      const at = y * width + x;
      if ((on[from] ?? 0) === 0) continue;
      kept[at] = 1;
      const [L, A, B] = toLab(
        image.data[from * 4] ?? 0,
        image.data[from * 4 + 1] ?? 0,
        image.data[from * 4 + 2] ?? 0,
      );
      lab[at * 3] = L;
      lab[at * 3 + 1] = A;
      lab[at * 3 + 2] = B;
    }
  }
  return { width, height, lab, on: kept };
}

function run(source: Source, outW: number, outH: number, options: AbstractOptions): Abstracted {
  const cells = outW * outH;
  const stepX = source.width / outW;
  const stepY = source.height / outH;

  // Les centres, posés sur une grille régulière (§4.1).
  const centreX = new Float64Array(cells);
  const centreY = new Float64Array(cells);
  for (let sy = 0; sy < outH; sy++) {
    for (let sx = 0; sx < outW; sx++) {
      centreX[sy * outW + sx] = (sx + 0.5) * stepX;
      centreY[sy * outW + sx] = (sy + 0.5) * stepY;
    }
  }

  /** La couleur moyenne de chaque superpixel, puis sa version filtrée : c'est elle qui sert. */
  const mean = new Float64Array(cells * 3);
  const smoothed = new Float64Array(cells * 3);
  const weight = new Float64Array(cells);
  /** À quelle couleur de la palette chaque superpixel est associé. */
  const mine = new Int32Array(cells);
  const owner = new Int32Array(source.width * source.height);

  // La palette part d'une seule couleur : la moyenne du sujet (§4.1).
  const start = meanOf(source);
  const palette: Color[] = [{ lab: [...start], one: [...start], two: [...start] }];
  for (let s = 0; s < cells; s++) {
    mean[s * 3] = start[0];
    mean[s * 3 + 1] = start[1];
    mean[s * 3 + 2] = start[2];
    smoothed[s * 3] = start[0];
    smoothed[s * 3 + 1] = start[1];
    smoothed[s * 3 + 2] = start[2];
  }
  nudgeApart(palette[0] as Color, smoothed, cells);

  // T = 1,1 × Tc, où Tc est deux fois la variance le long de l'axe principal (§4.1).
  let temperature = 1.1 * criticalOf(source, start);
  /** P(c) par sous-amas : deux entrées par couleur, dans l'ordre (one, two). */
  let odds: Float64Array = new Float64Array([0.5, 0.5]);

  let passes = 0;
  while (temperature > FINAL_TEMPERATURE && passes < MAX_PASSES) {
    passes++;
    assign(source, outW, outH, stepX, stepY, centreX, centreY, palette, mine, owner);
    gather(source, cells, owner, mean, centreX, centreY, weight);
    relax(outW, outH, centreX, centreY, stepX, stepY);
    bilateral(outW, outH, mean, smoothed, weight);
    const moved = palettePass(palette, odds, smoothed, weight, cells, temperature, mine);
    if (moved < PALETTE_SETTLED) {
      temperature *= COOLING;
      odds = expand(palette, odds, options.colors, smoothed, cells);
    }
  }

  return draw(palette, mine, weight, outW, outH, options.saturation, passes);
}

/** La couleur moyenne du sujet, en Lab. */
function meanOf(source: Source): [number, number, number] {
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
 * La température critique : deux fois la variance le long de l'axe principal du nuage de couleurs
 * (Rose 1998). C'est la température à laquelle un amas se scinde naturellement, donc partir juste
 * au-dessus garantit qu'on commence bien avec une seule couleur.
 */
function criticalOf(source: Source, centre: readonly [number, number, number]): number {
  const axis = axisOfSource(source, centre);
  let sum = 0;
  let count = 0;
  for (let at = 0; at < source.on.length; at++) {
    if ((source.on[at] ?? 0) === 0) continue;
    const d =
      ((source.lab[at * 3] ?? 0) - centre[0]) * axis[0] +
      ((source.lab[at * 3 + 1] ?? 0) - centre[1]) * axis[1] +
      ((source.lab[at * 3 + 2] ?? 0) - centre[2]) * axis[2];
    sum += d * d;
    count++;
  }
  return count === 0 ? 1 : (2 * sum) / count;
}

/**
 * L'axe principal du nuage de couleurs de la source, par itération de puissance sur sa
 * covariance. Trois dimensions : quelques tours suffisent, et c'est déterministe — contrairement à
 * un tirage, deux exécutions donnent le même axe, donc la même image.
 */
function axisOfSource(
  source: Source,
  centre: readonly [number, number, number],
): [number, number, number] {
  const cov = new Float64Array(9);
  for (let at = 0; at < source.on.length; at++) {
    if ((source.on[at] ?? 0) === 0) continue;
    const d = [
      (source.lab[at * 3] ?? 0) - centre[0],
      (source.lab[at * 3 + 1] ?? 0) - centre[1],
      (source.lab[at * 3 + 2] ?? 0) - centre[2],
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        cov[i * 3 + j] = (cov[i * 3 + j] ?? 0) + (d[i] ?? 0) * (d[j] ?? 0);
      }
    }
  }
  return dominantOf(cov);
}

/** Le vecteur propre dominant d'une covariance 3×3, par itération de puissance. */
function dominantOf(cov: Float64Array): [number, number, number] {
  let v: [number, number, number] = [1, 1, 1];
  for (let turn = 0; turn < 24; turn++) {
    const n: [number, number, number] = [
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

/**
 * Un pas de SLIC modifié (§4.2) : chaque pixel du sujet va au superpixel qui minimise la distance,
 * où la couleur du superpixel est **celle de sa couleur de palette** et non sa moyenne.
 */
function assign(
  source: Source,
  outW: number,
  outH: number,
  stepX: number,
  stepY: number,
  centreX: Float64Array,
  centreY: Float64Array,
  palette: readonly Color[],
  mine: Int32Array,
  owner: Int32Array,
): void {
  owner.fill(-1);
  const best = new Float64Array(source.width * source.height).fill(Infinity);
  // Le poids spatial de SLIC : (m / S)², avec S le pas de la grille.
  const spread = Math.max(stepX, stepY);
  const spatial = (COMPACTNESS / Math.max(1e-6, spread)) ** 2;
  const reachX = Math.ceil(stepX);
  const reachY = Math.ceil(stepY);
  for (let sy = 0; sy < outH; sy++) {
    for (let sx = 0; sx < outW; sx++) {
      const s = sy * outW + sx;
      const colour = palette[mine[s] ?? 0]?.lab ?? [0, 0, 0];
      const cx = centreX[s] ?? 0;
      const cy = centreY[s] ?? 0;
      const fromY = Math.max(0, Math.floor(cy - reachY));
      const toY = Math.min(source.height - 1, Math.ceil(cy + reachY));
      const fromX = Math.max(0, Math.floor(cx - reachX));
      const toX = Math.min(source.width - 1, Math.ceil(cx + reachX));
      for (let y = fromY; y <= toY; y++) {
        for (let x = fromX; x <= toX; x++) {
          const at = y * source.width + x;
          if ((source.on[at] ?? 0) === 0) continue;
          const dL = (source.lab[at * 3] ?? 0) - colour[0];
          const dA = (source.lab[at * 3 + 1] ?? 0) - colour[1];
          const dB = (source.lab[at * 3 + 2] ?? 0) - colour[2];
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          const d = dL * dL + dA * dA + dB * dB + spatial * (dx * dx + dy * dy);
          if (d >= (best[at] ?? Infinity)) continue;
          best[at] = d;
          owner[at] = s;
        }
      }
    }
  }
}

/** La moyenne de couleur et de position de chaque superpixel, d'après ce qu'il a récolté. */
function gather(
  source: Source,
  cells: number,
  owner: Int32Array,
  mean: Float64Array,
  centreX: Float64Array,
  centreY: Float64Array,
  weight: Float64Array,
): void {
  const sumX = new Float64Array(cells);
  const sumY = new Float64Array(cells);
  mean.fill(0);
  weight.fill(0);
  for (let at = 0; at < owner.length; at++) {
    const s = owner[at] ?? -1;
    if (s < 0) continue;
    mean[s * 3] = (mean[s * 3] ?? 0) + (source.lab[at * 3] ?? 0);
    mean[s * 3 + 1] = (mean[s * 3 + 1] ?? 0) + (source.lab[at * 3 + 1] ?? 0);
    mean[s * 3 + 2] = (mean[s * 3 + 2] ?? 0) + (source.lab[at * 3 + 2] ?? 0);
    sumX[s] = (sumX[s] ?? 0) + ((at % source.width) + 0.5);
    sumY[s] = (sumY[s] ?? 0) + (Math.floor(at / source.width) + 0.5);
    weight[s] = (weight[s] ?? 0) + 1;
  }
  for (let s = 0; s < cells; s++) {
    const n = weight[s] ?? 0;
    if (n === 0) continue;
    mean[s * 3] = (mean[s * 3] ?? 0) / n;
    mean[s * 3 + 1] = (mean[s * 3 + 1] ?? 0) / n;
    mean[s * 3 + 2] = (mean[s * 3 + 2] ?? 0) / n;
    centreX[s] = (sumX[s] ?? 0) / n;
    centreY[s] = (sumY[s] ?? 0) / n;
  }
}

/**
 * Le lissage laplacien des centres (§4.2). SLIC tend vers un voisinage hexagonal ; la sortie est
 * une grille rectangulaire. Sans ce rappel vers les 4 voisins de la grille, les formes se tordent
 * — le papier le montre sur une oreille et un œil.
 */
function relax(
  outW: number,
  outH: number,
  centreX: Float64Array,
  centreY: Float64Array,
  stepX: number,
  stepY: number,
): void {
  const wasX = Float64Array.from(centreX);
  const wasY = Float64Array.from(centreY);
  for (let sy = 0; sy < outH; sy++) {
    for (let sx = 0; sx < outW; sx++) {
      const s = sy * outW + sx;
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      const look = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= outW || ny >= outH) return;
        sumX += wasX[ny * outW + nx] ?? 0;
        sumY += wasY[ny * outW + nx] ?? 0;
        count++;
      };
      look(sx - 1, sy);
      look(sx + 1, sy);
      look(sx, sy - 1);
      look(sx, sy + 1);
      if (count === 0) continue;
      centreX[s] = (wasX[s] ?? 0) + LAPLACIAN * (sumX / count - (wasX[s] ?? 0));
      centreY[s] = (wasY[s] ?? 0) + LAPLACIAN * (sumY / count - (wasY[s] ?? 0));
      // Un centre ne doit pas dériver au point de quitter sa case : la grille resterait régulière
      // en apparence, mais un superpixel en recouvrirait un autre.
      const homeX = (sx + 0.5) * stepX;
      const homeY = (sy + 0.5) * stepY;
      centreX[s] = Math.max(homeX - stepX, Math.min(homeX + stepX, centreX[s] ?? homeX));
      centreY[s] = Math.max(homeY - stepY, Math.min(homeY + stepY, centreY[s] ?? homeY));
    }
  }
}

/** Rayon du filtre bilatéral, en pixels de sortie. */
const BLUR_REACH = 2;
const BLUR_SPACE = 1.5;
const BLUR_RANGE = 12;

/**
 * Le filtre bilatéral sur les couleurs représentatives (§4.2). Un dégradé continu — une surface en
 * ombre douce — reste continu une fois pixelisé, au lieu de se casser en marches.
 */
function bilateral(
  outW: number,
  outH: number,
  mean: Float64Array,
  into: Float64Array,
  weight: Float64Array,
): void {
  for (let sy = 0; sy < outH; sy++) {
    for (let sx = 0; sx < outW; sx++) {
      const s = sy * outW + sx;
      if ((weight[s] ?? 0) === 0) {
        into[s * 3] = mean[s * 3] ?? 0;
        into[s * 3 + 1] = mean[s * 3 + 1] ?? 0;
        into[s * 3 + 2] = mean[s * 3 + 2] ?? 0;
        continue;
      }
      let L = 0;
      let A = 0;
      let B = 0;
      let total = 0;
      for (let dy = -BLUR_REACH; dy <= BLUR_REACH; dy++) {
        const ny = sy + dy;
        if (ny < 0 || ny >= outH) continue;
        for (let dx = -BLUR_REACH; dx <= BLUR_REACH; dx++) {
          const nx = sx + dx;
          if (nx < 0 || nx >= outW) continue;
          const n = ny * outW + nx;
          if ((weight[n] ?? 0) === 0) continue;
          const dL = (mean[n * 3] ?? 0) - (mean[s * 3] ?? 0);
          const dA = (mean[n * 3 + 1] ?? 0) - (mean[s * 3 + 1] ?? 0);
          const dB = (mean[n * 3 + 2] ?? 0) - (mean[s * 3 + 2] ?? 0);
          const w =
            Math.exp(-(dx * dx + dy * dy) / (2 * BLUR_SPACE * BLUR_SPACE)) *
            Math.exp(-(dL * dL + dA * dA + dB * dB) / (2 * BLUR_RANGE * BLUR_RANGE));
          L += w * (mean[n * 3] ?? 0);
          A += w * (mean[n * 3 + 1] ?? 0);
          B += w * (mean[n * 3 + 2] ?? 0);
          total += w;
        }
      }
      into[s * 3] = total > 0 ? L / total : (mean[s * 3] ?? 0);
      into[s * 3 + 1] = total > 0 ? A / total : (mean[s * 3 + 1] ?? 0);
      into[s * 3 + 2] = total > 0 ? B / total : (mean[s * 3 + 2] ?? 0);
    }
  }
}

/**
 * Associer puis affiner (§4.3). P(ck|ps) ∝ P(ck)·exp(−‖ms−ck‖/T) : à haute température chaque
 * superpixel appartient un peu à toutes les couleurs, et en refroidissant il choisit. Rend de
 * combien la palette a bougé, ce qui dit si elle a convergé.
 */
function palettePass(
  palette: Color[],
  odds: Float64Array,
  smoothed: Float64Array,
  weight: Float64Array,
  cells: number,
  temperature: number,
  mine: Int32Array,
): number {
  const subs = palette.length * 2;
  const sum = new Float64Array(subs * 3);
  const mass = new Float64Array(subs);
  const live = new Float64Array(subs);
  let alive = 0;
  for (let s = 0; s < cells; s++) if ((weight[s] ?? 0) > 0) alive++;
  if (alive === 0) return 0;
  const share = 1 / alive;

  for (let s = 0; s < cells; s++) {
    if ((weight[s] ?? 0) === 0) continue;
    const L = smoothed[s * 3] ?? 0;
    const A = smoothed[s * 3 + 1] ?? 0;
    const B = smoothed[s * 3 + 2] ?? 0;
    let total = 0;
    for (let k = 0; k < palette.length; k++) {
      const colour = palette[k] as Color;
      for (const half of [0, 1] as const) {
        const c = half === 0 ? colour.one : colour.two;
        const d = Math.hypot(L - c[0], A - c[1], B - c[2]);
        const p = (odds[k * 2 + half] ?? 0) * Math.exp(-d / temperature);
        live[k * 2 + half] = p;
        total += p;
      }
    }
    if (total <= 0) continue;
    // La couleur retenue est celle dont les deux sous-amas pèsent le plus ensemble.
    let bestK = 0;
    let bestP = -1;
    for (let k = 0; k < palette.length; k++) {
      const p = ((live[k * 2] ?? 0) + (live[k * 2 + 1] ?? 0)) / total;
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
    for (const half of [0, 1] as const) {
      const i = k * 2 + half;
      const m = mass[i] ?? 0;
      odds[i] = m;
      if (m <= 1e-9) continue;
      const next: [number, number, number] = [
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
  return moved / Math.max(1, subs);
}

/**
 * Étendre la palette (§4.3) : une couleur dont les deux sous-amas se sont assez écartés en vaut
 * deux. Puis on réécarte tous les sous-amas le long de leur axe principal — Rose montre que c'est
 * la direction dans laquelle un amas se scinde — pour qu'ils puissent à nouveau se séparer.
 */
function expand(
  palette: Color[],
  odds: Float64Array,
  most: number,
  smoothed: Float64Array,
  cells: number,
): Float64Array {
  // La masse de probabilité suit les couleurs : une couleur née d'une scission hérite de celle du
  // sous-amas dont elle sort. Sans ce suivi elle démarre avec une masse qui ne lui appartient pas,
  // et la palette se remplit de couleurs que rien ne réclame.
  const mass: number[] = [];
  for (let k = 0; k < palette.length; k++) mass.push(odds[k * 2] ?? 0, odds[k * 2 + 1] ?? 0);

  if (most > 0 && palette.length < most) {
    const was = palette.length;
    for (let k = 0; k < was && palette.length < most; k++) {
      const colour = palette[k] as Color;
      const gap = Math.hypot(
        colour.one[0] - colour.two[0],
        colour.one[1] - colour.two[1],
        colour.one[2] - colour.two[2],
      );
      if (gap <= CLUSTER_SPLIT) continue;
      const mineMass = (mass[k * 2] ?? 0) / 2;
      const bornMass = (mass[k * 2 + 1] ?? 0) / 2;
      const born: Color = { lab: [...colour.two], one: [...colour.two], two: [...colour.two] };
      colour.lab = [...colour.one];
      colour.two = [...colour.one];
      mass[k * 2] = mineMass;
      mass[k * 2 + 1] = mineMass;
      palette.push(born);
      mass.push(bornMass, bornMass);
    }
  }
  for (let k = 0; k < palette.length; k++) {
    nudgeApart(palette[k] as Color, smoothed, cells);
  }
  const next = new Float64Array(palette.length * 2);
  let total = 0;
  for (let i = 0; i < next.length; i++) total += mass[i] ?? 0;
  for (let i = 0; i < next.length; i++) {
    next[i] = total > 0 ? (mass[i] ?? 0) / total : 1 / next.length;
  }
  return next;
}

/** Les deux sous-amas d'une couleur, écartés le long de l'axe principal du nuage. */
function nudgeApart(colour: Color, smoothed: Float64Array, cells: number): void {
  const axis = spreadOf(smoothed, cells, colour.lab);
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

/** L'axe principal du nuage des superpixels autour d'une couleur, par itération de puissance. */
function spreadOf(
  smoothed: Float64Array,
  cells: number,
  centre: readonly [number, number, number],
): [number, number, number] {
  const cov = new Float64Array(9);
  for (let s = 0; s < cells; s++) {
    const d = [
      (smoothed[s * 3] ?? 0) - centre[0],
      (smoothed[s * 3 + 1] ?? 0) - centre[1],
      (smoothed[s * 3 + 2] ?? 0) - centre[2],
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        cov[i * 3 + j] = (cov[i * 3 + j] ?? 0) + (d[i] ?? 0) * (d[j] ?? 0);
      }
    }
  }
  let v: [number, number, number] = [1, 1, 1];
  for (let turn = 0; turn < 24; turn++) {
    const n: [number, number, number] = [
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

/** La sortie : chaque superpixel prend sa couleur de palette, saturée (§4.4). */
function draw(
  palette: readonly Color[],
  mine: Int32Array,
  weight: Float64Array,
  outW: number,
  outH: number,
  saturation: number,
  passes: number,
): Abstracted {
  const shown = palette.map((colour) => {
    const [r, g, b] = fromLab(
      colour.lab[0],
      colour.lab[1] * saturation,
      colour.lab[2] * saturation,
    );
    return { r, g, b, a: 255 };
  });
  const cell = bitmap(outW, outH);
  const used = new Set<number>();
  for (let s = 0; s < outW * outH; s++) {
    if ((weight[s] ?? 0) === 0) continue;
    const k = Math.max(0, Math.min(shown.length - 1, mine[s] ?? 0));
    const colour = shown[k];
    if (!colour) continue;
    used.add(k);
    cell.data[s * 4] = colour.r;
    cell.data[s * 4 + 1] = colour.g;
    cell.data[s * 4 + 2] = colour.b;
    cell.data[s * 4 + 3] = 255;
  }
  return { cell, palette: [...used].sort((a, b) => a - b).map((k) => shown[k] as Rgba), passes };
}
