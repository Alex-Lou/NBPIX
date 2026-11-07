/**
 * The subject's silhouette in an imported image (docs/methode.md §2): what the tool keeps, and
 * what is background. Two ways, tried in this order.
 *
 * - **The image already says it.** Enough transparent pixels and the alpha channel is the answer:
 *   a Blender render, a generated PNG on a transparent background, a drawing already cut out.
 * - **The background is keyed out.** A flood fill starts at the four corners, each keeping its own
 *   reference colour, and spreads while a pixel stays within `tolerance` of that corner (ΔE in
 *   Lab). Four references, so a wall and a floor of two different colours both go; the reference
 *   never moves, so a fill cannot drift along a soft edge into the subject the way a fill compared
 *   to its neighbour would. The corners are used rather than the whole border because feet often
 *   touch the bottom edge of a photo, and a fill seeded on the feet would eat the fighter.
 *
 * Then the specks go: the largest island is kept, and so is any island at least `minShare` of it
 * (a detached hand, a weapon, hair). A hole inside the subject is kept by construction — the fill
 * never reaches it.
 *
 * The limit is known and is the method's, not a bug: this works on a plain background (a wall, a
 * studio backdrop, a render) and fails on a busy one. A photo against a bookshelf needs a
 * segmentation model, which this tool does not have.
 */

import type { Bitmap, Box, ToLab } from './pixels.ts';
import { labBufferOf, labDistanceSquared } from './pixels.ts';

/** Where a mask came from: the image's own alpha, the colour key, or the model (segment.ts). */
export type Source = 'alpha' | 'key' | 'model';

/** What a way of finding the subject reports about itself, beyond the pixels. */
export interface Found {
  readonly from: Source;
  /** Corners that seeded a fill, and corners dropped: 0 for anything but the colour key. */
  readonly seeds: number;
  readonly dropped: number;
}

export interface Mask {
  readonly width: number;
  readonly height: number;
  /** 1 where the subject is, 0 where the background is. */
  readonly on: Uint8Array;
  /** The box the subject fills; empty subjects report the whole image. */
  readonly box: Box;
  readonly pixels: number;
  /** How the mask was found, for the page to say which. */
  readonly from: Source;
  /** Islands kept, and islands dropped as specks: the page warns when many were dropped. */
  readonly islands: number;
  readonly specks: number;
  /** Corners that seeded the fill, and corners dropped for standing on the subject (`seedsOf`). */
  readonly seeds: number;
  readonly dropped: number;
}

/**
 * The corners a fill may start from. All four by default; the page lets them be unticked one by
 * one, because no rule can always tell a background corner from a subject one. A subject wearing
 * dark clothes against a light wall puts two corners on the wall and two on the shirt — each pair
 * agrees with itself, `seedsOf` sees nothing odd, and the fill that starts in the shirt eats the
 * hair and the beard with it. Untick the two that sit on the subject and it is over.
 */
export interface Corners {
  readonly topLeft: boolean;
  readonly topRight: boolean;
  readonly bottomLeft: boolean;
  readonly bottomRight: boolean;
}

export const EVERY_CORNER: Corners = {
  topLeft: true,
  topRight: true,
  bottomLeft: true,
  bottomRight: true,
};

export interface SilhouetteOptions {
  /** ΔE in Lab at or under which a pixel joins the background it spread from. */
  readonly tolerance: number;
  /** Alpha at or over which a pixel is the subject, when the image carries alpha. */
  readonly alphaFloor: number;
  /** An island under this share of the largest one is a speck. */
  readonly minShare: number;
  /** Passes that rub the single-pixel noise off the edge (`tidyEdges`); 0 leaves it raw. */
  readonly tidy: number;
  /** Which corners a fill may start from. */
  readonly corners: Corners;
}

export const SILHOUETTE_DEFAULTS: SilhouetteOptions = {
  tolerance: 14,
  alphaFloor: 128,
  minShare: 0.02,
  tidy: 1,
  corners: EVERY_CORNER,
};

