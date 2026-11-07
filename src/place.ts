/**
 * The subject put on a sprite cell (docs/methode.md §3): scaled to the fighters' height and set
 * down with the soles on the game's anchor, so that what comes out of the tool is already in the
 * frame the game draws in — the one thing a generic pixel-art converter never does.
 *
 * Two rules come from the pipeline and are not options:
 *
 * - the last row of the feet sits on the anchor row (src/art/types.ts `ANCHOR`, row 248 of a
 *   256 px cell), and the centre of the feet on its column, in every frame;
 * - no half-transparent pixel (docs/art/aseprite.md): the resampling keeps the coverage to average
 *   the colours, then alpha is either on or off at half coverage.
 *
 * The resampling is by areas, in linear light, and only over the subject's pixels: an output pixel
 * is the exact average of the source it covers, with the background left out, so the silhouette's
 * edge never picks up the colour of the wall behind it. Where the source is smaller than the
 * target the areas fall under one pixel and it becomes a nearest copy, which is what pixel art
 * wants anyway — nothing is interpolated (D23).
 */

import type { Format } from './format.ts';
import { fighterFormat, PORTRAIT } from './format.ts';
import { PORTRAIT_SIZE, STANDING_HEIGHT } from './game/contract.ts';
import { toLab } from './game/lab.ts';
import type { Bitmap, Box } from './pixels.ts';
import { bitmap, byteOf, heightOf, labBufferOf, linearOf } from './pixels.ts';
import type { Mask } from './silhouette.ts';
import { crownOf, soleOf } from './silhouette.ts';

/**
 * What the square is for. A fighter's cell stands the subject on the game's anchor; a portrait
 * frames its head and lets the shoulders run off the bottom, which is what a bust is.
 */
export { PORTRAIT_SIZE, STANDING_HEIGHT };

export interface Placement {
  /** The box, and the rule for putting the subject in it (format.ts). */
  readonly format: Format;
  /** The subject's height in the format, in its pixels. */
  readonly height: number;
  /** The game's strips face right; a subject facing left is turned over. */
  readonly flip: boolean;
  readonly nudgeX: number;
  readonly nudgeY: number;
  /**
   * How far a source colour may stray from its output pixel's own before it stops counting
   * (ΔE in Lab). 0 averages everything the pixel covers, which is a box filter and is as blurry
   * as a correct reduction gets: an output pixel straddling an edge comes out the mix of both
   * sides, a colour that is in neither. Above 0, the pixel finds the dominant colour of what it
   * covers and takes that side — the idea behind content-adaptive downscaling (Kopf, Shamir &
   * Peers, SIGGRAPH Asia 2013) without its EM machinery. Measured on a strip put back through the
   * chain: ΔE 2.53 at 0, **0.20** at 8 (docs/methode.md §5.2).
   */
  readonly edge: number;
}

export const PLACEMENT_DEFAULTS: Placement = {
  format: fighterFormat(2),
  height: STANDING_HEIGHT * 2,
  flip: false,
  nudgeX: 0,
  nudgeY: 0,
  edge: 8,
};

/** A bust fills its square and lets the shoulders go: the head is what the tile shows. */
export const PORTRAIT_DEFAULTS: Placement = {
  format: PORTRAIT,
  height: PORTRAIT.height0,
  flip: false,
  nudgeX: 0,
  nudgeY: 0,
  edge: 8,
};

