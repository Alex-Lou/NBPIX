/**
 * The chain that turns the placed subject into pixels (docs/methode.md §4). It is the one the
 * stages already use (docs/art/manifeste-pixel-art.md §2, tools/stage/sahel/adapt.ts), kept in
 * the same order and cut down to what a character needs:
 *
 *   Kuwahara → netteté → saturation → contour → palette → orphelins
 *
 * What a character needs that a stage does not: the outline is drawn on the silhouette's edge
 * (that dark 1 px line is most of what makes a sprite read against any background), and every
 * step works on the subject's pixels alone, so nothing bleeds in from the empty part of the cell.
 *
 * What is deliberately left out of this first version, and why:
 *
 * - **no dithering.** On a stage it only runs on gradients, on a character it is noise that
 *   swarms when the camera moves (docs/art/proprete.md). A sprite wants flat masses.
 * - **no palette slots.** The output is truecolour. Mapping onto a fighter's seven tones a
 *   material (tools/sprites/palette.ts) means telling a jacket's outline from a trouser's, which
 *   is a segmentation problem this tool does not solve: the result is an under-layer to draw over,
 *   not a strip the game can load.
 * - **median cut rather than the superpixel method.** Gerstner et al., *Pixelated Image
 *   Abstraction* (NPAR 2012), optimise the segmentation and the palette together, which beats a
 *   downscale followed by a quantisation; the parameters are written down in docs/methode.md §6
 *   for the day this is worth doing. Median cut is already here and already tested
 *   (tools/sprites/quantize.ts).
 */

import type { Rgba } from './game/png.ts';
import { quantizeRgba } from './game/quantize.ts';
import { fromLab, toLab } from './game/lab.ts';
import type { Master } from './style.ts';
import type { Bitmap } from './pixels.ts';
import { byteOf, copyOf, linearOf } from './pixels.ts';

/**
 * How the palette is chosen. `median` is median cut over RGB (tools/sprites/quantize.ts), which
 * the stages use and which is already tested; `kmeans` is k-means in Lab, where distance means
 * what the eye means by it. Measured on a strip put back through the chain: ΔE 1.44 for median
 * cut, **0.15** for k-means (docs/methode.md §5.2).
 */
export type PaletteMethod = 'median' | 'kmeans';

export interface PixelizeOptions {
  /** Kuwahara's radius, in cell pixels; 0 leaves the brush strokes alone. */
  readonly kuwahara: number;
  /** How far a pixel moves away from the average of its neighbours; 0 is off. */
  readonly sharpen: number;
  /** Lab a and b multiplied by this; 1 is off. The paper's own value is 1.1. */
  readonly saturation: number;
  /** The share of its lightness an edge pixel keeps; 1 draws no outline. */
  readonly outline: number;
  /** Colours in the palette, the transparent one apart; 0 keeps every colour. */
  readonly colors: number;
  /** How those colours are chosen. */
  readonly method: PaletteMethod;
  /**
   * La palette de la machine visée, s'il y en a une (style.ts). Les couleurs sont choisies
   * librement d'abord — c'est là que le regroupement a du sens — puis **chacune est posée sur la
   * plus proche que la machine savait afficher**. Choisir directement parmi les couleurs d'une
   * console donnerait des regroupements absurdes : la NES n'a pas de bruns, elle a des oranges
   * sombres.
   */
  readonly master?: Master;
  /** Passes that give a pixel alone of its colour the colour of its neighbours. */
  readonly orphans: number;
  /**
   * Combien le tramage ordonné mêle deux couleurs voisines pour en suggérer une troisième ; 0 ne
   * trame pas. C'est la réponse historique au manque de couleurs : les artistes NES et Game Boy en
   * mettaient partout, faute de pouvoir afficher la teinte qu'ils voulaient. Sur un objet fixe
   * c'est ce qui rend ses dégradés ; sur un personnage animé ça grouille, d'où le réglage.
   */
  readonly dither: number;
  /**
   * Les couleurs de la source, échantillonnées avant toute réduction, pour y choisir la palette.
   * Sans elles la palette est choisie sur l'image déjà réduite — donc sur ce qui reste, pas sur ce
   * qu'on lui a donné, et les teintes rares de l'original n'ont aucune chance d'y survivre.
   */
  readonly from?: Uint8ClampedArray;
}

