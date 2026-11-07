/**
 * The pixels the rotoscope tool works on (docs/art/roto.md): RGBA, four bytes a pixel, row by
 * row — the shape a browser's `ImageData` already holds, so a canvas's pixels pass straight into
 * every step of the chain. No DOM and no engine here: each step is a pure function, so the page
 * is only wiring and the maths is tested without a browser (tests/tools/roto.test.ts).
 */

/** An image, as `ImageData` holds one. */
export interface Bitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** A transparent image of that size. */
export function bitmap(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** A copy, so a step never writes over what the page still shows. */
export function copyOf(image: Bitmap): Bitmap {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
}

/**
 * sRGB byte to linear light. Colours are averaged in linear light, which is what keeps a
 * downscale from darkening (docs/art/manifeste-pixel-art.md §2, the area resampling step). A
 * table, because the chain reads it millions of times.
 */
const LINEAR = Float64Array.from({ length: 256 }, (_, byte) => {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});

export function linearOf(byte: number): number {
  return LINEAR[byte] ?? 0;
}

/**
 * Linear light back to an sRGB byte. tools/stage/kit/unify.ts keeps its own pair of these for the
 * stages' palettes; two copies of eight lines cost less than a shared colour module that neither
 * side asked for. A third copy is the moment to move them out.
 */
export function byteOf(light: number): number {
  const value = light <= 0.0031308 ? light * 12.92 : 1.055 * light ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

/** The box a mask fills; `right` and `bottom` are inside it. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export function widthOf(box: Box): number {
  return box.right - box.left + 1;
}

export function heightOf(box: Box): number {
  return box.bottom - box.top + 1;
}

/**
 * Every pixel's colour in Lab, three numbers a pixel: the silhouette keys on colour distance, and
 * the page keys again on every move of the tolerance slider, so the conversion is done once per
 * imported image and handed to the steps that need it.
 */
export function labBufferOf(image: Bitmap, toLab: ToLab): Float32Array {
  const lab = new Float32Array(image.width * image.height * 3);
  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    const at = pixel * 4;
    const [l, a, b] = toLab(image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0);
    lab[pixel * 3] = l;
    lab[pixel * 3 + 1] = a;
    lab[pixel * 3 + 2] = b;
  }
  return lab;
}

export type ToLab = (r: number, g: number, b: number) => [number, number, number];

/** The distance between two colours of a Lab buffer, squared (the square root is never needed). */
export function labDistanceSquared(lab: Float32Array, one: number, other: number): number {
  const dl = (lab[one * 3] ?? 0) - (lab[other * 3] ?? 0);
  const da = (lab[one * 3 + 1] ?? 0) - (lab[other * 3 + 1] ?? 0);
  const db = (lab[one * 3 + 2] ?? 0) - (lab[other * 3 + 2] ?? 0);
  return dl * dl + da * da + db * db;
}
