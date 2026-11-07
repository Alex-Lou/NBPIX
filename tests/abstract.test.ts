/**
 * L'abstraction en pixels (src/abstract.ts), jugée sur ce qu'on lui demande vraiment : des masses
 * plates, une palette tenue, et des formes fines qui survivent.
 *
 * Ces tests ne mesurent **pas** le ΔE. C'est voulu, et c'est tout le sujet : la chaîne d'origine a
 * été réglée pour minimiser l'écart de couleur avec la photo, ce qui produit une photo réduite.
 * Ici on vérifie l'inverse — que le résultat s'éloigne de la photo de la bonne manière.
 */

import { describe, expect, it } from 'vitest';
import { abstractToPixels } from '../src/abstract';
import type { Bitmap } from '../src/pixels';
import { bitmap } from '../src/pixels';

/** Une fausse photo : un corps en dégradé doux, et une lame d'1 px — le cas qui doit survivre. */
function fakePhoto(width: number, height: number): { image: Bitmap; on: Uint8Array } {
  const image = bitmap(width, height);
  const on = new Uint8Array(width * height);
  const cx = width / 2;
  const cy = height * 0.6;
  const radius = Math.min(width, height) * 0.3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const inBody = (x - cx) ** 2 + ((y - cy) * 1.3) ** 2 < radius * radius;
      // La lame : une colonne d'un pixel de large, bien plus claire que le corps.
      const inBlade = x === Math.round(cx) && y > height * 0.1 && y < cy - radius * 0.2;
      if (!inBody && !inBlade) continue;
      on[at] = 1;
      let r;
      let g;
      let b;
      if (inBlade) {
        [r, g, b] = [232, 236, 244];
      } else {
        // Un dégradé continu, comme une surface en ombre douce : ce qui casse en marches si on
        // se contente de réduire puis quantifier.
        const shade = 0.45 + 0.55 * (1 - (y - (cy - radius)) / (2 * radius));
        [r, g, b] = [Math.round(190 * shade), Math.round(110 * shade), Math.round(70 * shade)];
      }
      image.data[at * 4] = r;
      image.data[at * 4 + 1] = g;
      image.data[at * 4 + 2] = b;
      image.data[at * 4 + 3] = 255;
    }
  }
  return { image, on };
}

function boxOf(on: Uint8Array, width: number, height: number) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((on[y * width + x] ?? 0) === 0) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return { left, top, right, bottom };
}

/** Les couleurs opaques distinctes d'une image. */
function colorsOf(cell: Bitmap): Set<string> {
  const seen = new Set<string>();
  for (let at = 0; at < cell.width * cell.height; at++) {
    if ((cell.data[at * 4 + 3] ?? 0) === 0) continue;
    seen.add(`${cell.data[at * 4]},${cell.data[at * 4 + 1]},${cell.data[at * 4 + 2]}`);
  }
  return seen;
}

/** Les pixels qui ne partagent leur couleur avec aucun des 4 voisins : du bruit, pas du dessin. */
function lonelyIn(cell: Bitmap): number {
  const key = (x: number, y: number) => {
    const at = y * cell.width + x;
    if ((cell.data[at * 4 + 3] ?? 0) === 0) return 'vide';
    return `${cell.data[at * 4]},${cell.data[at * 4 + 1]},${cell.data[at * 4 + 2]}`;
  };
  let lonely = 0;
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      if (key(x, y) === 'vide') continue;
      const mine = key(x, y);
      let shared = false;
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cell.width || ny >= cell.height) continue;
        if (key(nx, ny) === mine) shared = true;
      }
      if (!shared) lonely++;
    }
  }
  return lonely;
}

describe('l’abstraction en pixels', () => {
  const W = 360;
  const H = 360;
  const { image, on } = fakePhoto(W, H);
  const box = boxOf(on, W, H);
  const options = { width: 48, height: 48, colors: 8, saturation: 1.1, detail: 5 } as const;

  it('ne dépasse jamais la palette qu’on lui donne', () => {
    for (const colors of [4, 8, 16]) {
      const made = abstractToPixels(image, on, box, { ...options, colors });
      expect(colorsOf(made.cell).size).toBeLessThanOrEqual(colors);
      expect(made.palette.length).toBeLessThanOrEqual(colors);
    }
  });

  it('rend exactement la même image deux fois', () => {
    // Pas de tirage aléatoire : c'est ce qui permet un replay doré et un test de non-régression.
    const once = abstractToPixels(image, on, box, options);
    const twice = abstractToPixels(image, on, box, options);
    expect(Array.from(twice.cell.data)).toEqual(Array.from(once.cell.data));
  });

  it('garde la lame d’un pixel', () => {
    // La raison d'être de l'outil : une épée fine ne doit pas disparaître dans la moyenne.
    const made = abstractToPixels(image, on, box, options);
    const column = Math.round((made.cell.width - 1) / 2);
    let blade = 0;
    for (let y = 0; y < made.cell.height; y++) {
      for (const x of [column - 1, column, column + 1]) {
        if (x < 0 || x >= made.cell.width) continue;
        const at = y * made.cell.width + x;
        if ((made.cell.data[at * 4 + 3] ?? 0) === 0) continue;
        // La lame est bien plus claire que le corps : on la reconnaît à ça.
        if ((made.cell.data[at * 4] ?? 0) > 200 && (made.cell.data[at * 4 + 2] ?? 0) > 180) blade++;
      }
    }
    expect(blade).toBeGreaterThan(5);
  });

  it('rend des masses, pas du bruit', () => {
    const made = abstractToPixels(image, on, box, options);
    const drawn = made.cell.data.filter((_, i) => i % 4 === 3 && made.cell.data[i] !== 0).length;
    // Presque aucun pixel ne doit être seul de sa couleur : c'est ce qui distingue un aplat d'une
    // photo réduite, où chaque pixel diffère un peu de son voisin.
    expect(lonelyIn(made.cell) / Math.max(1, drawn)).toBeLessThan(0.1);
  });

  it('sature la palette comme le fait un pixel artist', () => {
    const plain = abstractToPixels(image, on, box, { ...options, saturation: 1 });
    const punchy = abstractToPixels(image, on, box, { ...options, saturation: 1.25 });
    const spread = (cell: Bitmap) => {
      let sum = 0;
      let count = 0;
      for (let at = 0; at < cell.width * cell.height; at++) {
        if ((cell.data[at * 4 + 3] ?? 0) === 0) continue;
        const r = cell.data[at * 4] ?? 0;
        const g = cell.data[at * 4 + 1] ?? 0;
        const b = cell.data[at * 4 + 2] ?? 0;
        sum += Math.max(r, g, b) - Math.min(r, g, b);
        count++;
      }
      return count === 0 ? 0 : sum / count;
    };
    expect(spread(punchy.cell)).toBeGreaterThan(spread(plain.cell));
  });
});
