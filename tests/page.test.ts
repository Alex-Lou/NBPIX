import { describe, expect, it } from 'vitest';
import { bitmap } from '../src/pixels';
import { refine } from '../src/silhouette';
import type { Concern } from '../src/concerns';
import { listOf, sentenceOf } from '../src/words';
import { inputOf, maskOf } from '../src/segment';
import { CELL_TARGET, fitZoom, maxZoom } from '../src/view';

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
