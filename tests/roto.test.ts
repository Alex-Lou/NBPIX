import { describe, expect, it } from 'vitest';
import {
  ANCHOR,
  CELL_MARGIN,
  CELL_SIZE,
  LOWEST_ROW,
  PORTRAIT_SIZE,
  STANDING_HEIGHT,
} from '../src/game/contract';
import { toLab } from '../src/game/lab';
import type { Bitmap } from '../src/pixels';
import { bitmap } from '../src/pixels';
import { PIXELIZE_DEFAULTS, pixelize } from '../src/pixelize';
import { placeOnCell, PLACEMENT_DEFAULTS, PORTRAIT_DEFAULTS } from '../src/place';
import {
  atFinesse,
  boxFormat,
  fighterFormat,
  fittingHeight,
  FORMATS,
  PORTRAIT,
} from '../src/format';
import type { Corners } from '../src/silhouette';
import {
  crownOf,
  edgesOf,
  SILHOUETTE_DEFAULTS,
  painted,
  refine,
  silhouetteOf,
  soleOf,
  tidyEdges,
} from '../src/silhouette';
import type { Concern } from '../src/concerns';
import { anchorIsAGuess, concernsOf } from '../src/concerns';
import { pipelineProblems, rulesOf } from '../src/rules';
import { GAME_BOY, MEGA_DRIVE, NES, STYLES } from '../src/style';
import { stamp, stroke } from '../src/brush';
import { listOf, sentenceOf } from '../src/words';
import { inputOf, maskOf } from '../src/segment';
import { CELL_TARGET, fitZoom, maxZoom } from '../src/view';

/** A flat background with shapes painted on it, the way a studio photo looks to the tool. */
function scene(
  width: number,
  height: number,
  background: readonly [number, number, number],
  paint: (set: (x: number, y: number, color: readonly [number, number, number]) => void) => void,
): Bitmap {
  const image = bitmap(width, height);
  const set = (x: number, y: number, color: readonly [number, number, number]) => {
    const at = (y * width + x) * 4;
    image.data[at] = color[0];
    image.data[at + 1] = color[1];
    image.data[at + 2] = color[2];
    image.data[at + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, background);
  paint(set);
  return image;
}

const SUBJECT = [30, 40, 60] as const;
const WALL = [200, 196, 190] as const;

/** A 20 × 50 subject standing in a 100 × 80 frame, its feet on row 59. */
function standing(): Bitmap {
  return scene(100, 80, WALL, (set) => {
    for (let y = 10; y <= 59; y++) for (let x = 20; x <= 39; x++) set(x, y, SUBJECT);
  });
}

function found(image: Bitmap) {
  return silhouetteOf(image, SILHOUETTE_DEFAULTS, toLab);
}

describe('silhouette', () => {
  it('keys a plain background out and keeps the subject whole', () => {
    const mask = found(standing());
    expect(mask.from).toBe('key');
    expect(mask.box).toEqual({ left: 20, top: 10, right: 39, bottom: 59 });
    expect(mask.pixels).toBe(20 * 50);
    expect(mask.islands).toBe(1);
  });

  it('reads the alpha channel when the image carries one', () => {
    const image = standing();
    for (let pixel = 0; pixel < image.width * image.height; pixel++) {
      const x = pixel % image.width;
      const y = (pixel - x) / image.width;
      const inside = x >= 20 && x <= 39 && y >= 10 && y <= 59;
      image.data[pixel * 4 + 3] = inside ? 255 : 0;
    }
    const mask = found(image);
    expect(mask.from).toBe('alpha');
    expect(mask.box).toEqual({ left: 20, top: 10, right: 39, bottom: 59 });
  });

  it('keeps a hole the background colour never reaches', () => {
    const image = scene(100, 80, WALL, (set) => {
      for (let y = 10; y <= 59; y++) for (let x = 20; x <= 39; x++) set(x, y, SUBJECT);
      // A window of wall colour, walled in by the subject: the fill cannot get to it.
      for (let y = 25; y <= 30; y++) for (let x = 26; x <= 31; x++) set(x, y, WALL);
    });
    const mask = found(image);
    expect(mask.pixels).toBe(20 * 50);
    expect(mask.on[27 * 100 + 28]).toBe(1);
  });

  it('drops a speck far from the subject', () => {
    const image = scene(100, 80, WALL, (set) => {
      for (let y = 10; y <= 59; y++) for (let x = 20; x <= 39; x++) set(x, y, SUBJECT);
      // Three pixels across, so the tidy pass leaves it and despeckling is what drops it.
      for (let y = 69; y <= 71; y++) for (let x = 79; x <= 81; x++) set(x, y, SUBJECT);
    });
    const mask = found(image);
    expect(mask.specks).toBe(1);
    expect(mask.islands).toBe(1);
    expect(mask.on[70 * 100 + 80]).toBe(0);
  });

  it('rubs a single-pixel fringe off the edge, and leaves real shapes', () => {
    const on = new Uint8Array(9 * 9);
    const at = (x: number, y: number) => y * 9 + x;
    // A 5 x 5 block with one pixel sticking out and one pinhole bitten into it.
    for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) on[at(x, y)] = 1;
    on[at(7, 4)] = 1;
    on[at(4, 2)] = 0;
    tidyEdges(9, 9, on);
    expect(on[at(7, 4)]).toBe(0);
    expect(on[at(4, 2)]).toBe(1);
    expect(on[at(4, 4)]).toBe(1);
  });

  it('says which edges of the frame the subject runs into', () => {
    expect(edgesOf(found(standing()))).toEqual({
      left: false,
      top: false,
      right: false,
      bottom: false,
    });
    // Against the left edge, with every corner still on the wall.
    const leaning = scene(100, 80, WALL, (set) => {
      for (let y = 10; y <= 59; y++) for (let x = 0; x <= 39; x++) set(x, y, SUBJECT);
    });
    expect(edgesOf(found(leaning))).toMatchObject({ left: true, right: false, bottom: false });
  });

  it('starts only from the corners it is given', () => {
    // A dark subject wearing a dark band across the bottom: both bottom corners sit on it, agree
    // with each other, and seeding there floods the whole subject. Untick them and it is kept.
    const dressed = scene(100, 80, WALL, (set) => {
      for (let y = 20; y <= 55; y++) for (let x = 30; x <= 69; x++) set(x, y, SUBJECT);
      for (let y = 56; y <= 79; y++) for (let x = 0; x <= 99; x++) set(x, y, SUBJECT);
    });
    const withEvery = silhouetteOf(dressed, SILHOUETTE_DEFAULTS, toLab);
    expect(withEvery.pixels).toBeLessThan(1000);
    const topOnly: Corners = {
      topLeft: true,
      topRight: true,
      bottomLeft: false,
      bottomRight: false,
    };
    const kept = silhouetteOf(dressed, { ...SILHOUETTE_DEFAULTS, corners: topOnly }, toLab);
    expect(kept.seeds).toBe(2);
    expect(kept.pixels).toBe(40 * 36 + 100 * 24);
  });

  it('ignores a corner standing on the subject instead of flooding the subject', () => {
    // The subject runs into the bottom left corner: seeding there would key the subject out.
    const corner = scene(100, 60, WALL, (set) => {
      for (let y = 10; y <= 59; y++) for (let x = 0; x <= 39; x++) set(x, y, SUBJECT);
    });
    const mask = found(corner);
    expect(mask.dropped).toBe(1);
    expect(mask.seeds).toBe(3);
    expect(mask.pixels).toBe(40 * 50);
    expect(
      concernsOf(mask, soleOf(mask), { left: 0, top: 0, right: 0, bottom: 0 }).map((c) => c.kind),
    ).toContain('corner-dropped');
  });

  it('does not leak into a subject that touches the bottom edge', () => {
    const image = scene(100, 60, WALL, (set) => {
      for (let y = 10; y <= 59; y++) for (let x = 20; x <= 39; x++) set(x, y, SUBJECT);
    });
    const mask = found(image);
    expect(mask.box.bottom).toBe(59);
    expect(mask.pixels).toBe(20 * 50);
  });

  it('puts the sole at the middle of the lowest band, and says how wide it is', () => {
    const sole = soleOf(found(standing()));
    expect(sole.y).toBe(59);
    expect(sole.x).toBeCloseTo(29.5, 1);
    expect(sole.width).toBe(20);
  });
});