/** Under this share of transparent pixels, the image is treated as opaque and keyed instead. */
const ALPHA_SHARE = 0.01;

/**
 * The subject of `image`. `lab` is its colours in Lab (pixels.ts `labBufferOf`), computed once per
 * image by the caller and handed back on every move of the tolerance slider; without it, this
 * computes its own.
 */
export function silhouetteOf(
  image: Bitmap,
  options: SilhouetteOptions,
  toLab: ToLab,
  lab?: Float32Array,
): Mask {
  const count = image.width * image.height;
  let transparent = 0;
  for (let pixel = 0; pixel < count; pixel++) {
    if ((image.data[pixel * 4 + 3] ?? 0) < options.alphaFloor) transparent++;
  }
  const carries = transparent >= count * ALPHA_SHARE;
  const keyed = carries
    ? { on: fromAlpha(image, options.alphaFloor), seeds: 0, dropped: 0 }
    : keyedOut(image, options.tolerance, lab ?? labBufferOf(image, toLab), options.corners);
  return refine(image.width, image.height, keyed.on, options, {
    from: carries ? 'alpha' : 'key',
    seeds: keyed.seeds,
    dropped: keyed.dropped,
  });
}

/**
 * The tail every way of finding a subject shares: the edge tidied, the specks dropped, the box
 * and the count measured. The colour key goes through it, and so does the model (segment.ts) —
 * a mask is a mask, whatever found it, and the cleaning has no business being written twice.
 */
export function refine(
  width: number,
  height: number,
  on: Uint8Array,
  options: Pick<SilhouetteOptions, 'tidy' | 'minShare'>,
  found: Found,
): Mask {
  for (let pass = 0; pass < options.tidy; pass++) tidyEdges(width, height, on);
  return despeckle(width, height, on, options.minShare, found);
}

/**
 * One majority pass over the mask: a subject pixel with at most one subject neighbour goes (a
 * single-pixel spur), and a background pixel with at least three goes in (a pinhole, a notch).
 * Hair, fur and motion blur leave exactly that kind of fringe on a keyed photo, and it turns into
 * a swarm of lone pixels once the image is reduced. It only rubs out what is one pixel wide: a
 * hole of 2 px across, or any real shape, is left alone.
 */
export function tidyEdges(width: number, height: number, on: Uint8Array): void {
  const before = new Uint8Array(on);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      let kin = 0;
      if (x > 0 && (before[pixel - 1] ?? 0) === 1) kin++;
      if (x < width - 1 && (before[pixel + 1] ?? 0) === 1) kin++;
      if (y > 0 && (before[pixel - width] ?? 0) === 1) kin++;
      if (y < height - 1 && (before[pixel + width] ?? 0) === 1) kin++;
      if ((before[pixel] ?? 0) === 1) {
        if (kin <= 1) on[pixel] = 0;
      } else if (kin >= 3) {
        on[pixel] = 1;
      }
    }
  }
}

function fromAlpha(image: Bitmap, alphaFloor: number): Uint8Array {
  const count = image.width * image.height;
  const on = new Uint8Array(count);
  for (let pixel = 0; pixel < count; pixel++) {
    on[pixel] = (image.data[pixel * 4 + 3] ?? 0) >= alphaFloor ? 1 : 0;
  }
  return on;
}

/**
 * The corners that may seed the fill: those whose colour at least one other corner agrees with.
 *
 * A corner standing alone is not the background — it is the subject, filling the frame and running
 * into that corner. Seeding a fill there floods the subject itself and leaves an empty silhouette,
 * which is the one way this method fails without saying anything. Agreement between corners costs
 * three comparisons and catches it.
 *
 * When no two corners agree, nothing can be told from them, so all four stand and the concerns
 * (concerns.ts) are left to report what comes out.
 */
export function seedsOf(
  corners: readonly number[],
  lab: Float32Array,
  tolerance: number,
): number[] {
  const limit = tolerance * tolerance;
  const agreed = corners.filter((corner) =>
    corners.some((other) => other !== corner && labDistanceSquared(lab, corner, other) <= limit),
  );
  return agreed.length === 0 ? [...corners] : agreed;
}

