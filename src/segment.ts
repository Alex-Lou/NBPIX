/**
 * The subject found by a model instead of by colour (docs/methode.md §2.2).
 *
 * The colour key cannot separate lit skin from a lit wall: they are the same colour and they touch,
 * so there is no step to find and no setting that finds one. A segmentation model does not look at
 * colour steps, it looks at what a person is shaped like. Measured on the selfie that broke the
 * key: the hole in the chest closes completely, in 224 ms.
 *
 * **U²-Net small** (`u2netp`), 4.6 MB, Apache-2.0 — Qin et al., *U²-Net: Going Deeper with Nested
 * U-Structure for Salient Object Detection*. The weights are not in the repository: `npm run
 * model` fetches them (src/model.ts), and `npm run dev` does it for you. Without them
 * the page simply keeps the colour key and says so.
 *
 * The runtime is loaded only when the model is asked for: it is some 15 MB of WebAssembly, and a
 * page that keys by colour has no reason to pay for it.
 */

import type { Bitmap } from './pixels.ts';

/** What the model was trained on: 320 px square, ImageNet's mean and deviation. */
const SIDE = 320;
const MEAN = [0.485, 0.456, 0.406] as const;
const DEVIATION = [0.229, 0.224, 0.225] as const;

/** Where `npm run model` puts the weights, as the page asks for them. */
export const MODEL_URL = 'model/u2netp.onnx';

/**
 * The image as the model wants it: three planes of 320 × 320, each channel centred and scaled.
 * Nearest sampling, because the model's own input is far coarser than any resampling artefact.
 */
export function inputOf(image: Bitmap): Float32Array {
  const input = new Float32Array(3 * SIDE * SIDE);
  for (let y = 0; y < SIDE; y++) {
    const sy = Math.min(image.height - 1, Math.floor((y * image.height) / SIDE));
    for (let x = 0; x < SIDE; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x * image.width) / SIDE));
      const at = (sy * image.width + sx) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const value = (image.data[at + channel] ?? 0) / 255;
        input[channel * SIDE * SIDE + y * SIDE + x] =
          (value - (MEAN[channel] ?? 0)) / (DEVIATION[channel] ?? 1);
      }
    }
  }
  return input;
}

/**
 * The model's map turned into a mask at the image's size. The map is stretched to 0..1 first,
 * because the model answers in confidences whose range moves from picture to picture; `floor` is
 * then the share of confidence a pixel needs to count as subject.
 */
export function maskOf(
  map: ArrayLike<number>,
  image: Bitmap,
  floor: number,
  into?: Uint8Array,
): Uint8Array {
  let low = Infinity;
  let high = -Infinity;
  for (let index = 0; index < map.length; index++) {
    const value = map[index] ?? 0;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const spread = high - low;
  const count = image.width * image.height;
  const on = into?.length === count ? into : new Uint8Array(count);
  for (let y = 0; y < image.height; y++) {
    const my = Math.min(SIDE - 1, Math.floor((y * SIDE) / image.height));
    for (let x = 0; x < image.width; x++) {
      const mx = Math.min(SIDE - 1, Math.floor((x * SIDE) / image.width));
      const value = spread <= 0 ? 0 : ((map[my * SIDE + mx] ?? 0) - low) / spread;
      on[y * image.width + x] = value > floor ? 1 : 0;
    }
  }
  return on;
}

/** The runtime and the session, loaded once and kept: both are expensive and neither changes. */
let session: Promise<{ run: (input: Float32Array) => Promise<ArrayLike<number>> }> | undefined;

async function sessionOf(): Promise<{
  run: (input: Float32Array) => Promise<ArrayLike<number>>;
}> {
  // The wasm-only build: the page has no use for WebGL or WebGPU, and they cost megabytes.
  const ort = await import('onnxruntime-web/wasm');
  // Everything in one folder beside the weights, served by Vite: no CDN, and it works offline.
  // Absolute, from the page: a relative path is resolved against the module's own URL, which is
  // wherever the bundler happened to put it, not where the files are.
  ort.env.wasm.wasmPaths = new URL('model/', document.baseURI).href;
  // One thread: several would need the page to be cross-origin isolated, which a dev server is
  // not. A still picture is run once per image, so the wait is paid once and barely noticed.
  ort.env.wasm.numThreads = 1;
  const loaded = await ort.InferenceSession.create(MODEL_URL);
  const inputName = loaded.inputNames[0] ?? 'input.1';
  const outputName = loaded.outputNames[0] ?? 'output';
  return {
    run: async (input: Float32Array) => {
      const output = await loaded.run({
        [inputName]: new ort.Tensor('float32', input, [1, 3, SIDE, SIDE]),
      });
      const map = output[outputName]?.data;
      if (!map) throw new Error(`${outputName} is missing from what the model answered`);
      return map as ArrayLike<number>;
    },
  };
}

/** Whether the weights are there. The page asks before offering the model at all. */
export async function modelIsThere(): Promise<boolean> {
  try {
    const answer = await fetch(MODEL_URL, { method: 'HEAD' });
    return answer.ok;
  } catch {
    return false;
  }
}

/** The subject of `image`, as the model sees it. */
export async function segment(
  image: Bitmap,
  floor: number,
  into?: Uint8Array,
): Promise<Uint8Array> {
  session ??= sessionOf();
  try {
    return maskOf(await (await session).run(inputOf(image)), image, floor, into);
  } catch (error) {
    // A failed load must not poison every later try: the next one starts a fresh session.
    session = undefined;
    throw error;
  }
}