describe('concerns', () => {
  const noOverflow = { left: 0, top: 0, right: 0, bottom: 0 };

  it('raises nothing on a subject that stands clear in its frame', () => {
    const mask = found(standing());
    const concerns = concernsOf(mask, soleOf(mask), noOverflow);
    expect(concerns).toEqual([]);
    expect(anchorIsAGuess(concerns)).toBe(false);
  });

  /** A head and a thin neck running down: what a portrait with no feet looks like to the tool. */
  it('says the anchor is a guess when the base is a sliver', () => {
    const image = scene(100, 80, WALL, (set) => {
      for (let y = 10; y <= 45; y++) for (let x = 20; x <= 59; x++) set(x, y, SUBJECT);
      for (let y = 46; y <= 69; y++) for (let x = 38; x <= 41; x++) set(x, y, SUBJECT);
    });
    const mask = found(image);
    const concerns = concernsOf(mask, soleOf(mask), noOverflow);
    expect(concerns.map((concern) => concern.kind)).toContain('narrow-base');
    expect(anchorIsAGuess(concerns)).toBe(true);
  });

  it('says the anchor is a guess when the subject runs off the bottom', () => {
    const image = scene(100, 60, WALL, (set) => {
      for (let y = 10; y <= 59; y++) for (let x = 20; x <= 39; x++) set(x, y, SUBJECT);
    });
    const mask = found(image);
    const concerns = concernsOf(mask, soleOf(mask), noOverflow);
    expect(concerns.map((concern) => concern.kind)).toContain('cut-off');
    expect(anchorIsAGuess(concerns)).toBe(true);
  });

  it('reports a subject that does not fit the cell', () => {
    const mask = found(standing());
    const concerns = concernsOf(mask, soleOf(mask), { left: 0, top: 12, right: 0, bottom: 0 });
    expect(concerns.map((concern) => concern.kind)).toContain('overflow');
  });
});

