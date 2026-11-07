/**
 * The rules a drawn image is held to, and the check that applies them — the only place they live.
 *
 * `npm run sprites` refuses a drawing that breaks one of these, and the Aseprite extension warns
 * before it exports; both go through here. The rotoscope page (tools/roto) runs the same check on
 * what it produces, so what it tells the artist is what the pipeline will say, not a lookalike
 * that drifts. Hence this module apart: it touches no disk and no engine, so a browser can load it.
 */

import type { IndexedImage, Rgba } from './png.ts';

/**
 * The checks a drawn image passes, the cell's contract that the strips drawn by code keep too
 * (cell.ts, tests/tools): written in the Aseprite templates as well, so the extension warns
 * before it exports.
 */
export interface DrawnRules {
  /** A cell's size, in pixels: the frames are cells side by side. */
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  /** The fighter's palette slots: an index at or past it is none of its colors (a guide's). */
  readonly slots: number;
  /** Every frame draws something. */
  readonly filled: boolean;
  /** Empty pixels kept along the left, right and top edges of every cell. */
  readonly margin: number;
  /** The lowest row a cell may draw on. */
  readonly lowestRow: number;
  /** The row every frame's lowest pixel reaches at least (the feet on the ground), if any. */
  readonly groundRow?: number;
  /**
   * What may be see-through: any pixel, at any opacity; only whole pixels (each fully opaque or
   * fully transparent: laid over something else, a half-transparent one cannot be); none.
   */
  readonly transparency: 'any' | 'whole' | 'none';
}
/**
 * What is wrong with a drawn image (`label` names it in the messages, its frames numbered from 1
 * as Aseprite does), against its rules and the main palette of its fighter, whose slots it draws
 * in; without one (`palette` undefined), its colors are free and its transparent pixels are those
 * of a transparent color. Nothing is wrong when the list is empty.
 */
export function checkDrawn(
  label: string,
  image: IndexedImage,
  rules: DrawnRules,
  palette: readonly Rgba[] | undefined,
): string[] {
  const { width: cell, height } = rules;
  const width = cell * rules.frames;
  if (image.width !== width || image.height !== height) {
    return [
      `${label}: ${image.width}x${image.height} px, expected ${width}x${height} (${rules.frames} cells of ${cell}x${height} px in a row)`,
    ];
  }
  const problems: string[] = [];
  const seen = new Set<number>();
  const extents = Array.from({ length: rules.frames }, () => ({
    top: height,
    bottom: -1,
    left: cell,
    right: -1,
  }));
  const empty = (slot: number): boolean =>
    palette ? slot === 0 : (image.alpha[slot] ?? 255) === 0;
  let hole: string | undefined;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const slot = image.pixels[y * image.width + x] ?? 0;
      const frame = Math.floor(x / cell);
      const column = x % cell;
      if (empty(slot)) {
        if (rules.transparency === 'none') hole ??= `frame ${frame + 1}, pixel ${column},${y}`;
        continue;
      }
      if (!seen.has(slot)) {
        seen.add(slot);
        const problem = palette
          ? slotProblem(slot, image, rules, palette)
          : alphaProblem(slot, image, rules);
        if (problem)
          problems.push(`${label}: frame ${frame + 1}, pixel ${column},${y}: ${problem}`);
      }
      const extent = extents[frame];
      if (!extent) continue;
      extent.top = Math.min(extent.top, y);
      extent.bottom = Math.max(extent.bottom, y);
      extent.left = Math.min(extent.left, column);
      extent.right = Math.max(extent.right, column);
    }
  }
  if (hole) problems.push(`${label}: ${hole} is transparent (this one is opaque everywhere)`);
  if (extents.every(({ bottom }) => bottom < 0) && !rules.filled) {
    problems.push(`${label} draws nothing (no file means none)`);
  }
  extents.forEach(({ top, bottom, left, right }, frame) => {
    const at = `${label}: frame ${frame + 1}`;
    if (bottom < 0) {
      if (rules.filled) problems.push(`${at} is empty`);
      return;
    }
    const edge = Math.min(top, left, cell - 1 - right);
    if (edge < rules.margin) {
      problems.push(`${at} comes ${edge} px from the cell's edge (${rules.margin} at least)`);
    }
    if (bottom > rules.lowestRow) {
      problems.push(
        `${at} draws under the ground, down to row ${bottom} (${rules.lowestRow} at most)`,
      );
    }
    if (rules.groundRow !== undefined && bottom < rules.groundRow) {
      problems.push(
        `${at}: the feet float, its lowest pixel is on row ${bottom} (${rules.groundRow} at least)`,
      );
    }
  });
  return problems;
}

/** Why a free color drawn in an image is wrong, if it is: half transparent where it may not be. */
function alphaProblem(slot: number, image: IndexedImage, rules: DrawnRules): string | undefined {
  if (rules.transparency === 'any' || (image.alpha[slot] ?? 255) === 255) return undefined;
  return 'half transparent (only fully opaque or fully transparent pixels)';
}

/** Why a slot drawn in an image is wrong, if it is: none of the fighter's, or recolored. */
function slotProblem(
  slot: number,
  image: IndexedImage,
  rules: DrawnRules,
  palette: readonly Rgba[],
): string | undefined {
  const expected = palette[slot];
  if (slot >= rules.slots || !expected) {
    return `color ${slot} is none of the fighter's ${rules.slots} (a guide's?)`;
  }
  const color = image.colors[slot] ?? 0;
  const alpha = image.alpha[slot] ?? 255;
  const wanted = (expected.r << 16) | (expected.g << 8) | expected.b;
  if (color === wanted && alpha === expected.a) return undefined;
  return `color ${slot} is ${hex(color, alpha)} in the file, ${hex(wanted, expected.a)} in the fighter's palette (colors change in its palette.ts, not in a drawing)`;
}

function hex(color: number, alpha: number): string {
  const rgb = color.toString(16).padStart(6, '0');
  return `#${rgb}${alpha === 255 ? '' : alpha.toString(16).padStart(2, '0')}`;
}
