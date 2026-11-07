/** Minimal PNG codec for palette and truecolor images: no dependency, deflate from the platform. */

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const COLOR_TYPE_INDEXED = 3;
const COLOR_TYPE_RGB = 2;
const COLOR_TYPE_RGBA = 6;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encodes `pixels` (one palette index per pixel, row by row) as an indexed PNG, each pixel
 * enlarged `scale` times (1 for game assets, more for previews).
 */
export async function encodeIndexedPng(
  width: number,
  height: number,
  pixels: Uint8Array,
  palette: readonly Rgba[],
  scale = 1,
): Promise<Uint8Array> {
  if (pixels.length !== width * height) throw new RangeError('pixels must be width * height');
  if (palette.length > 256) throw new RangeError('a PNG palette holds 256 colors at most');

  const outWidth = width * scale;
  const outHeight = height * scale;
  const raw = new Uint8Array((outWidth + 1) * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const row = y * (outWidth + 1);
    raw[row] = 0; // filter: none
    const sourceRow = Math.floor(y / scale) * width;
    for (let x = 0; x < outWidth; x++) {
      raw[row + 1 + x] = pixels[sourceRow + Math.floor(x / scale)] ?? 0;
    }
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, outWidth);
  view.setUint32(4, outHeight);
  header.set([8, COLOR_TYPE_INDEXED, 0, 0, 0], 8);

  return concat([
    new Uint8Array(SIGNATURE),
    chunk('IHDR', header),
    chunk('PLTE', new Uint8Array(palette.flatMap(({ r, g, b }) => [r, g, b]))),
    chunk('tRNS', new Uint8Array(palette.map(({ a }) => a))),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * Encodes `data` (RGBA bytes, row by row) as an 8-bit truecolor PNG (color type 6), unfiltered:
 * the format a stage that keeps every color of its illustration uses (Sakura).
 */
export async function encodeTruecolorPng(
  width: number,
  height: number,
  data: Uint8ClampedArray | Uint8Array,
): Promise<Uint8Array> {
  if (data.length !== width * height * 4) throw new RangeError('data must be width * height * 4');
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter: none
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), row + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, COLOR_TYPE_RGBA, 0, 0, 0], 8);
  return concat([
    new Uint8Array(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeAndData = concat([new TextEncoder().encode(type), data]);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeAndData, 4);
  view.setUint32(8 + data.length, crc32(typeAndData));
  return out;
}

/** An indexed PNG as read back: one palette index per pixel, and the palette's opacity. */
export interface IndexedImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  /** Alpha of each palette slot (opaque when the file has no transparency). */
  readonly alpha: readonly number[];
  /** Color of each palette slot, 0xRRGGBB. */
  readonly colors: readonly number[];
}

/**
 * Decodes an 8-bit indexed PNG, the kind `encodeIndexedPng` writes (the game's strips) or an
 * image editor saves (filtered rows, the strips drawn in Aseprite): enough for the tools that
 * read what the strips draw, not a general decoder.
 */
export async function decodeIndexedPng(png: Uint8Array): Promise<IndexedImage> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let alpha: number[] = [];
  let colors: number[] = [];
  const data: Uint8Array[] = [];
  for (let offset = SIGNATURE.length; offset < png.length;) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (body[8] !== 8 || body[9] !== COLOR_TYPE_INDEXED) {
        throw new Error('Only 8-bit indexed PNGs are supported');
      }
      if (body[12] !== 0) throw new Error('Interlaced PNGs are not supported');
    } else if (type === 'PLTE') {
      alpha = Array.from({ length: length / 3 }, () => 255);
      colors = Array.from(
        { length: length / 3 },
        (_, slot) =>
          ((body[slot * 3] ?? 0) << 16) |
          ((body[slot * 3 + 1] ?? 0) << 8) |
          (body[slot * 3 + 2] ?? 0),
      );
    } else if (type === 'tRNS') {
      body.forEach((value, slot) => (alpha[slot] = value));
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += 12 + length;
  }
  const raw = await inflate(concat(data));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    unfilterLine(
      raw[row] ?? 0,
      raw.subarray(row + 1, row + 1 + width),
      pixels.subarray(y * width, (y + 1) * width),
      y > 0 ? pixels.subarray((y - 1) * width, y * width) : undefined,
      1,
    );
  }
  return { width, height, pixels, alpha, colors };
}

/** A truecolor PNG as read back: RGBA bytes, row by row. */
export interface TruecolorImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/**
 * Decodes an 8-bit truecolor PNG (RGB or RGBA, no interlace), the kind a stage drawn with every
 * color of its illustration is saved as. Rows are unfiltered with their color's bytes a pixel.
 */
export async function decodeTruecolorPng(png: Uint8Array): Promise<TruecolorImage> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Uint8Array[] = [];
  for (let offset = SIGNATURE.length; offset < png.length;) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (body[8] !== 8 || (body[9] !== COLOR_TYPE_RGBA && body[9] !== COLOR_TYPE_RGB)) {
        throw new Error('Only 8-bit RGB and RGBA truecolor PNGs are supported');
      }
      channels = body[9] === COLOR_TYPE_RGBA ? 4 : 3;
      if (body[12] !== 0) throw new Error('Interlaced PNGs are not supported');
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += 12 + length;
  }
  const raw = await inflate(concat(data));
  const sourceStride = width * channels;
  const source = new Uint8Array(sourceStride * height);
  for (let y = 0; y < height; y++) {
    const row = y * (sourceStride + 1);
    unfilterLine(
      raw[row] ?? 0,
      raw.subarray(row + 1, row + 1 + sourceStride),
      source.subarray(y * sourceStride, (y + 1) * sourceStride),
      y > 0 ? source.subarray((y - 1) * sourceStride, y * sourceStride) : undefined,
      channels,
    );
  }
  if (channels === 4) return { width, height, data: new Uint8ClampedArray(source) };
  const pixels = new Uint8Array(width * height * 4);
  for (let at = 0, out = 0; at < source.length; at += 3, out += 4) {
    pixels[out] = source[at] ?? 0;
    pixels[out + 1] = source[at + 1] ?? 0;
    pixels[out + 2] = source[at + 2] ?? 0;
    pixels[out + 3] = 255;
  }
  return { width, height, data: new Uint8ClampedArray(pixels) };
}

/**
 * One row of `bpp` bytes a pixel, its PNG filter undone: each byte was stored as the difference
 * with a guess made from its left, upper and upper-left neighbours (`above` undefined on the
 * first row, all zeros).
 */
function unfilterLine(
  filter: number,
  line: Uint8Array,
  out: Uint8Array,
  above: Uint8Array | undefined,
  bpp: number,
): void {
  for (let x = 0; x < line.length; x++) {
    const left = x >= bpp ? (out[x - bpp] ?? 0) : 0;
    const up = above?.[x] ?? 0;
    const upLeft = x >= bpp ? (above?.[x - bpp] ?? 0) : 0;
    let guess: number;
    if (filter === 0) guess = 0;
    else if (filter === 1) guess = left;
    else if (filter === 2) guess = up;
    else if (filter === 3) guess = Math.floor((left + up) / 2);
    else if (filter === 4) guess = paeth(left, up, upLeft);
    else throw new Error(`Unknown PNG filter ${String(filter)}`);
    out[x] = ((line[x] ?? 0) + guess) & 0xff;
  }
}

/** The neighbour closest to `left + up - upLeft` (PNG filter 4). */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** zlib stream (what PNG expects), compressed by the runtime. */
async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
