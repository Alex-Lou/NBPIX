/**
 * A coarse palette for a truecolor image (a stage drawn by hand in RGBA): the large regions the
 * flash measures need, told apart from the dithering. The game keeps the truecolor texture; this
 * palette only feeds `STAGE_COLORS` (docs/flashs.md §3).
 */

import type { Rgba } from './png.ts';

/** Median cut over the opaque pixels, each color weighted by the pixels it fills. */
export function quantizeRgba(
  pixels: Uint8ClampedArray,
  maxBoxes: number,
): { palette: Rgba[]; slots: Uint8Array } {
  const opaque: number[] = [];
  for (let at = 0; at < pixels.length; at += 4) {
    if ((pixels[at + 3] ?? 0) < 8) continue;
    opaque.push(((pixels[at] ?? 0) << 16) | ((pixels[at + 1] ?? 0) << 8) | (pixels[at + 2] ?? 0));
  }
  let boxes: number[][] = [opaque];
  const channel = (color: number, index: number) => (color >> (16 - index * 8)) & 0xff;
  while (boxes.length < maxBoxes) {
    let worst = -1;
    let worstRange = 0;
    let worstChannel = 0;
    for (const [index, box] of boxes.entries()) {
      if (box.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let min = 255;
        let max = 0;
        for (const color of box) {
          const value = channel(color, c);
          if (value < min) min = value;
          if (value > max) max = value;
        }
        const range = max - min;
        if (range > worstRange) {
          worstRange = range;
          worst = index;
          worstChannel = c;
        }
      }
    }
    if (worst < 0) break;
    const box = boxes[worst] ?? [];
    box.sort((a, b) => channel(a, worstChannel) - channel(b, worstChannel));
    const middle = Math.floor(box.length / 2);
    boxes = [
      ...boxes.filter((_, index) => index !== worst),
      box.slice(0, middle),
      box.slice(middle),
    ];
  }
  const palette: Rgba[] = [{ r: 0, g: 0, b: 0, a: 0 }];
  for (const box of boxes) {
    if (box.length === 0) continue;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const color of box) {
      r += channel(color, 0);
      g += channel(color, 1);
      b += channel(color, 2);
    }
    palette.push({
      r: Math.round(r / box.length),
      g: Math.round(g / box.length),
      b: Math.round(b / box.length),
      a: 255,
    });
  }
  const slots = new Uint8Array(pixels.length / 4);
  const cache = new Map<number, number>();
  for (let at = 0, pixel = 0; at < pixels.length; at += 4, pixel++) {
    if ((pixels[at + 3] ?? 0) < 8) continue;
    const color = ((pixels[at] ?? 0) << 16) | ((pixels[at + 1] ?? 0) << 8) | (pixels[at + 2] ?? 0);
    const known = cache.get(color);
    if (known !== undefined) {
      slots[pixel] = known;
      continue;
    }
    let best = 1;
    let bestDistance = Infinity;
    for (let slot = 1; slot < palette.length; slot++) {
      const entry = palette[slot] as Rgba;
      const distance =
        (entry.r - ((color >> 16) & 0xff)) ** 2 +
        (entry.g - ((color >> 8) & 0xff)) ** 2 +
        (entry.b - (color & 0xff)) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = slot;
      }
    }
    cache.set(color, best);
    slots[pixel] = best;
  }
  return { palette, slots };
}