/** A flood fill from each agreeing corner; what it never reaches is the subject. */
function keyedOut(
  image: Bitmap,
  tolerance: number,
  lab: Float32Array,
  allowed: Corners,
): { on: Uint8Array; seeds: number; dropped: number } {
  const { width, height } = image;
  const count = width * height;
  const on = new Uint8Array(count).fill(1);
  const limit = tolerance * tolerance;
  const every = [
    allowed.topLeft && 0,
    allowed.topRight && width - 1,
    allowed.bottomLeft && (height - 1) * width,
    allowed.bottomRight && height * width - 1,
  ].filter((corner): corner is number => corner !== false);
  const corners = seedsOf(every, lab, tolerance);
  // Which corner's fill reached a pixel, so each pixel is compared to that corner's colour alone.
  const seed = new Int32Array(count).fill(-1);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  for (const corner of corners) {
    if (seed[corner] !== -1) continue;
    seed[corner] = corner;
    on[corner] = 0;
    queue[tail++] = corner;
  }
  while (head < tail) {
    const pixel = queue[head++] ?? 0;
    const reference = seed[pixel] ?? 0;
    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x > 0) spread(pixel - 1);
    if (x < width - 1) spread(pixel + 1);
    if (y > 0) spread(pixel - width);
    if (y < height - 1) spread(pixel + width);

    function spread(next: number): void {
      if (seed[next] !== -1) return;
      if (labDistanceSquared(lab, next, reference) > limit) return;
      seed[next] = reference;
      on[next] = 0;
      queue[tail++] = next;
    }
  }
  return { on, seeds: corners.length, dropped: every.length - corners.length };
}

/** Only the largest island and the islands worth keeping; the rest is noise. */
function despeckle(
  width: number,
  height: number,
  on: Uint8Array,
  minShare: number,
  found: Found,
): Mask {
  const count = width * height;
  const island = new Int32Array(count).fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(count);
  for (let start = 0; start < count; start++) {
    if ((on[start] ?? 0) === 0 || island[start] !== -1) continue;
    const index = sizes.length;
    let size = 0;
    let head = 0;
    let tail = 0;
    island[start] = index;
    queue[tail++] = start;
    while (head < tail) {
      const pixel = queue[head++] ?? 0;
      size++;
      const x = pixel % width;
      const y = (pixel - x) / width;
      if (x > 0) join(pixel - 1);
      if (x < width - 1) join(pixel + 1);
      if (y > 0) join(pixel - width);
      if (y < height - 1) join(pixel + width);
    }
    sizes.push(size);

    function join(next: number): void {
      if ((on[next] ?? 0) === 0 || island[next] !== -1) return;
      island[next] = index;
      queue[tail++] = next;
    }
  }
  const largest = sizes.reduce((most, size) => Math.max(most, size), 0);
  const floor = Math.max(1, Math.round(largest * minShare));
  const kept = sizes.map((size) => size >= floor);
  let pixels = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let pixel = 0; pixel < count; pixel++) {
    const index = island[pixel] ?? -1;
    if (index === -1 || kept[index] !== true) {
      on[pixel] = 0;
      continue;
    }
    pixels++;
    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  const box: Box =
    pixels === 0
      ? { left: 0, top: 0, right: width - 1, bottom: height - 1 }
      : { left, top, right, bottom };
  return {
    width,
    height,
    on,
    box,
    pixels,
    from: found.from,
    islands: kept.filter(Boolean).length,
    specks: kept.filter((keep) => !keep).length,
    seeds: found.seeds,
    dropped: found.dropped,
  };
}

/**
 * The centre of the feet, in the image: the middle of the subject's lowest band. The lowest row
 * alone would sit on whichever toe is lower; a band of the subject's height averages both feet,
 * which is what the game's anchor means (the centre of the feet, src/art/types.ts `ANCHOR`).
 */
