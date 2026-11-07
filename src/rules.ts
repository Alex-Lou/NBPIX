/**
 * What `npm run sprites` would say about the cell this tool just made.
 *
 * The pipeline already owns a rules engine — `checkDrawn` (tools/sprites/drawn-rules.ts), the one
 * the Aseprite extension mirrors and that refuses a drawing before anything is generated. Rather
 * than write a lookalike here, the page runs **that** engine on its own output. So what the tool
 * says is what the pipeline will say, now and after the rules change; nothing to keep in step by
 * hand (loi de Hyrum).
 *
 * Only the geometric rules can apply: the output is truecolour, so everything about palette slots
 * is out of reach (docs/methode.md §1). What is left is worth having — the 4 px kept clear along
 * the cell's edges is a real rule, stricter than "does the subject fit", and the one a rotoscoped
 * subject breaks most often.
 */

import type { DrawnRules } from './game/drawn-rules.ts';
import { checkDrawn } from './game/drawn-rules.ts';
import type { IndexedImage } from './game/png.ts';
import type { Bitmap } from './pixels.ts';
import type { Format } from './format.ts';

/**
 * The cell as two slots, empty and drawn. The geometric rules only ever ask whether a pixel is
 * there, so the colours are left out and the palette checks never run.
 */
function shapeOf(cell: Bitmap, on: Uint8Array): IndexedImage {
  const pixels = new Uint8Array(on.length);
  for (let pixel = 0; pixel < on.length; pixel++) pixels[pixel] = (on[pixel] ?? 0) === 1 ? 1 : 0;
  return { width: cell.width, height: cell.height, pixels, alpha: [0, 255], colors: [0, 0] };
}

/**
 * The rules this square is held to — read straight off the format, which already carries them at
 * its own scale: 4 px of margin at ×1 is 8 px at ×2, because it is the same 2 world pixels
 * (format.ts `atFinesse`).
 */
export function rulesOf(format: Format): DrawnRules {
  return {
    width: format.width,
    height: format.height,
    frames: 1,
    slots: 2,
    filled: true,
    margin: format.margin,
    lowestRow: format.lowestRow,
    transparency: 'any',
  };
}

/** What the pipeline would refuse about this square; empty when it would take it. */
export function pipelineProblems(cell: Bitmap, on: Uint8Array, format: Format): string[] {
  return checkDrawn(format.name, shapeOf(cell, on), rulesOf(format), undefined);
}
