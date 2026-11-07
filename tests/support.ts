/** Les décors et les mesures que plusieurs fichiers de test partagent. */

import { toLab } from '../src/game/lab';
import type { Bitmap } from '../src/pixels';
import { bitmap } from '../src/pixels';
import { SILHOUETTE_DEFAULTS, silhouetteOf } from '../src/silhouette';

/** A flat background with shapes painted on it, the way a studio photo looks to the tool. */
export function scene(
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

export const SUBJECT = [30, 40, 60] as const;
export const WALL = [200, 196, 190] as const;

/** A 20 × 50 subject standing in a 100 × 80 frame, its feet on row 59. */
export function standing(): Bitmap {
  return scene(100, 80, WALL, (set) => {
    for (let y = 10; y <= 59; y++) for (let x = 20; x <= 39; x++) set(x, y, SUBJECT);
  });
}

export function found(image: Bitmap) {
  return silhouetteOf(image, SILHOUETTE_DEFAULTS, toLab);
}

/** The rows and columns a placed cell actually draws on. */
export function drawnBox(cell: Bitmap) {
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