/**
 * Measured, not guessed (docs/methode.md §5.2): a strip blown up on a wall, put back through the
 * chain, and scored against the drawing it came from. Every step that costs more than it gives is
 * off by default and stays on a slider.
 *
 * | réglage | ΔE | pourquoi ce défaut |
 * |---|---|---|
 * | Kuwahara 0 | — | sur un visage de 2 px il avale l'œil et l'oreille |
 * | netteté 0 | 0,20 → 4,77 | le noyau à arêtes nettes fait déjà le travail ; en rajouter double la dose |
 * | saturation 1 | 0,20 → 0,80 | 1,1 est l'habitude des pixel artists, pas de la fidélité |
 * | contour 0,7 | 0,20 → 0,26 | presque gratuit, et c'est ce qui fait lire un sprite |
 * | orphelins 0 | 0,26 → 3,62 | du nettoyage, pas de la fidélité : à monter sur une photo bruitée |
 */
export const PIXELIZE_DEFAULTS: PixelizeOptions = {
  kuwahara: 0,
  sharpen: 0,
  saturation: 1,
  outline: 0.7,
  colors: 32,
  orphans: 0,
  method: 'kmeans',
  dither: 0,
};

export interface Pixelized {
  readonly cell: Bitmap;
  readonly palette: readonly Rgba[];
  /** Colours actually used, which can be under the palette's size on a small subject. */
  readonly colors: number;
}

export function pixelize(placed: Bitmap, on: Uint8Array, options: PixelizeOptions): Pixelized {
  let cell = copyOf(placed);
  if (options.kuwahara > 0) cell = kuwahara(cell, on, options.kuwahara);
  if (options.sharpen > 0) cell = sharpen(cell, on, options.sharpen);
  if (options.saturation !== 1) saturate(cell, on, options.saturation);
  const edge = edgesOf(cell, on);
  if (options.outline < 1) outline(cell, edge, options.outline);
  if (options.colors <= 0) return { cell, palette: [], colors: countColors(cell, on) };
  const chosen =
    options.method === 'kmeans'
      ? kmeansLab(cell, on, options.colors, options.from)
      : quantizeRgba(cell.data, options.colors);
  const palette = options.master ? onMaster(chosen.palette, options.master) : chosen.palette;
  const slots =
    options.dither > 0
      ? dithered(cell, on, palette, options.dither)
      : options.master
        ? nearest(cell, on, palette)
        : chosen.slots;
  for (let pass = 0; pass < options.orphans; pass++)
    dropOrphans(cell.width, cell.height, slots, on, edge);
  paint(cell, on, slots, palette);
  return { cell, palette, colors: countColors(cell, on) };
}

/**
 * Each pixel takes the average of its calmest quadrant: masses become firm and the brush strokes
 * go, where a blur would only soften them. The radius is the stages' lesson — at 1 the contours
 * crumble (docs/art/manifeste-pixel-art.md §2).
 */
function kuwahara(cell: Bitmap, on: Uint8Array, radius: number): Bitmap {
  const out = copyOf(cell);
  const { width, height } = cell;
  const quadrants: readonly (readonly [number, number])[] = [
    [-radius, -radius],
    [0, -radius],
    [-radius, 0],
    [0, 0],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((on[y * width + x] ?? 0) === 0) continue;
      let bestVariance = Infinity;
      let best: readonly [number, number, number] | undefined;
      for (const [offsetX, offsetY] of quadrants) {
        let count = 0;
        let red = 0;
        let green = 0;
        let blue = 0;
        let light = 0;
        let lightSquared = 0;
        for (let dy = 0; dy <= radius; dy++) {
          const sy = y + offsetY + dy;
          if (sy < 0 || sy >= height) continue;
          for (let dx = 0; dx <= radius; dx++) {
            const sx = x + offsetX + dx;
            if (sx < 0 || sx >= width) continue;
            const pixel = sy * width + sx;
            if ((on[pixel] ?? 0) === 0) continue;
            const r = linearOf(cell.data[pixel * 4] ?? 0);
            const g = linearOf(cell.data[pixel * 4 + 1] ?? 0);
            const b = linearOf(cell.data[pixel * 4 + 2] ?? 0);
            const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            count++;
            red += r;
            green += g;
            blue += b;
            light += value;
            lightSquared += value * value;
          }
        }
        if (count === 0) continue;
        const variance = lightSquared / count - (light / count) ** 2;
        if (variance >= bestVariance) continue;
        bestVariance = variance;
        best = [red / count, green / count, blue / count];
      }
      if (!best) continue;
      const at = (y * width + x) * 4;
      out.data[at] = byteOf(best[0]);
      out.data[at + 1] = byteOf(best[1]);
      out.data[at + 2] = byteOf(best[2]);
    }
  }
  return out;
}

