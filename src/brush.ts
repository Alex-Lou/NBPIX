/**
 * What a stroke lays down (docs/art/roto.md §2). No DOM and no state: the page turns pointer
 * events into points, this says which pixels change. The awkward part — a drag that moves faster
 * than the events arrive — is therefore testable without a browser.
 */

import type { Paint } from './silhouette.ts';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A sheet of paint and the image it covers. */
export interface Sheet {
  readonly width: number;
  readonly height: number;
  readonly paint: Paint;
}

/** What a stroke says about the pixels it covers. */
export type Says = 1 | -1;

/** A disc of `says`, clipped to the sheet. */
export function stamp(sheet: Sheet, at: Point, radius: number, says: Says): void {
  const top = Math.max(0, Math.floor(at.y - radius));
  const bottom = Math.min(sheet.height - 1, Math.ceil(at.y + radius));
  for (let y = top; y <= bottom; y++) {
    const span = Math.sqrt(Math.max(0, radius * radius - (y - at.y) ** 2));
    const left = Math.max(0, Math.floor(at.x - span));
    const right = Math.min(sheet.width - 1, Math.ceil(at.x + span));
    for (let x = left; x <= right; x++) sheet.paint[y * sheet.width + x] = says;
  }
}

/**
 * A stroke, stamped every half radius along the way. A pointer reports a handful of positions a
 * second; stamping only where it reported would leave a dotted line across a fast drag.
 */
export function stroke(sheet: Sheet, from: Point, to: Point, radius: number, says: Says): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, radius / 2)));
  for (let step = 1; step <= steps; step++) {
    stamp(
      sheet,
      { x: from.x + (dx * step) / steps, y: from.y + (dy * step) / steps },
      radius,
      says,
    );
  }
}
