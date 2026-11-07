/**
 * What `npm run sprites` would say about the cell this tool just made.
 *
 * The pipeline already owns a rules engine — `checkDrawn` (tools/sprites/drawn-rules.ts), the one
 * the Aseprite extension mirrors and that refuses a drawing before anything is generated. Rather
 * than write a lookalike here, the page runs **that** engine on its own output. So what the tool
 * says is what the pipeline will say, now and after the rules change; nothing to keep in step by
 * hand (loi de Hyrum, CLAUDE.md).
 *
 * Only the geometric rules can apply: the output is truecolour, so everything about palette slots
 * is out of reach (docs/art/roto.md §1). What is left is worth having — the 4 px kept clear along
 * the cell's edges is a real rule, stricter than "does the subject fit", and the one a rotoscoped
 * subject breaks most often.
 */

import { CELL_MARGIN, LOWEST_ROW, PORTRAIT_SIZE } from './game/contract.ts';
import type { DrawnRules } from './game/drawn-rules.ts';
import { checkDrawn } from './game/drawn-rules.ts';
import type { IndexedImage } from './game/png.ts';
import type { Bitmap } from './pixels.ts';
import type { Frame } from './place.ts';

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
 * The rules this square is held to. `native` is the frame's own size, so that a square drawn finer
 * than the game's (finesse ×2, ×4) is held to the same rules at its own scale: 4 px of margin at
 * ×1 is 8 px at ×2, because it is the same 2 world pixels.
 */
export function rulesOf(frame: Frame, cell: number, native: number): DrawnRules {
  const unit = native === 0 ? 1 : cell / native;
  return {
    width: cell,
    height: cell,
    frames: 1,
    slots: 2,
    filled: true,
    margin: frame === 'portrait' ? 0 : Math.round(CELL_MARGIN * unit),
    lowestRow: frame === 'portrait' ? cell - 1 : Math.round((LOWEST_ROW + 1) * unit) - 1,
    transparency: 'any',
  };
}

/** What the pipeline would refuse about this square; empty when it would take it. */
export function pipelineProblems(
  cell: Bitmap,
  on: Uint8Array,
  frame: Frame,
  native: number,
): string[] {
  const label = frame === 'portrait' ? 'portrait' : 'planche';
  return checkDrawn(label, shapeOf(cell, on), rulesOf(frame, cell.width, native), undefined);
}

/** The frame's own size, whatever the finesse: what the game loads. */
export function nativeSizeOf(frame: Frame, cell: number): number {
  return frame === 'portrait' ? PORTRAIT_SIZE : cell;
}