/** The edges hardened again, as the stages do after Kuwahara: ×0.7 there, and here by default. */
function sharpen(cell: Bitmap, on: Uint8Array, amount: number): Bitmap {
  const out = copyOf(cell);
  const { width, height } = cell;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((on[y * width + x] ?? 0) === 0) continue;
      const channels = [0, 0, 0];
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx;
          const sy = y + dy;
          if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
          const pixel = sy * width + sx;
          if ((on[pixel] ?? 0) === 0) continue;
          count++;
          for (let channel = 0; channel < 3; channel++) {
            channels[channel] =
              (channels[channel] ?? 0) + linearOf(cell.data[pixel * 4 + channel] ?? 0);
          }
        }
      }
      if (count === 0) continue;
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const own = linearOf(cell.data[at + channel] ?? 0);
        const mean = (channels[channel] ?? 0) / count;
        out.data[at + channel] = byteOf(Math.max(0, Math.min(1, own + amount * (own - mean))));
      }
    }
  }
  return out;
}

/** Lab a and b pushed out: the saturation step pixel artists do by hand (Gerstner et al. §4.4). */
function saturate(cell: Bitmap, on: Uint8Array, beta: number): void {
  for (let pixel = 0; pixel < on.length; pixel++) {
    if ((on[pixel] ?? 0) === 0) continue;
    const at = pixel * 4;
    const [light, a, b] = toLab(cell.data[at] ?? 0, cell.data[at + 1] ?? 0, cell.data[at + 2] ?? 0);
    const [red, green, blue] = fromLab(light, a * beta, b * beta);
    cell.data[at] = red;
    cell.data[at + 1] = green;
    cell.data[at + 2] = blue;
  }
}

/** The subject's pixels that touch the empty part of the cell, or its border. */
function edgesOf(cell: Bitmap, on: Uint8Array): Uint8Array {
  const { width, height } = cell;
  const edge = new Uint8Array(on.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if ((on[pixel] ?? 0) === 0) continue;
      // Only where the subject meets the empty cell. The square's own border is a crop, not a
      // silhouette: a bust that runs off the bottom must bleed off it, not be underlined.
      const open =
        (x > 0 && (on[pixel - 1] ?? 0) === 0) ||
        (x < width - 1 && (on[pixel + 1] ?? 0) === 0) ||
        (y > 0 && (on[pixel - width] ?? 0) === 0) ||
        (y < height - 1 && (on[pixel + width] ?? 0) === 0);
      if (open) edge[pixel] = 1;
    }
  }
  // Un contour n'a de sens que s'il reste un dedans. Sur une forme d'un pixel de large — la lame
  // d'une épée à 16 × 16, un câble, une antenne — chaque pixel touche le vide, donc tout serait
  // assombri et la forme deviendrait sa propre ombre. Un pixel n'est donc un contour que s'il a
  // un voisin qui, lui, est à l'intérieur.
  const keep = new Uint8Array(edge.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if ((edge[pixel] ?? 0) === 0) continue;
      const inside = (at: number, ok: boolean) =>
        ok && (on[at] ?? 0) === 1 && (edge[at] ?? 0) === 0;
      if (
        inside(pixel - 1, x > 0) ||
        inside(pixel + 1, x < width - 1) ||
        inside(pixel - width, y > 0) ||
        inside(pixel + width, y < height - 1)
      ) {
        keep[pixel] = 1;
      }
    }
  }
  return keep;
}

