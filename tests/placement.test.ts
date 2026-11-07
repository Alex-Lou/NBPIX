import { describe, expect, it } from 'vitest';
import { scene, SUBJECT, WALL, standing, found, drawnBox } from './support';
import {
  ANCHOR,
  CELL_MARGIN,
  CELL_SIZE,
  LOWEST_ROW,
  PORTRAIT_SIZE,
  STANDING_HEIGHT,
} from '../src/game/contract';
import type { Bitmap } from '../src/pixels';
import { PIXELIZE_DEFAULTS, pixelize } from '../src/pixelize';
import { placeOnCell, PLACEMENT_DEFAULTS, PORTRAIT_DEFAULTS } from '../src/place';
import { atFinesse, boxFormat, fighterFormat, fittingHeight, FORMATS } from '../src/format';
import { crownOf, soleOf } from '../src/silhouette';
import { concernsOf } from '../src/concerns';
import { pipelineProblems, rulesOf } from '../src/rules';

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
