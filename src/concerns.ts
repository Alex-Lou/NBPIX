/**
 * Whether the measurement can be trusted (docs/art/roto.md §2.1).
 *
 * The tool measures, it does not understand. A studio portrait with no feet in the frame hands it
 * a perfectly clean silhouette whose lowest pixel is the shadow of a collar — and it will stand
 * that collar on the anchor, scale a head to a fighter's full height, and report "feet on the
 * anchor" without blinking. A confident wrong answer is worse than no answer, so every judgement
 * the tool cannot make for itself is raised here, by name, with the number that raised it.
 *
 * These are concerns, not errors: each one has a case where it is fine, so nothing is refused.
 * They are data, not sentences — the page turns them into French, the tests read the names.
 */

import type { Frame, Overflow } from './place.ts';
import type { Edges, Mask, Sole } from './silhouette.ts';
import { edgesOf } from './silhouette.ts';

export type Concern =
  /** Almost nothing was kept: the tolerance is too high, or the subject looks like its background. */
  | { readonly kind: 'nothing-kept'; readonly share: number }
  /** Almost everything was kept: the background was never recognised. */
  | { readonly kind: 'everything-kept'; readonly share: number }
  /** What was taken for feet is a sliver: a tail, a shadow, a collar — the anchor is a guess. */
  | { readonly kind: 'narrow-base'; readonly width: number; readonly share: number }
  /** The subject runs into the frame: what the frame cut off is missing from every measurement. */
  | { readonly kind: 'cut-off'; readonly edges: Edges }
  /** Many islands were dropped: the key is noisy, so the silhouette's edge is unreliable. */
  | { readonly kind: 'specks'; readonly specks: number }
  /** A corner stood on the subject and was not used to seed the fill: the subject fills the frame. */
  | { readonly kind: 'corner-dropped'; readonly dropped: number }
  /** The subject does not fit the cell at this height. */
  | { readonly kind: 'overflow'; readonly overflow: Overflow };

/**
 * Measured on the two cases at hand (docs/art/roto.md §5): a strip on a wall plants its feet over
 * **94 %** of its width, a portrait's collar over **5 %**. A quarter sits well clear of both, and
 * on the side that lets a fighter stand with its feet together.
 */
const NARROW_BASE = 0.25;
const NOTHING_KEPT = 0.01;
const EVERYTHING_KEPT = 0.95;
/** Up to this many islands dropped is ordinary; past it the key is picking up the background. */
const SPECKS = 3;

/**
 * What the frame is for decides which judgements mean anything. A bust has no feet and is **meant**
 * to be cut at the bottom, so the two that guard the anchor are not raised for one — raising them
 * there would teach the eye to ignore the warnings, which costs more than silence.
 *
 * Nothing warns that a whole standing figure was handed to the portrait frame. Measured, a fighter
 * in its guard is 1.4 times taller than wide and a bust about the same, so the shape tells them
 * apart no better than a coin; and unlike a wrong anchor, a tiny body in the square is the first
 * thing the preview shows. A warning that fires on a coin toss, about something plain to see, only
 * teaches the eye to skip the warnings that matter.
 */
export function concernsOf(
  mask: Mask,
  sole: Sole,
  overflow: Overflow,
  frame: Frame = 'fighter',
): Concern[] {
  const concerns: Concern[] = [];
  const area = mask.width * mask.height;
  const share = area === 0 ? 0 : mask.pixels / area;
  if (share < NOTHING_KEPT) concerns.push({ kind: 'nothing-kept', share });
  else if (share > EVERYTHING_KEPT) concerns.push({ kind: 'everything-kept', share });
  const width = mask.box.right - mask.box.left + 1;
  const base = width === 0 ? 0 : sole.width / width;
  if (frame === 'fighter' && mask.pixels > 0 && base < NARROW_BASE) {
    concerns.push({ kind: 'narrow-base', width: sole.width, share: base });
  }
  const edges = edgesOf(mask);
  const cut = frame === 'portrait' ? { ...edges, bottom: false } : edges;
  if (mask.pixels > 0 && (cut.left || cut.top || cut.right || cut.bottom)) {
    concerns.push({ kind: 'cut-off', edges: cut });
  }
  if (mask.specks > SPECKS) concerns.push({ kind: 'specks', specks: mask.specks });
  if (mask.dropped > 0) concerns.push({ kind: 'corner-dropped', dropped: mask.dropped });
  // A bust running off the bottom of its square is the point of a bust, not a problem.
  const spill =
    frame === 'portrait'
      ? overflow.left + overflow.top + overflow.right
      : overflow.left + overflow.top + overflow.right + overflow.bottom;
  if (spill > 0) concerns.push({ kind: 'overflow', overflow });
  return concerns;
}

/** Whether a concern says the anchor itself cannot be trusted — the one that ruins a strip. */
export function anchorIsAGuess(concerns: readonly Concern[]): boolean {
  return concerns.some(
    (concern) =>
      concern.kind === 'narrow-base' ||
      (concern.kind === 'cut-off' && concern.edges.bottom) ||
      concern.kind === 'nothing-kept',
  );
}
