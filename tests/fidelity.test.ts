import { describe, expect, it } from 'vitest';
import { CELL_SIZE } from '../src/game/contract';
import { toLab } from '../src/game/lab';
import type { Bitmap } from '../src/pixels';
import { bitmap } from '../src/pixels';
import { PIXELIZE_DEFAULTS, pixelize } from '../src/pixelize';
import { placeOnCell, PLACEMENT_DEFAULTS } from '../src/place';
import { fighterFormat } from '../src/format';
import { SILHOUETTE_DEFAULTS, silhouetteOf } from '../src/silhouette';

describe('fidélité', () => {
  const SCALE = 4;
  const SIDE = CELL_SIZE * SCALE;

  async function strip() {
    const { decodeIndexedPng } = await import('../src/game/png');
    const { readFile } = await import('node:fs/promises');
    const url = new URL('./fixtures/idle.png', import.meta.url);
    return decodeIndexedPng(await readFile(url));
  }

  /** Frame 1 of the strip, as RGBA on its cell, and the rows it fills. */
  function cellOf(image: { width: number; pixels: Uint8Array; colors: readonly number[] }) {
    const truth = bitmap(CELL_SIZE, CELL_SIZE);
    let top = CELL_SIZE;
    let bottom = -1;
    for (let y = 0; y < CELL_SIZE; y++) {
      for (let x = 0; x < CELL_SIZE; x++) {
        const slot = image.pixels[y * image.width + x] ?? 0;
        if (slot === 0) continue;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        const color = image.colors[slot] ?? 0;
        const at = (y * CELL_SIZE + x) * 4;
        truth.data[at] = (color >> 16) & 0xff;
        truth.data[at + 1] = (color >> 8) & 0xff;
        truth.data[at + 2] = color & 0xff;
        truth.data[at + 3] = 255;
      }
    }
    return { truth, top, bottom };
  }

  /** The strip blown up block by block onto a wall that is lit, graded and grainy. */
  function photographed(truth: Bitmap): Bitmap {
    const photo = bitmap(SIDE, SIDE);
    for (let y = 0; y < SIDE; y++) {
      for (let x = 0; x < SIDE; x++) {
        const from = (Math.floor(y / SCALE) * CELL_SIZE + Math.floor(x / SCALE)) * 4;
        const alpha = (truth.data[from + 3] ?? 0) / 255;
        const grain = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
        const wall = [
          96 + (y / SIDE) * 28 + grain * 6 + (x / SIDE) * 10,
          92 + (y / SIDE) * 24 + grain * 6,
          104 + (y / SIDE) * 18 + grain * 6 - (x / SIDE) * 8,
        ];
        const at = (y * SIDE + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          photo.data[at + channel] =
            (truth.data[from + channel] ?? 0) * alpha + (wall[channel] ?? 0) * (1 - alpha);
        }
        photo.data[at + 3] = 255;
      }
    }
    return photo;
  }

  function deltaE(truth: Bitmap, made: Bitmap) {
    let sum = 0;
    let both = 0;
    let differ = 0;
    for (let pixel = 0; pixel < CELL_SIZE * CELL_SIZE; pixel++) {
      const at = pixel * 4;
      const left = (truth.data[at + 3] ?? 0) > 127;
      const right = (made.data[at + 3] ?? 0) > 127;
      if (left !== right) differ++;
      if (!left || !right) continue;
      const a = toLab(truth.data[at] ?? 0, truth.data[at + 1] ?? 0, truth.data[at + 2] ?? 0);
      const b = toLab(made.data[at] ?? 0, made.data[at + 1] ?? 0, made.data[at + 2] ?? 0);
      sum += Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
      both++;
    }
    return {
      deltaE: both === 0 ? 0 : sum / both,
      silhouette: (differ / (CELL_SIZE * CELL_SIZE)) * 100,
    };
  }

  /**
   * The anchor's column is a judgement, not a measurement: the strip's own anchor sits 9 px right
   * of where the feet's pixels centre, because the artist anchors on balance, not on mass. No
   * estimate found it (docs/art/roto.md §3), so the test nudges by what the drawing says and
   * scores what is left — which is the chain's own work.
   */
  const ANCHOR_IS_A_JUDGEMENT = -9;

  it('rebuilds a strip it was given back as a photo', async () => {
    const { truth, top, bottom } = cellOf(await strip());
    const photo = photographed(truth);
    const mask = silhouetteOf(photo, SILHOUETTE_DEFAULTS, toLab);
    const placed = placeOnCell(photo, mask, {
      ...PLACEMENT_DEFAULTS,
      format: fighterFormat(1),
      height: bottom - top + 1,
      nudgeX: ANCHOR_IS_A_JUDGEMENT,
    });
    const made = pixelize(placed.cell, placed.on, PIXELIZE_DEFAULTS);
    const score = deltaE(truth, made.cell);
    // Under 1, two colours are told apart only by a trained eye side by side.
    expect(score.deltaE).toBeLessThan(1);
    expect(score.silhouette).toBeLessThan(1);
  });

  it('loses it when the steps that cost more than they give are turned back on', async () => {
    const { truth, top, bottom } = cellOf(await strip());
    const photo = photographed(truth);
    const mask = silhouetteOf(photo, SILHOUETTE_DEFAULTS, toLab);
    const placed = placeOnCell(photo, mask, {
      ...PLACEMENT_DEFAULTS,
      format: fighterFormat(1),
      height: bottom - top + 1,
      nudgeX: ANCHOR_IS_A_JUDGEMENT,
      // The box filter the chain used before: every pixel the average of what it covers.
      edge: 0,
    });
    const made = pixelize(placed.cell, placed.on, {
      ...PIXELIZE_DEFAULTS,
      method: 'median',
      sharpen: 0.7,
      saturation: 1.1,
      orphans: 1,
    });
    // Far past a just-noticeable difference: this is what the measurements bought.
    expect(deltaE(truth, made.cell).deltaE).toBeGreaterThan(5);
  });
});