export interface Sole {
  readonly x: number;
  readonly y: number;
  /**
   * How wide the band it took for feet is. A standing fighter plants them apart, so this is most
   * of the subject's width; a thin base is a shadow, a tail or a collar, and the anchor is then a
   * guess (concerns.ts).
   */
  readonly width: number;
}

export function soleOf(mask: Mask, band = 0.05): Sole {
  const height = mask.box.bottom - mask.box.top + 1;
  const rows = Math.max(1, Math.round(height * band));
  let sum = 0;
  let found = 0;
  let left = mask.width;
  let right = -1;
  for (let y = mask.box.bottom; y > mask.box.bottom - rows && y >= 0; y--) {
    for (let x = mask.box.left; x <= mask.box.right; x++) {
      if ((mask.on[y * mask.width + x] ?? 0) === 0) continue;
      sum += x;
      found++;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  const x = found === 0 ? (mask.box.left + mask.box.right) / 2 : sum / found;
  return { x, y: mask.box.bottom, width: right < left ? 0 : right - left + 1 };
}

/**
 * What the hand says about a pixel, over the whole image: 1 subject, -1 background, 0 no opinion.
 * Colour cannot tell lit skin from a lit wall when the two touch and share a colour — there is no
 * step to find, so no setting finds one. The hand is the answer, and it is the last word: the
 * override is applied **after** tidying and despeckling, so a stroke is never nibbled or dropped
 * as a speck.
 */
export type Paint = Int8Array;

/**
 * `mask` with the hand's corrections laid over it, and its box and count measured again.
 *
 * `into` is a buffer to write the pixels into, so a stroke does not allocate one per pointer move:
 * on a 1600 px image that is 2.5 MB of garbage a move, and a drag reports dozens a second. The
 * automatic mask it builds on is never touched, so passing the same buffer back each time is safe.
 */
export function painted(mask: Mask, paint: Paint, into?: Uint8Array): Mask {
  const on = into?.length === mask.on.length ? into : new Uint8Array(mask.on.length);
  on.set(mask.on);
  let pixels = 0;
  let left = mask.width;
  let top = mask.height;
  let right = -1;
  let bottom = -1;
  for (let pixel = 0; pixel < on.length; pixel++) {
    const said = paint[pixel] ?? 0;
    if (said !== 0) on[pixel] = said > 0 ? 1 : 0;
    if ((on[pixel] ?? 0) === 0) continue;
    pixels++;
    const x = pixel % mask.width;
    const y = (pixel - x) / mask.width;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  const box =
    pixels === 0
      ? { left: 0, top: 0, right: mask.width - 1, bottom: mask.height - 1 }
      : { left, top, right, bottom };
  return { ...mask, on, box, pixels };
}

/**
 * The top of the head, in the image: the middle of the subject's highest band, mirroring `soleOf`.
 * A portrait is framed on the head, and on a profile the skull's middle is not the middle of the
 * whole subject — the shoulders are wider and sit to one side.
 */
export function crownOf(mask: Mask, band = 0.15): Sole {
  const height = mask.box.bottom - mask.box.top + 1;
  const rows = Math.max(1, Math.round(height * band));
  let sum = 0;
  let found = 0;
  let left = mask.width;
  let right = -1;
  for (let y = mask.box.top; y < mask.box.top + rows && y < mask.height; y++) {
    for (let x = mask.box.left; x <= mask.box.right; x++) {
      if ((mask.on[y * mask.width + x] ?? 0) === 0) continue;
      sum += x;
      found++;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  const x = found === 0 ? (mask.box.left + mask.box.right) / 2 : sum / found;
  return { x, y: mask.box.top, width: right < left ? 0 : right - left + 1 };
}

/** The image edges the subject runs into: what the frame cut off, not what the subject is. */
export interface Edges {
  readonly left: boolean;
  readonly top: boolean;
  readonly right: boolean;
  readonly bottom: boolean;
}

export function edgesOf(mask: Mask): Edges {
  return {
    left: mask.box.left === 0,
    top: mask.box.top === 0,
    right: mask.box.right === mask.width - 1,
    bottom: mask.box.bottom === mask.height - 1,
  };
}