/**
 * The dark 1 px line on the silhouette, in the colour it surrounds: the lightness cut, the hue
 * kept, as the stages draw theirs (docs/art/manifeste-pixel-art.md §2, 65 % to 75 %). Drawn before
 * the palette is chosen, so median cut spends a slot on it instead of rounding it away.
 */
function outline(cell: Bitmap, edge: Uint8Array, keep: number): void {
  for (let pixel = 0; pixel < edge.length; pixel++) {
    if ((edge[pixel] ?? 0) === 0) continue;
    const at = pixel * 4;
    const [light, a, b] = toLab(cell.data[at] ?? 0, cell.data[at + 1] ?? 0, cell.data[at + 2] ?? 0);
    const [red, green, blue] = fromLab(light * keep, a, b);
    cell.data[at] = red;
    cell.data[at + 1] = green;
    cell.data[at + 2] = blue;
  }
}

/**
 * A pixel alone of its colour among its four neighbours takes the one they agree on: firm masses,
 * like the sprites (the stages run two passes of this, hence the default).
 */
function dropOrphans(
  width: number,
  height: number,
  slots: Uint8Array,
  on: Uint8Array,
  edge: Uint8Array,
): void {
  const before = new Uint8Array(slots);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if ((on[pixel] ?? 0) === 0 || (edge[pixel] ?? 0) === 1) continue;
      const own = before[pixel] ?? 0;
      const neighbours: number[] = [];
      if (x > 0) neighbours.push(before[pixel - 1] ?? 0);
      if (x < width - 1) neighbours.push(before[pixel + 1] ?? 0);
      if (y > 0) neighbours.push(before[pixel - width] ?? 0);
      if (y < height - 1) neighbours.push(before[pixel + width] ?? 0);
      const kin = neighbours.filter((slot) => slot === own).length;
      if (kin > 0) continue;
      const counts = new Map<number, number>();
      for (const slot of neighbours) {
        if (slot === 0) continue;
        counts.set(slot, (counts.get(slot) ?? 0) + 1);
      }
      let best = own;
      let most = 0;
      for (const [slot, count] of counts) {
        if (count <= most) continue;
        most = count;
        best = slot;
      }
      slots[pixel] = best;
    }
  }
}

/** The palette written back into the cell, so the page shows what the slots mean. */
function paint(cell: Bitmap, on: Uint8Array, slots: Uint8Array, palette: readonly Rgba[]): void {
  for (let pixel = 0; pixel < on.length; pixel++) {
    if ((on[pixel] ?? 0) === 0) continue;
    const color = palette[slots[pixel] ?? 0];
    if (!color) continue;
    cell.data[pixel * 4] = color.r;
    cell.data[pixel * 4 + 1] = color.g;
    cell.data[pixel * 4 + 2] = color.b;
  }
}

/**
 * k-means in Lab, seeded by k-means++ and run from a fixed seed so the same cell always gives the
 * same palette. Median cut splits boxes in RGB, where equal distances do not look equal; k-means
 * puts its colours where the eye counts them, which on a face is the difference between skin
 * holding three tones and skin holding one.
 */
const KMEANS_ROUNDS = 12;

