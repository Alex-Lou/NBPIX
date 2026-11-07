/**
 * The subject put on a sprite cell (docs/art/roto.md §3): scaled to the fighters' height and set
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

import { ANCHOR, CELL_SIZE, PORTRAIT_SIZE, STANDING_HEIGHT } from './game/contract.ts';
import { toLab } from './game/lab.ts';
import type { Bitmap, Box } from './pixels.ts';
import { bitmap, byteOf, heightOf, labBufferOf, linearOf } from './pixels.ts';
import type { Mask } from './silhouette.ts';
import { crownOf, soleOf } from './silhouette.ts';

/**
 * What the square is for. A fighter's cell stands the subject on the game's anchor; a portrait
 * frames its head and lets the shoulders run off the bottom, which is what a bust is.
 */
export type Frame = 'fighter' | 'portrait';

export { PORTRAIT_SIZE, STANDING_HEIGHT };

export interface Placement {
  readonly frame: Frame;
  /** The square's side in art pixels: `CELL_SIZE`, twice it for HD, or `PORTRAIT_SIZE`. */
  readonly cell: number;
  /** The subject's height on the square, in its pixels. */
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
   * chain: ΔE 2.53 at 0, **0.20** at 8 (docs/art/roto.md §5.2).
   */
  readonly edge: number;
}

/**
 * Air left over the hair, as a share of the square. The game's own framing puts the head's middle
 * at 45 % of the square with the head filling about 58 % of it (tools/sprites/aseprite-template.ts
 * `portraitStart`), which leaves the crown near a sixth of the way down; a photographed head keeps
 * more hair than a drawn one, so a little less.
 */
const PORTRAIT_AIR = 0.06;

export const PLACEMENT_DEFAULTS: Placement = {
  frame: 'fighter',
  cell: CELL_SIZE * 2,
  height: STANDING_HEIGHT * 2,
  flip: false,
  nudgeX: 0,
  nudgeY: 0,
  edge: 8,
};

/** A bust fills its square and lets the shoulders go: the head is what the tile shows. */
export const PORTRAIT_DEFAULTS: Placement = {
  frame: 'portrait',
  cell: PORTRAIT_SIZE,
  height: PORTRAIT_SIZE,
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
  readonly anchor: { readonly x: number; readonly y: number };
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
  const side = placement.cell;
  const scale = placement.height / heightOf(silhouette.box);
  const unit = side / CELL_SIZE;
  // Where the subject is pinned, and onto what. A fighter stands the last row of its feet on the
  // row just under the anchor row, its feet centred on the anchor column; a bust hangs the top of
  // its head under the air, centred on the square.
  const held = placement.frame === 'fighter' ? soleOf(silhouette) : crownOf(silhouette);
  const heldX = held.x + 0.5;
  const heldY = placement.frame === 'fighter' ? silhouette.box.bottom + 1 : silhouette.box.top;
  const pinX = placement.frame === 'fighter' ? (ANCHOR.x + 0.5) * unit : side / 2;
  const pinY = placement.frame === 'fighter' ? (ANCHOR.y + 1) * unit : side * PORTRAIT_AIR;
  const sourceX = (cellEdge: number) => (cellEdge - pinX - placement.nudgeX) / scale + heldX;
  const sourceY = (cellEdge: number) => (cellEdge - pinY - placement.nudgeY) / scale + heldY;

  const cell = bitmap(side, side);
  const on = new Uint8Array(side * side);
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

  for (let y = 0; y < side; y++) {
    const top = sourceY(y);
    const bottom = sourceY(y + 1);
    for (let x = 0; x < side; x++) {
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
      // Half the pixel covered by the subject or more: it belongs to the sprite, fully opaque.
      if (cover <= 0 || covered * 2 < cover || kept === 0) continue;
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
      const at = (y * side + x) * 4;
      cell.data[at] = byteOf(red / total);
      cell.data[at + 1] = byteOf(green / total);
      cell.data[at + 2] = byteOf(blue / total);
      cell.data[at + 3] = 255;
      on[y * side + x] = 1;
    }
  }
  return {
    cell,
    on,
    scale,
    anchor: { x: ANCHOR.x * unit, y: ANCHOR.y * unit },
    overflow: overflowOf(silhouette.box, { sourceX, sourceY, side }),
  };
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
  frame: { sourceX: (edge: number) => number; sourceY: (edge: number) => number; side: number },
): Overflow {
  // The cell edges the subject's own box falls on, found by walking the mapping backwards.
  const cellX = (source: number) => invert(frame.sourceX, source, frame.side);
  const cellY = (source: number) => invert(frame.sourceY, source, frame.side);
  const left = cellX(box.left);
  const right = cellX(box.right + 1);
  const top = cellY(box.top);
  const bottom = cellY(box.bottom + 1);
  return {
    left: Math.max(0, Math.ceil(-left)),
    top: Math.max(0, Math.ceil(-top)),
    right: Math.max(0, Math.ceil(right - frame.side)),
    bottom: Math.max(0, Math.ceil(bottom - frame.side)),
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
