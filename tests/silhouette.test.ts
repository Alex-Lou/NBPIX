import { describe, expect, it } from 'vitest';
import { scene, SUBJECT, WALL, standing, found } from './support';
import { toLab } from '../src/game/lab';
import type { Corners } from '../src/silhouette';
import {
  edgesOf,
  SILHOUETTE_DEFAULTS,
  painted,
  silhouetteOf,
  soleOf,
  tidyEdges,
} from '../src/silhouette';
import { anchorIsAGuess, concernsOf } from '../src/concerns';
import { stamp, stroke } from '../src/brush';

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