function kmeansLab(
  cell: Bitmap,
  on: Uint8Array,
  colors: number,
  from?: Uint8ClampedArray,
): { palette: Rgba[]; slots: Uint8Array } {
  const points: number[] = [];
  for (let pixel = 0; pixel < on.length; pixel++) if ((on[pixel] ?? 0) === 1) points.push(pixel);
  const palette: Rgba[] = [{ r: 0, g: 0, b: 0, a: 0 }];
  const slots = new Uint8Array(on.length);
  if (points.length === 0) return { palette, slots };
  // Les couleurs sur lesquelles la palette est apprise : celles de la source quand on les a,
  // sinon celles de la case. Les pixels à colorier restent ceux de la case dans les deux cas.
  const learned: [number, number, number][] = from
    ? Array.from({ length: from.length / 4 }, (_, index) =>
        toLab(from[index * 4] ?? 0, from[index * 4 + 1] ?? 0, from[index * 4 + 2] ?? 0),
      )
    : [];
  const wanted = Math.min(colors, points.length, 255);
  const lab = points.map((pixel) =>
    toLab(cell.data[pixel * 4] ?? 0, cell.data[pixel * 4 + 1] ?? 0, cell.data[pixel * 4 + 2] ?? 0),
  );
  const training = learned.length >= wanted ? learned : lab;
  // A fixed seed: the same cell gives the same palette, run after run and machine after machine.
  let state = 0x9e3779b9;
  const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const centres: [number, number, number][] = [
    training[Math.floor(next() * training.length)] ?? [0, 0, 0],
  ];
  const far = new Float64Array(training.length).fill(Infinity);
  while (centres.length < wanted) {
    const last = centres[centres.length - 1] ?? [0, 0, 0];
    let total = 0;
    for (const [index, point] of training.entries()) {
      const distance =
        (point[0] - last[0]) ** 2 + (point[1] - last[1]) ** 2 + (point[2] - last[2]) ** 2;
      if (distance < (far[index] ?? Infinity)) far[index] = distance;
      total += far[index] ?? 0;
    }
    if (total <= 0) break;
    // The next centre drawn in proportion to how far each colour is from the ones already held.
    let pick = next() * total;
    let chosen = 0;
    for (let index = 0; index < training.length; index++) {
      pick -= far[index] ?? 0;
      if (pick <= 0) {
        chosen = index;
        break;
      }
    }
    centres.push(training[chosen] ?? [0, 0, 0]);
  }
  const owner = new Int32Array(training.length);
  for (let round = 0; round < KMEANS_ROUNDS; round++) {
    for (const [index, point] of training.entries()) {
      let bestDistance = Infinity;
      let best = 0;
      for (const [centre, value] of centres.entries()) {
        const distance =
          (point[0] - value[0]) ** 2 + (point[1] - value[1]) ** 2 + (point[2] - value[2]) ** 2;
        if (distance >= bestDistance) continue;
        bestDistance = distance;
        best = centre;
      }
      owner[index] = best;
    }
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (const [index, point] of training.entries()) {
      const sum = sums[owner[index] ?? 0];
      if (!sum) continue;
      sum[0] = (sum[0] ?? 0) + point[0];
      sum[1] = (sum[1] ?? 0) + point[1];
      sum[2] = (sum[2] ?? 0) + point[2];
      sum[3] = (sum[3] ?? 0) + 1;
    }
    for (const [centre, sum] of sums.entries()) {
      const held = sum[3] ?? 0;
      if (held === 0) continue;
      centres[centre] = [(sum[0] ?? 0) / held, (sum[1] ?? 0) / held, (sum[2] ?? 0) / held];
    }
  }
  for (const centre of centres) {
    const [r, g, b] = fromLab(centre[0], centre[1], centre[2]);
    palette.push({ r, g, b, a: 255 });
  }
  // Les pixels de la case prennent la couleur de palette la plus proche : quand la palette a été
  // apprise ailleurs, leur appartenance est à recalculer.
  for (const [index, pixel] of points.entries()) {
    if (learned.length >= wanted) {
      const point = lab[index] ?? [0, 0, 0];
      let best = 0;
      let bestDistance = Infinity;
      for (const [centre, value] of centres.entries()) {
        const distance =
          (point[0] - value[0]) ** 2 + (point[1] - value[1]) ** 2 + (point[2] - value[2]) ** 2;
        if (distance >= bestDistance) continue;
        bestDistance = distance;
        best = centre;
      }
      slots[pixel] = best + 1;
      continue;
    }
    slots[pixel] = (owner[index] ?? 0) + 1;
  }
  return { palette, slots };
}

