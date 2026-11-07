import { describe, expect, it } from 'vitest';
import { standing, found, drawnBox } from './support';
import { CELL_SIZE, PORTRAIT_SIZE } from '../src/game/contract';
import { bitmap } from '../src/pixels';
import { PIXELIZE_DEFAULTS, pixelize } from '../src/pixelize';
import { placeOnCell, PLACEMENT_DEFAULTS } from '../src/place';
import { atFinesse, fighterFormat, PORTRAIT } from '../src/format';
import { pipelineProblems } from '../src/rules';
import { GAME_BOY, MEGA_DRIVE, NES, STYLES } from '../src/style';

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
