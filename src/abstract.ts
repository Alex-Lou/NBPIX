/**
 * L'abstraction en pixels de Gerstner et al., *Pixelated Image Abstraction* (NPAR 2012) —
 * l'algorithme que l'en-tête de pixelize.ts nommait déjà en le remettant à plus tard.
 *
 * Ce module existe **à côté** de pixelize.ts et non à sa place. La chaîne historique réduit *puis*
 * quantifie : deux étapes indépendantes, donc une photo réduite dont on a limité les couleurs, et
 * ses défauts ont été réglés pour minimiser l'écart de couleur à la photo — l'inverse de ce qu'on
 * demande à du pixel art. Ici la découpe (superpixels.ts) et la palette (annealing.ts) sont
 * résolues ensemble, en alternance, jusqu'à converger.
 *
 *     initialiser superpixels, palette, température T
 *     tant que T > Tf :
 *         affiner les superpixels
 *         associer puis affiner la palette
 *         si la palette a convergé : T ← αT, puis étendre la palette
 *     saturer la palette
 */

import { fromLab } from './game/lab.ts';
import type { Rgba } from './game/png.ts';
import type { Bitmap, Box } from './pixels.ts';
import { bitmap } from './pixels.ts';
import { annealingOn, criticalTemperature, meanColorOf } from './annealing.ts';
import { sourceOf, superpixelsOn } from './superpixels.ts';

const COOLING = 0.7;

/** Le papier s'arrête à 1 pour éviter les erreurs de troncature. */
const FINAL_TEMPERATURE = 1;

/** Déplacement moyen des amas en deçà duquel la palette est considérée stable. */
const PALETTE_SETTLED = 0.25;

/** Garde-fou : une image pathologique ne doit pas faire tourner la boucle indéfiniment. */
const MAX_PASSES = 400;

export interface AbstractOptions {
  readonly width: number;
  readonly height: number;
  /** Couleurs au plus, la transparence à part. */
  readonly colors: number;
  /** Canaux a et b multipliés par ça. Le papier prend 1,1 sur toutes ses images. */
  readonly saturation: number;
  /**
   * Pixels de source par pixel de sortie, sur un axe. Le coût est en `width × height × detail²` :
   * c'est le seul bouton qui achète du temps contre de la finesse de découpe.
   */
  readonly detail: number;
}

export interface Abstracted {
  readonly cell: Bitmap;
  readonly palette: readonly Rgba[];
  readonly passes: number;
}

export function abstractToPixels(
  image: Bitmap,
  on: Uint8Array,
  box: Box,
  options: AbstractOptions,
): Abstracted {
  const outW = Math.max(1, Math.round(options.width));
  const outH = Math.max(1, Math.round(options.height));
  const cells = outW * outH;
  const source = sourceOf(image, on, box, outW * options.detail, outH * options.detail);

  const start = meanColorOf(source);
  const mine = new Int32Array(cells);
  const pixels = superpixelsOn(source, outW, outH);
  // Un premier découpage sur la couleur moyenne : la palette a besoin de vraies couleurs de
  // superpixels pour choisir la direction dans laquelle son premier amas se scindera.
  pixels.step([start], mine);
  const palette = annealingOn(start, options.colors, pixels.colors, cells);

  let temperature = 1.1 * criticalTemperature(source, start);
  let passes = 0;
  while (temperature > FINAL_TEMPERATURE && passes < MAX_PASSES) {
    passes++;
    pixels.step(palette.colors, mine);
    const moved = palette.pass(pixels.colors, pixels.weight, cells, temperature, mine);
    if (moved >= PALETTE_SETTLED) continue;
    temperature *= COOLING;
    palette.expand(options.colors, pixels.colors, cells);
  }

  return drawn(palette.colors, mine, pixels.weight, outW, outH, options.saturation, passes);
}

function drawn(
  colors: readonly (readonly [number, number, number])[],
  mine: Int32Array,
  weight: Float64Array,
  outW: number,
  outH: number,
  saturation: number,
  passes: number,
): Abstracted {
  const shown = colors.map((lab) => {
    const [r, g, b] = fromLab(lab[0], lab[1] * saturation, lab[2] * saturation);
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
  return {
    cell,
    palette: [...used].sort((a, b) => a - b).map((k) => shown[k] as Rgba),
    passes,
  };
}