/** How far the subject went past each side of the cell, in cell pixels; 0 when it fits. */
export interface Overflow {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Placed {
  readonly cell: Bitmap;
  /** 1 where the subject landed, so the next steps never read the empty corners. */
  readonly on: Uint8Array;
  /** Source pixels per cell pixel: under 1 the source is being reduced. */
  readonly scale: number;
  readonly overflow: Overflow;
}

/**
 * How many times the dominant colour is re-estimated from the weights it implies. One round
 * already picks a side; the second settles it. More changed nothing worth the work.
 */
const EDGE_ROUNDS = 2;

/**
 * `lab` is the source's colours in Lab (pixels.ts `labBufferOf`), which the page already holds —
 * handing it over saves recomputing it on every move of a slider.
 */
export function placeOnCell(
  image: Bitmap,
  mask: Mask,
  placement: Placement,
  lab?: Float32Array,
): Placed {
  const [source, silhouette] = placement.flip ? turnedOver(image, mask) : [image, mask];
  // A turned-over image is not the one the page measured, so its colours are measured again.
  const colors = !lab || placement.flip ? labBufferOf(source, toLab) : lab;
  const { format } = placement;
  const scale = placement.height / heightOf(silhouette.box);
  // Where the subject is pinned, and onto what: the one thing a format decides (format.ts).
  const { held, pin } = pinningOf(format, silhouette);
  const sourceX = (edge: number) => (edge - pin.x - placement.nudgeX) / scale + held.x;
  const sourceY = (edge: number) => (edge - pin.y - placement.nudgeY) / scale + held.y;

  const cell = bitmap(format.width, format.height);
  const on = new Uint8Array(format.width * format.height);
  // La part de chaque pixel que le sujet occupe vraiment, gardée telle quelle : c'est elle qui
  // décide ensuite ce qui est dessiné, et un seuil posé pixel par pixel efface les objets fins.
  const coverage = new Float32Array(format.width * format.height);
  // Room for every source pixel one output pixel can cover, reused from pixel to pixel: allocating
  // per pixel would churn millions of small arrays.
  const room = Math.max(
    1,
    (Math.ceil(Math.abs(sourceX(1) - sourceX(0))) + 2) *
      (Math.ceil(Math.abs(sourceY(1) - sourceY(0))) + 2),
  );
  const weights = new Float64Array(room);
  const pulled = new Float64Array(room);
  const reds = new Float64Array(room);
  const greens = new Float64Array(room);
  const blues = new Float64Array(room);
  const lights = new Float64Array(room);
  const greenReds = new Float64Array(room);
  const blueYellows = new Float64Array(room);

  for (let y = 0; y < format.height; y++) {
    const top = sourceY(y);
    const bottom = sourceY(y + 1);
    for (let x = 0; x < format.width; x++) {
      const left = sourceX(x);
      const right = sourceX(x + 1);
      let cover = 0;
      let covered = 0;
      let kept = 0;
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
        const weightY = Math.min(sy + 1, bottom) - Math.max(sy, top);
        if (weightY <= 0 || sy < 0 || sy >= source.height) continue;
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const weightX = Math.min(sx + 1, right) - Math.max(sx, left);
          if (weightX <= 0 || sx < 0 || sx >= source.width) continue;
          const weight = weightX * weightY;
          cover += weight;
          const pixel = sy * source.width + sx;
          if ((silhouette.on[pixel] ?? 0) === 0) continue;
          covered += weight;
          if (kept >= room) continue;
          weights[kept] = weight;
          reds[kept] = linearOf(source.data[pixel * 4] ?? 0);
          greens[kept] = linearOf(source.data[pixel * 4 + 1] ?? 0);
          blues[kept] = linearOf(source.data[pixel * 4 + 2] ?? 0);
          lights[kept] = colors[pixel * 3] ?? 0;
          greenReds[kept] = colors[pixel * 3 + 1] ?? 0;
          blueYellows[kept] = colors[pixel * 3 + 2] ?? 0;
          kept++;
        }
      }
      if (cover <= 0 || kept === 0) continue;
      coverage[y * format.width + x] = covered / cover;
      if (placement.edge > 0 && kept > 1)
        sharpenWeights(placement.edge, kept, weights, pulled, lights, greenReds, blueYellows);
      let red = 0;
      let green = 0;
      let blue = 0;
      let total = 0;
      for (let index = 0; index < kept; index++) {
        const weight = weights[index] ?? 0;
        red += (reds[index] ?? 0) * weight;
        green += (greens[index] ?? 0) * weight;
        blue += (blues[index] ?? 0) * weight;
        total += weight;
      }
      if (total <= 0) continue;
      const at = (y * format.width + x) * 4;
      cell.data[at] = byteOf(red / total);
      cell.data[at + 1] = byteOf(green / total);
      cell.data[at + 2] = byteOf(blue / total);
      cell.data[at + 3] = 255;
    }
  }
  drawn(coverage, format.width, format.height, on);
  for (let pixel = 0; pixel < on.length; pixel++) {
    if ((on[pixel] ?? 0) === 0) cell.data[pixel * 4 + 3] = 0;
  }
  return {
    cell,
    on,
    scale,
    overflow: overflowOf(silhouette.box, { sourceX, sourceY, format }),
  };
}