/** La couleur de palette la plus proche de chaque pixel, sans tramage. */
function nearest(cell: Bitmap, on: Uint8Array, palette: readonly Rgba[]): Uint8Array {
  const slots = new Uint8Array(on.length);
  for (let pixel = 0; pixel < on.length; pixel++) {
    if ((on[pixel] ?? 0) === 0) continue;
    slots[pixel] = closest(cell, pixel, palette, 0, 0, 0);
  }
  return slots;
}

/**
 * La matrice de Bayer 4 × 4 : un motif ordonné, le même partout, donc stable d'une image à la
 * suivante — là où une diffusion d'erreur donnerait un grain différent à chaque frame d'une
 * animation.
 */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

/**
 * Le tramage ordonné : chaque pixel est décalé d'un cran selon sa place dans le motif, puis prend
 * la couleur la plus proche. Deux couleurs voisines alternent alors en damier et l'œil en lit une
 * troisième, que la palette n'a pas. C'est ainsi que la NES montrait des dégradés avec trois
 * couleurs.
 */
function dithered(
  cell: Bitmap,
  on: Uint8Array,
  palette: readonly Rgba[],
  strength: number,
): Uint8Array {
  const slots = new Uint8Array(on.length);
  // L'écart typique entre deux couleurs de la palette : de combien il faut pousser un pixel pour
  // qu'il bascule sur sa voisine.
  const step = spacingOf(palette) * strength;
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      const pixel = y * cell.width + x;
      if ((on[pixel] ?? 0) === 0) continue;
      const push = ((BAYER[(y % 4) * 4 + (x % 4)] ?? 0) / 15 - 0.5) * step;
      slots[pixel] = closest(cell, pixel, palette, push, push, push);
    }
  }
  return slots;
}

/** L'écart médian entre une couleur de la palette et sa plus proche voisine, en Lab. */
function spacingOf(palette: readonly Rgba[]): number {
  const colors = palette.slice(1).map((color) => toLab(color.r, color.g, color.b));
  if (colors.length < 2) return 0;
  const gaps = colors.map((one) => {
    let best = Infinity;
    for (const other of colors) {
      if (other === one) continue;
      const distance =
        (one[0] - other[0]) ** 2 + (one[1] - other[1]) ** 2 + (one[2] - other[2]) ** 2;
      if (distance < best) best = distance;
    }
    return Math.sqrt(best);
  });
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 0;
}

/** Le slot de palette le plus proche d'un pixel, une fois poussé de `push`. */
function closest(
  cell: Bitmap,
  pixel: number,
  palette: readonly Rgba[],
  pushL: number,
  pushA: number,
  pushB: number,
): number {
  const [light, a, b] = toLab(
    cell.data[pixel * 4] ?? 0,
    cell.data[pixel * 4 + 1] ?? 0,
    cell.data[pixel * 4 + 2] ?? 0,
  );
  let best = 1;
  let bestDistance = Infinity;
  for (let slot = 1; slot < palette.length; slot++) {
    const color = palette[slot];
    if (!color) continue;
    const [cl, ca, cb] = toLab(color.r, color.g, color.b);
    const distance = (light + pushL - cl) ** 2 + (a + pushA - ca) ** 2 + (b + pushB - cb) ** 2;
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = slot;
  }
  return best;
}

/** Chaque couleur choisie, posée sur la plus proche que la machine savait afficher. */
function onMaster(palette: readonly Rgba[], master: Master): Rgba[] {
  return palette.map((color, slot) => {
    // Le slot 0 est la transparence : il n'a aucune couleur à poser.
    if (slot === 0) return color;
    const [r, g, b] = master.snap(color.r, color.g, color.b);
    return { r, g, b, a: color.a };
  });
}

function countColors(cell: Bitmap, on: Uint8Array): number {
  const seen = new Set<number>();
  for (let pixel = 0; pixel < on.length; pixel++) {
    if ((on[pixel] ?? 0) === 0) continue;
    seen.add(
      ((cell.data[pixel * 4] ?? 0) << 16) |
        ((cell.data[pixel * 4 + 1] ?? 0) << 8) |
        (cell.data[pixel * 4 + 2] ?? 0),
    );
  }
  return seen.size;
}