/** The rows and columns a placed cell actually draws on. */
function drawnBox(cell: Bitmap) {
  let left = cell.width;
  let top = cell.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      if ((cell.data[(y * cell.width + x) * 4 + 3] ?? 0) === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { left, top, right, bottom };
}

describe('placement', () => {
  const place = (height: number, over: Partial<Parameters<typeof placeOnCell>[2]> = {}) => {
    const image = standing();
    return placeOnCell(image, found(image), {
      ...PLACEMENT_DEFAULTS,
      format: fighterFormat(1),
      height,
      ...over,
    });
  };

  it('stands the feet on the anchor row, centred on the anchor column', () => {
    const box = drawnBox(place(50).cell);
    expect(box.bottom).toBe(ANCHOR.y);
    expect((box.left + box.right) / 2).toBeCloseTo(ANCHOR.x, 0);
  });

  it('draws the subject at the height it was asked for', () => {
    for (const height of [50, 100, 157]) {
      const box = drawnBox(place(height).cell);
      expect(box.bottom - box.top + 1).toBeCloseTo(height, -0.5);
    }
  });

  it('never leaves a half-transparent pixel', () => {
    const { cell } = place(157);
    for (let pixel = 0; pixel < cell.width * cell.height; pixel++) {
      expect([0, 255]).toContain(cell.data[pixel * 4 + 3]);
    }
  });

  it('says how far the subject went past the cell', () => {
    expect(place(50).overflow).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    // Taller than the anchor row is high: the head goes out of the top.
    expect(place(400).overflow.top).toBeGreaterThan(0);
  });

  it('turns a subject over without moving its feet', () => {
    const straight = drawnBox(place(50).cell);
    const turned = drawnBox(place(50, { flip: true }).cell);
    expect(turned.bottom).toBe(straight.bottom);
    expect((turned.left + turned.right) / 2).toBeCloseTo(ANCHOR.x, 0);
  });
});

describe('pixelize', () => {
  const made = (over: Partial<typeof PIXELIZE_DEFAULTS> = {}) => {
    const image = standing();
    const placed = placeOnCell(image, found(image), {
      ...PLACEMENT_DEFAULTS,
      format: fighterFormat(1),
      height: 157,
    });
    return { placed, out: pixelize(placed.cell, placed.on, { ...PIXELIZE_DEFAULTS, ...over }) };
  };

  it('keeps the palette under the size it was given', () => {
    for (const colors of [4, 8, 32]) {
      expect(made({ colors }).out.colors).toBeLessThanOrEqual(colors);
    }
  });

  it('leaves the empty part of the cell alone', () => {
    const { placed, out } = made();
    for (let pixel = 0; pixel < placed.on.length; pixel++) {
      if ((placed.on[pixel] ?? 0) === 1) continue;
      expect(out.cell.data[pixel * 4 + 3]).toBe(0);
    }
  });

  it('draws a darker edge than the inside', () => {
    const { out } = made({ colors: 0 });
    const box = drawnBox(out.cell);
    const light = (x: number, y: number) => {
      const at = (y * out.cell.width + x) * 4;
      return (out.cell.data[at] ?? 0) + (out.cell.data[at + 1] ?? 0) + (out.cell.data[at + 2] ?? 0);
    };
    const middleY = Math.round((box.top + box.bottom) / 2);
    expect(light(box.left, middleY)).toBeLessThan(light(box.left + 3, middleY));
  });

  it('draws no edge when the outline is turned off', () => {
    const { out } = made({ colors: 0, outline: 1, sharpen: 0, saturation: 1 });
    const box = drawnBox(out.cell);
    const middleY = Math.round((box.top + box.bottom) / 2);
    const at = (x: number) => (middleY * out.cell.width + x) * 4;
    expect(out.cell.data[at(box.left)]).toBe(out.cell.data[at(box.left + 3)]);
  });
});

describe('portrait', () => {
  /** A head of 40 x 36 over a narrow neck running down to the bottom: a bust, as a photo gives one. */
  function bust(): Bitmap {
    return scene(100, 80, WALL, (set) => {
      for (let y = 8; y <= 43; y++) for (let x = 30; x <= 69; x++) set(x, y, SUBJECT);
      for (let y = 44; y <= 79; y++) for (let x = 44; x <= 55; x++) set(x, y, SUBJECT);
    });
  }

  const place = (image: Bitmap, over: Partial<Parameters<typeof placeOnCell>[2]> = {}) =>
    placeOnCell(image, found(image), { ...PORTRAIT_DEFAULTS, ...over });

  it('keeps the size the pipeline asks a portrait for', () => {
    expect(PORTRAIT_DEFAULTS.format.width).toBe(PORTRAIT_SIZE);
    expect(PORTRAIT_DEFAULTS.format.height).toBe(PORTRAIT_SIZE);
  });

  it('measures the crown as soleOf measures the feet', () => {
    const crown = crownOf(found(bust()));
    expect(crown.y).toBe(8);
    expect(crown.x).toBeCloseTo(49.5, 0);
  });

  it('centres the head on the square and hangs it under the air', () => {
    const box = drawnBox(place(bust(), { height: 72 }).cell);
    expect((box.left + box.right + 1) / 2).toBeCloseTo(PORTRAIT_SIZE / 2, 0);
    // About 6 % of the square left over the hair.
    expect(box.top).toBeGreaterThanOrEqual(4);
    expect(box.top).toBeLessThanOrEqual(7);
  });

  it('lets the shoulders run off the bottom without calling it a problem', () => {
    const image = bust();
    const mask = found(image);
    const placed = place(image);
    const kinds = concernsOf(mask, soleOf(mask), placed.overflow, 'crown').map((c) => c.kind);
    expect(kinds).not.toContain('narrow-base');
    expect(kinds).not.toContain('cut-off');
    expect(kinds).not.toContain('overflow');
  });

  it('still says when a side or the top is cut', () => {
    const image = scene(100, 80, WALL, (set) => {
      for (let y = 0; y <= 43; y++) for (let x = 30; x <= 69; x++) set(x, y, SUBJECT);
      for (let y = 44; y <= 79; y++) for (let x = 44; x <= 55; x++) set(x, y, SUBJECT);
    });
    const mask = found(image);
    const kinds = concernsOf(mask, soleOf(mask), place(image).overflow, 'crown').map((c) => c.kind);
    expect(kinds).toContain('cut-off');
  });

  it('does not underline the square its own border crops', () => {
    const image = bust();
    const placed = place(image);
    const out = pixelize(placed.cell, placed.on, { ...PIXELIZE_DEFAULTS, colors: 0 });
    const row = (y: number, x: number) => {
      const at = (y * out.cell.width + x) * 4;
      return (out.cell.data[at] ?? 0) + (out.cell.data[at + 1] ?? 0) + (out.cell.data[at + 2] ?? 0);
    };
    const box = drawnBox(out.cell);
    const middle = Math.round((box.left + box.right) / 2);
    expect(box.bottom).toBe(PORTRAIT_SIZE - 1);
    // The last row is a crop, not a silhouette: as light as the neck above it.
    expect(row(PORTRAIT_SIZE - 1, middle)).toBe(row(PORTRAIT_SIZE - 4, middle));
  });
});

/**
 * The chain against a sprite it should be able to give back. The fake photo is built here, from a
 * strip the repository already holds, by blowing it up with nearest neighbour onto a lit wall with
 * grain: every source pixel becomes a clean block, so a chain that loses nothing can rebuild the
 * drawing. It is a best case on purpose — the point is to catch the chain losing what *is* there.
 */
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

describe('pinceau', () => {
  /** A sheet of paint over the work image: 1 subject, -1 background, 0 no opinion. */
  function sheet(mask: ReturnType<typeof found>) {
    return new Int8Array(mask.width * mask.height);
  }

  it('lets the hand add what the key threw away', () => {
    const image = standing();
    const mask = found(image);
    const paint = sheet(mask);
    // A square of wall, well clear of the subject, claimed as subject.
    for (let y = 65; y <= 70; y++) for (let x = 70; x <= 75; x++) paint[y * mask.width + x] = 1;
    const fixed = painted(mask, paint);
    expect(fixed.pixels).toBe(mask.pixels + 36);
    expect(fixed.on[67 * mask.width + 72]).toBe(1);
    expect(fixed.box.right).toBe(75);
    expect(fixed.box.bottom).toBe(70);
  });

  it('lets the hand take back what the key kept', () => {
    const image = standing();
    const mask = found(image);
    const paint = sheet(mask);
    for (let y = 20; y <= 29; y++) for (let x = 25; x <= 34; x++) paint[y * mask.width + x] = -1;
    const fixed = painted(mask, paint);
    expect(fixed.pixels).toBe(mask.pixels - 100);
    expect(fixed.on[25 * mask.width + 30]).toBe(0);
  });

  it('leaves every pixel the hand said nothing about', () => {
    const image = standing();
    const mask = found(image);
    const fixed = painted(mask, sheet(mask));
    expect(fixed.on).toEqual(mask.on);
    expect(fixed.box).toEqual(mask.box);
    expect(fixed.pixels).toBe(mask.pixels);
  });
});

describe('règles du pipeline', () => {
  /** A square with a block drawn in it, as the tool's own output looks to the rules. */
  function square(side: number, box: { left: number; top: number; right: number; bottom: number }) {
    const cell = bitmap(side, side);
    const on = new Uint8Array(side * side);
    for (let y = box.top; y <= box.bottom; y++) {
      for (let x = box.left; x <= box.right; x++) {
        const at = (y * side + x) * 4;
        cell.data[at] = 200;
        cell.data[at + 1] = 180;
        cell.data[at + 2] = 160;
        cell.data[at + 3] = 255;
        on[y * side + x] = 1;
      }
    }
    return { cell, on };
  }

  it('takes a cell that keeps its margins', () => {
    const { cell, on } = square(CELL_SIZE, { left: 40, top: 40, right: 200, bottom: 248 });
    expect(pipelineProblems(cell, on, fighterFormat(1))).toEqual([]);
  });

  it('refuses a cell drawn to the edge, in the pipeline’s own words', () => {
    const { cell, on } = square(CELL_SIZE, { left: 0, top: 40, right: 200, bottom: 248 });
    const problems = pipelineProblems(cell, on, fighterFormat(1));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("cell's edge");
  });

  it('refuses a cell drawn under the ground', () => {
    const { cell, on } = square(CELL_SIZE, { left: 40, top: 40, right: 200, bottom: 254 });
    expect(pipelineProblems(cell, on, fighterFormat(1)).join(' ')).toContain('under the ground');
  });

  it('lets a bust fill its square to the bottom, which a portrait may', () => {
    const { cell, on } = square(PORTRAIT_SIZE, { left: 0, top: 0, right: 95, bottom: 95 });
    expect(pipelineProblems(cell, on, PORTRAIT)).toEqual([]);
  });

  it('holds a finer square to the same rules at its own scale', () => {
    // 8 px of margin at finesse x2 is the same 2 world pixels as 4 px at x1.
    const tight = square(CELL_SIZE * 2, { left: 6, top: 40, right: 400, bottom: 496 });
    expect(pipelineProblems(tight.cell, tight.on, atFinesse(fighterFormat(1), 2))).toHaveLength(1);
    const fine = square(CELL_SIZE * 2, { left: 10, top: 40, right: 400, bottom: 496 });
    expect(pipelineProblems(fine.cell, fine.on, atFinesse(fighterFormat(1), 2))).toEqual([]);
  });
});

describe('traits du pinceau', () => {
  const sheetOf = (width: number, height: number) => ({
    width,
    height,
    paint: new Int8Array(width * height),
  });

  it('pose un disque, pas un carré', () => {
    const sheet = sheetOf(21, 21);
    stamp(sheet, { x: 10, y: 10 }, 5, 1);
    expect(sheet.paint[10 * 21 + 10]).toBe(1);
    // Straight out from the middle is inside; the corner of the square around it is not.
    expect(sheet.paint[10 * 21 + 14]).toBe(1);
    expect(sheet.paint[6 * 21 + 6]).toBe(0);
  });

  it('ne déborde pas de la feuille', () => {
    const sheet = sheetOf(10, 10);
    stamp(sheet, { x: 0, y: 0 }, 6, -1);
    expect(sheet.paint[0]).toBe(-1);
    // Nothing wrapped around to the other end of the row.
    expect(sheet.paint[9]).toBe(0);
    expect(sheet.paint.length).toBe(100);
  });

  it('remplit un trait rapide au lieu de le pointiller', () => {
    const sheet = sheetOf(120, 20);
    // Far further than one stamp: what a quick drag reports between two events.
    stroke(sheet, { x: 10, y: 10 }, { x: 110, y: 10 }, 4, 1);
    for (let x = 10; x <= 110; x++) expect(sheet.paint[10 * 120 + x]).toBe(1);
  });

  it('laisse le reste de la feuille intact', () => {
    const sheet = sheetOf(40, 40);
    stroke(sheet, { x: 5, y: 5 }, { x: 10, y: 5 }, 3, 1);
    expect(sheet.paint[35 * 40 + 35]).toBe(0);
  });
});

describe('les mots', () => {
  it('énumère comme une phrase', () => {
    expect(listOf(['gauche'])).toBe('gauche');
    expect(listOf(['gauche', 'droit'])).toBe('gauche et droit');
    expect(listOf(['gauche', false, 'haut', 'bas'])).toBe('gauche, haut et bas');
  });

  it('dit chaque avertissement sans en oublier un', () => {
    const every: Concern[] = [
      { kind: 'nothing-kept', share: 0.004 },
      { kind: 'everything-kept', share: 0.98 },
      { kind: 'narrow-base', width: 23, share: 0.05 },
      { kind: 'cut-off', edges: { left: true, top: false, right: true, bottom: false } },
      { kind: 'corner-dropped', dropped: 1 },
      { kind: 'specks', specks: 143 },
      { kind: 'overflow', overflow: { left: 1, top: 0, right: 5, bottom: 6 } },
    ];
    for (const concern of every) {
      const said = sentenceOf(concern);
      expect(said.length).toBeGreaterThan(20);
      expect(said).not.toContain('undefined');
    }
    expect(sentenceOf(every[3] as Concern)).toContain('gauche et droit');
    expect(sentenceOf(every[6] as Concern)).toContain('5 px à droite');
  });
});

/**
 * The model's own weights are not in the repository (`npm run roto:model` fetches them), so what
 * is tested here is everything around the inference: the picture turned into what the model wants,
 * and its answer turned back into a mask. Those are where a silent mistake would hide — a channel
 * swapped, a threshold read upside down — and neither needs the runtime.
 */
describe('modèle', () => {
  const SIDE = 320;

  it('prépare l’image comme le modèle l’attend', () => {
    const image = bitmap(2, 2);
    // A single flat colour, so every sample is the same and the maths is checkable by hand.
    for (let pixel = 0; pixel < 4; pixel++) {
      image.data[pixel * 4] = 255;
      image.data[pixel * 4 + 1] = 0;
      image.data[pixel * 4 + 2] = 128;
      image.data[pixel * 4 + 3] = 255;
    }
    const input = inputOf(image);
    expect(input.length).toBe(3 * SIDE * SIDE);
    // Three planes, not three values a pixel: red first, then green, then blue.
    expect(input[0]).toBeCloseTo((1 - 0.485) / 0.229, 4);
    expect(input[SIDE * SIDE]).toBeCloseTo((0 - 0.456) / 0.224, 4);
    expect(input[2 * SIDE * SIDE]).toBeCloseTo((128 / 255 - 0.406) / 0.225, 4);
  });

  it('étire la confiance du modèle avant de trancher', () => {
    const image = bitmap(SIDE, 1);
    // A map whose values sit in a narrow band: a fixed threshold would keep all or nothing.
    const map = new Float32Array(SIDE * SIDE);
    // The whole map, not one row: the untouched rest would set the lowest value itself.
    for (let y = 0; y < SIDE; y++) {
      for (let x = 0; x < SIDE; x++) map[y * SIDE + x] = 0.8 + (0.04 * x) / SIDE;
    }
    const on = maskOf(map, image, 0.5);
    expect(on[0]).toBe(0);
    expect(on[SIDE - 1]).toBe(1);
    // Half of a straight ramp, give or take a pixel.
    const kept = on.reduce((total, value) => total + value, 0);
    expect(kept).toBeGreaterThan(SIDE * 0.45);
    expect(kept).toBeLessThan(SIDE * 0.55);
  });

  it('garde tout ou rien quand le modèle ne voit rien', () => {
    const image = bitmap(8, 8);
    const flat = new Float32Array(SIDE * SIDE).fill(0.3);
    expect(maskOf(flat, image, 0.5).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('écrit dans le tampon qu’on lui donne, sans en allouer un autre', () => {
    const image = bitmap(8, 8);
    const into = new Uint8Array(64);
    const map = new Float32Array(SIDE * SIDE).fill(1);
    map[0] = 0;
    expect(maskOf(map, image, 0.5, into)).toBe(into);
  });

  it('nettoie le masque du modèle comme celui de la couleur', () => {
    // A block with a single-pixel spur and a speck, as any mask may have.
    const on = new Uint8Array(40 * 40);
    for (let y = 10; y <= 25; y++) for (let x = 10; x <= 25; x++) on[y * 40 + x] = 1;
    on[18 * 40 + 26] = 1;
    on[35 * 40 + 35] = 1;
    const mask = refine(
      40,
      40,
      on,
      { tidy: 1, minShare: 0.02 },
      {
        from: 'model',
        seeds: 0,
        dropped: 0,
      },
    );
    expect(mask.from).toBe('model');
    expect(mask.pixels).toBe(16 * 16);
    expect(mask.box).toEqual({ left: 10, top: 10, right: 25, bottom: 25 });
  });
});

/**
 * NBPIX is a repository of its own, so nothing makes it follow NayosBeat. These numbers are the
 * game's, copied into src/game/contract.ts; this states every one of them out loud so that a
 * change over there is a **failing test** here rather than a sprite that silently lands wrong.
 *
 * Where each one lives in NayosBeat:
 *
 * | ici | là-bas |
 * |---|---|
 * | `CELL_SIZE`, `ANCHOR` | `src/art/types.ts` |
 * | `CELL_MARGIN`, `LOWEST_ROW` | `tools/sprites/cell.ts` |
 * | `PORTRAIT_SIZE` | `tools/sprites/drawn.ts` |
 * | `STANDING_HEIGHT` | mesurée sur `art-src/feline/idle.png` |
 */
describe('le contrat de NayosBeat', () => {
  it('tient les chiffres du jeu, un par un', () => {
    expect(CELL_SIZE).toBe(256);
    expect(ANCHOR).toEqual({ x: 128, y: 248 });
    expect(CELL_MARGIN).toBe(4);
    expect(LOWEST_ROW).toBe(250);
    expect(PORTRAIT_SIZE).toBe(96);
    expect(STANDING_HEIGHT).toBe(157);
  });

  it('garde l’ancre dans la case, et la rangée basse sous elle', () => {
    expect(ANCHOR.x).toBeLessThan(CELL_SIZE);
    expect(ANCHOR.y).toBeLessThan(CELL_SIZE);
    expect(LOWEST_ROW).toBeGreaterThan(ANCHOR.y);
    expect(LOWEST_ROW).toBeLessThan(CELL_SIZE);
    expect(STANDING_HEIGHT).toBeLessThan(ANCHOR.y);
  });
});

/**
 * Un format, c'est une boîte et une règle pour y poser le sujet. Ce qui est vérifié ici, c'est que
 * les trois règles posent bien où elles disent, et qu'un format tient ses promesses quelle que
 * soit la finesse.
 */
describe('formats', () => {
  /** Un sujet bien à l'intérieur de son cadre, plus haut que large. */
  function subject(): Bitmap {
    return scene(100, 80, WALL, (set) => {
      for (let y = 10; y <= 59; y++) for (let x = 30; x <= 49; x++) set(x, y, SUBJECT);
    });
  }

  it('centre un objet dans sa boîte, sans rien devoir à une ancre', () => {
    const image = subject();
    const placed = placeOnCell(image, found(image), {
      ...PLACEMENT_DEFAULTS,
      format: boxFormat(32),
      height: 24,
    });
    const box = drawnBox(placed.cell);
    expect((box.left + box.right) / 2).toBeCloseTo(15.5, 0);
    expect((box.top + box.bottom) / 2).toBeCloseTo(15.5, 0);
  });

  it('tient dans la boîte, marges comprises, quand on demande de remplir', () => {
    const image = subject();
    const mask = found(image);
    const format = boxFormat(16);
    const height = fittingHeight(format, {
      width: mask.box.right - mask.box.left + 1,
      height: mask.box.bottom - mask.box.top + 1,
    });
    const placed = placeOnCell(image, mask, { ...PLACEMENT_DEFAULTS, format, height });
    const box = drawnBox(placed.cell);
    expect(box.left).toBeGreaterThanOrEqual(format.margin);
    expect(box.top).toBeGreaterThanOrEqual(format.margin);
    expect(box.right).toBeLessThanOrEqual(format.width - 1 - format.margin);
    expect(box.bottom).toBeLessThanOrEqual(format.height - 1 - format.margin);
    expect(pipelineProblems(placed.cell, placed.on, format)).toEqual([]);
  });

  it('garde les pieds sur l’ancre, quel que soit le format de planche', () => {
    const image = subject();
    for (const scale of [1, 2]) {
      const format = fighterFormat(scale);
      const placed = placeOnCell(image, found(image), {
        ...PLACEMENT_DEFAULTS,
        format,
        height: 100 * scale,
      });
      const box = drawnBox(placed.cell);
      const pin = format.pin;
      expect(pin.kind).toBe('feet');
      if (pin.kind !== 'feet') return;
      expect(box.bottom).toBe(pin.row);
      expect((box.left + box.right) / 2).toBeCloseTo(pin.column, 0);
    }
  });

  it('dessine la même chose, plus finement, à une autre finesse', () => {
    const format = fighterFormat(1);
    const finer = atFinesse(format, 2);
    expect(finer.width).toBe(format.width * 2);
    expect(finer.margin).toBe(format.margin * 2);
    // La rangée basse est un indice, pas une longueur : elle se décale d'un pixel de moins.
    expect(finer.lowestRow).toBe((format.lowestRow + 1) * 2 - 1);
    const pin = finer.pin;
    expect(pin.kind).toBe('feet');
    if (pin.kind !== 'feet') return;
    expect(pin.column).toBe(ANCHOR.x * 2);
  });

  it('propose à chaque format une hauteur qui a du sens pour lui', () => {
    for (const format of FORMATS) {
      expect(format.height0).toBeGreaterThan(0);
      expect(format.height0).toBeLessThanOrEqual(format.height);
      expect(format.margin * 2).toBeLessThan(Math.min(format.width, format.height));
      expect(format.lowestRow).toBeLessThan(format.height);
    }
  });

  it('tient les règles du jeu sur ses propres formats, et pas plus', () => {
    // Un objet de 16 px n'a aucune ancre à tenir : seules sa taille et ses marges comptent.
    const tiny = boxFormat(16);
    expect(tiny.pin.kind).toBe('box');
    expect(rulesOf(tiny)).toMatchObject({ width: 16, height: 16, frames: 1, margin: tiny.margin });
  });
});

/**
 * Le cas que la règle évidente perdait. Une épée réduite assez fort n'a plus de lame assez épaisse
 * pour couvrir la moitié d'un pixel : à 16 × 16 elle disparaissait entièrement — pas « moins de
 * détail », **plus d'objet du tout**.
 */
describe('les formes fines survivent', () => {
  /** Une lame verticale fine sur un fond uni, et rien d'autre. */
  function blade(thickness: number): Bitmap {
    return scene(200, 400, WALL, (set) => {
      const middle = 100;
      for (let y = 40; y <= 360; y++) {
        for (let x = middle - thickness / 2; x < middle + thickness / 2; x++) {
          set(Math.round(x), y, SUBJECT);
        }
      }
    });
  }

  const drawnOn = (image: Bitmap, side: number) => {
    const mask = found(image);
    const format = boxFormat(side, 0);
    const placed = placeOnCell(image, mask, {
      ...PLACEMENT_DEFAULTS,
      format,
      height: fittingHeight(format, {
        width: mask.box.right - mask.box.left + 1,
        height: mask.box.bottom - mask.box.top + 1,
      }),
    });
    return placed.on.reduce((total: number, value) => total + value, 0);
  };

  it('garde une lame que la moitié d’un pixel ne couvrirait pas', () => {
    // 10 px de large sur 320 de haut : réduite à 16, la lame fait un demi-pixel.
    expect(drawnOn(blade(10), 16)).toBeGreaterThan(8);
  });

  it('la garde à toutes les tailles, de plus en plus finement', () => {
    const image = blade(10);
    const small = drawnOn(image, 16);
    const large = drawnOn(image, 64);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });

  it('ne grossit pas une forme déjà épaisse', () => {
    // Un bloc large couvre pleinement ses pixels : la règle des crêtes ne doit rien y ajouter.
    const fat = scene(200, 200, WALL, (set) => {
      for (let y = 50; y <= 149; y++) for (let x = 50; x <= 149; x++) set(x, y, SUBJECT);
    });
    const format = boxFormat(32, 0);
    const mask = found(fat);
    const placed = placeOnCell(fat, mask, { ...PLACEMENT_DEFAULTS, format, height: 32 });
    const box = drawnBox(placed.cell);
    expect(box.right - box.left + 1).toBeLessThanOrEqual(33);
    expect(box.bottom - box.top + 1).toBeLessThanOrEqual(33);
  });
});

describe('styles historiques', () => {
  it('impose à chaque machine ce qu’elle imposait vraiment', () => {
    const byName = (name: string) => STYLES.find((style) => style.name.startsWith(name));
    // 3 couleurs sur NES et Game Boy, 15 sur la génération 16 bits : c'est le matériel.
    expect(byName('NES')?.colors).toBe(3);
    expect(byName('Game Boy')?.colors).toBe(3);
    expect(byName('SNES')?.colors).toBe(15);
    expect(byName('Mega Drive')?.colors).toBe(15);
  });

  it('pose chaque couleur sur une que la machine savait afficher', () => {
    // La Mega Drive code 3 bits par canal : toute valeur doit tomber sur un de ses 8 niveaux.
    const levels = Array.from({ length: 8 }, (_, step) => Math.round((step / 7) * 255));
    for (const value of [0, 17, 130, 200, 255]) {
      const [r, g, b] = MEGA_DRIVE.snap(value, value, value);
      for (const channel of [r, g, b]) expect(levels).toContain(channel);
    }
  });

  it('ne rend que des couleurs de la table d’une machine qui en a une', () => {
    const [r, g, b] = NES.snap(123, 45, 67);
    // Une couleur de la NES, pas celle qu'on lui a donnée.
    expect([r, g, b]).not.toEqual([123, 45, 67]);
    expect(GAME_BOY.snap(255, 255, 255)).toEqual([155, 188, 15]);
  });
});

describe('le zoom de la case', () => {
  // La place d'une colonne de la page sur un écran courant : assez pour la cible.
  const ROOM = 770;

  it('rend une petite case à une taille qu’on peut juger', () => {
    // Le bug : 32 px de case rendus en 32 px d'écran, invisibles.
    for (const side of [16, 32, 64, 96, 128, 256]) {
      const shown = side * fitZoom(side, ROOM);
      expect(shown).toBeGreaterThanOrEqual(400);
      expect(shown).toBeLessThanOrEqual(CELL_TARGET + side);
    }
  });

  it('ne donne qu’un facteur entier', () => {
    // Un facteur fractionnaire rend certaines rangées plus épaisses : c'est ce qu'on vient voir.
    for (const side of [16, 32, 48, 96, 150, 256, 512]) {
      expect(Number.isInteger(fitZoom(side, ROOM))).toBe(true);
    }
  });

  it('ne dépasse jamais la place dont il dispose', () => {
    for (const room of [120, 360, 450, 770, 4000]) {
      for (const side of [16, 32, 64, 256]) {
        const shown = side * fitZoom(side, room);
        // Sauf à ×1, où une case plus large que la place reste dessinée telle quelle.
        if (fitZoom(side, room) > 1) expect(shown).toBeLessThanOrEqual(room);
      }
    }
  });

  it('reste à ×1 pour une case déjà plus grande que la cible', () => {
    expect(fitZoom(512, ROOM)).toBe(1);
    // Une planche HD à finesse ×4 : rien à agrandir.
    expect(fitZoom(2048, ROOM)).toBe(1);
  });

  it('refuse une toile que le navigateur ne donnerait pas', () => {
    // ×32 demandé à la main sur une case de 512 ferait 16 384 px de côté, soit un gigaoctet.
    for (const side of [16, 32, 256, 512]) {
      expect(side * maxZoom(side)).toBeLessThanOrEqual(4096);
    }
    expect(maxZoom(512)).toBe(8);
    expect(maxZoom(8192)).toBe(1);
  });

  it('ne rend jamais un zoom absurde quand la place est illisible', () => {
    // Figure encore cachée : largeur 0, et un CSS illisible donne NaN. Ni l'un ni l'autre ne doit
    // sortir un NaN, qui ferait une toile de taille 0 et un carré noir.
    expect(fitZoom(32, 0)).toBe(1);
    expect(fitZoom(32, Number.NaN)).toBe(14);
    expect(fitZoom(0, ROOM)).toBe(1);
    expect(fitZoom(Number.NaN, ROOM)).toBe(1);
  });
});