/**
 * Sous ce seuil, un pixel n'est dessiné que s'il est la crête d'une forme fine. Mesuré sur une
 * épée réduite à 16 × 16 : sa lame n'y occupe que 0,66 pixel de large, donc à cheval sur deux
 * colonnes elle n'en couvre que 0,33 de chacune.
 */
const RIDGE = 0.12;

/**
 * Ce qui est dessiné, à partir de ce que le sujet couvre.
 *
 * La règle évidente — la moitié du pixel ou plus — est juste tant que l'objet est épais devant le
 * pixel. Elle **efface** tout ce qui est plus fin : une lame, un câble, une antenne, une patte.
 * Réduite assez, une épée disparaît entièrement, ce qui n'est pas « moins de détail » mais « plus
 * d'objet ».
 *
 * Un pixel est donc aussi dessiné quand il est une **crête** : plus couvert que ses deux voisins
 * de part et d'autre, dans l'une ou l'autre direction, et au-dessus d'un plancher. Une forme fine
 * laisse exactement ça — une arête de couverture — et en garde une ligne d'un pixel au lieu de
 * rien. C'est la différence entre réduire et reconstruire.
 */
function drawn(coverage: Float32Array, width: number, height: number, on: Uint8Array): void {
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : (coverage[y * width + x] ?? 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const own = at(x, y);
      if (own >= 0.5) {
        on[y * width + x] = 1;
        continue;
      }
      if (own < RIDGE) continue;
      // Une crête : au moins aussi couvert que ses voisins d'un côté, et plus que l'un des deux.
      const across =
        own >= at(x - 1, y) && own >= at(x + 1, y) && (own > at(x - 1, y) || own > at(x + 1, y));
      const along =
        own >= at(x, y - 1) && own >= at(x, y + 1) && (own > at(x, y - 1) || own > at(x, y + 1));
      if (across || along) on[y * width + x] = 1;
    }
  }
}

/** The point of the subject a format pins, and the point of the box it goes on. */
function pinningOf(
  format: Format,
  mask: Mask,
): { held: { x: number; y: number }; pin: { x: number; y: number } } {
  switch (format.pin.kind) {
    case 'feet': {
      const sole = soleOf(mask);
      return {
        held: { x: sole.x + 0.5, y: mask.box.bottom + 1 },
        pin: { x: format.pin.column + 0.5, y: format.pin.row + 1 },
      };
    }
    case 'crown': {
      const crown = crownOf(mask);
      return {
        held: { x: crown.x + 0.5, y: mask.box.top },
        pin: { x: format.width / 2, y: format.height * format.pin.air },
      };
    }
    case 'box':
      return {
        held: {
          x: (mask.box.left + mask.box.right + 1) / 2,
          y: (mask.box.top + mask.box.bottom + 1) / 2,
        },
        pin: { x: format.width / 2, y: format.height / 2 },
      };
  }
}

/**
 * The weights of one output pixel, pulled toward the dominant colour of what it covers: the mean
 * is re-estimated from the weights it implies, so a pixel straddling an edge settles on the side
 * it mostly covers instead of the mix of both. `weights` is rewritten in place.
 */
function sharpenWeights(
  edge: number,
  kept: number,
  weights: Float64Array,
  pulled: Float64Array,
  lights: Float64Array,
  greenReds: Float64Array,
  blueYellows: Float64Array,
): void {
  let meanLight = 0;
  let meanGreenRed = 0;
  let meanBlueYellow = 0;
  let mass = 0;
  for (let index = 0; index < kept; index++) {
    const weight = weights[index] ?? 0;
    meanLight += (lights[index] ?? 0) * weight;
    meanGreenRed += (greenReds[index] ?? 0) * weight;
    meanBlueYellow += (blueYellows[index] ?? 0) * weight;
    mass += weight;
  }
  if (mass <= 0) return;
  meanLight /= mass;
  meanGreenRed /= mass;
  meanBlueYellow /= mass;
  const spread = 2 * edge * edge;
  for (let round = 0; round < EDGE_ROUNDS; round++) {
    let nextLight = 0;
    let nextGreenRed = 0;
    let nextBlueYellow = 0;
    let nextMass = 0;
    for (let index = 0; index < kept; index++) {
      const dl = (lights[index] ?? 0) - meanLight;
      const da = (greenReds[index] ?? 0) - meanGreenRed;
      const db = (blueYellows[index] ?? 0) - meanBlueYellow;
      const weight = (weights[index] ?? 0) * Math.exp(-(dl * dl + da * da + db * db) / spread);
      pulled[index] = weight;
      nextLight += (lights[index] ?? 0) * weight;
      nextGreenRed += (greenReds[index] ?? 0) * weight;
      nextBlueYellow += (blueYellows[index] ?? 0) * weight;
      nextMass += weight;
    }
    if (nextMass <= 0) return;
    meanLight = nextLight / nextMass;
    meanGreenRed = nextGreenRed / nextMass;
    meanBlueYellow = nextBlueYellow / nextMass;
  }
  for (let index = 0; index < kept; index++) weights[index] = pulled[index] ?? 0;
}

function overflowOf(
  box: Box,
  frame: {
    sourceX: (edge: number) => number;
    sourceY: (edge: number) => number;
    format: Format;
  },
): Overflow {
  // The cell edges the subject's own box falls on, found by walking the mapping backwards.
  const cellX = (source: number) => invert(frame.sourceX, source, frame.format.width);
  const cellY = (source: number) => invert(frame.sourceY, source, frame.format.height);
  const left = cellX(box.left);
  const right = cellX(box.right + 1);
  const top = cellY(box.top);
  const bottom = cellY(box.bottom + 1);
  return {
    left: Math.max(0, Math.ceil(-left)),
    top: Math.max(0, Math.ceil(-top)),
    right: Math.max(0, Math.ceil(right - frame.format.width)),
    bottom: Math.max(0, Math.ceil(bottom - frame.format.height)),
  };
}

/** The cell edge a source edge lands on: the mapping is affine, so two probes give it. */
function invert(sourceAt: (edge: number) => number, source: number, side: number): number {
  const zero = sourceAt(0);
  const one = sourceAt(side);
  if (one === zero) return 0;
  return ((source - zero) / (one - zero)) * side;
}

/** The image and its mask mirrored, so a subject facing left faces right like every strip. */
function turnedOver(image: Bitmap, mask: Mask): [Bitmap, Mask] {
  const turned = bitmap(image.width, image.height);
  const on = new Uint8Array(image.width * image.height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const from = y * image.width + x;
      const to = y * image.width + (image.width - 1 - x);
      turned.data[to * 4] = image.data[from * 4] ?? 0;
      turned.data[to * 4 + 1] = image.data[from * 4 + 1] ?? 0;
      turned.data[to * 4 + 2] = image.data[from * 4 + 2] ?? 0;
      turned.data[to * 4 + 3] = image.data[from * 4 + 3] ?? 0;
      on[to] = mask.on[from] ?? 0;
    }
  }
  return [
    turned,
    {
      ...mask,
      on,
      box: {
        left: image.width - 1 - mask.box.right,
        right: image.width - 1 - mask.box.left,
        top: mask.box.top,
        bottom: mask.box.bottom,
      },
    },
  ];
}
