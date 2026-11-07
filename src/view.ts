/**
 * What the two canvases show. Given what to draw, it draws it: no state of its own, nothing read
 * from anywhere else. The guides are the point of having a page at all — a silhouette and an
 * anchor are judged by eye, not by a number.
 */

import { ANCHOR, CELL_SIZE } from './game/contract.ts';
import type { Bitmap } from './pixels.ts';
import type { Frame } from './place.ts';
import type { Mask, Paint } from './silhouette.ts';
import { soleOf } from './silhouette.ts';

export function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser gives no 2D canvas');
  return context;
}

/** A bitmap on a canvas of its own size: what both the zoomed view and the export need. */
export function canvasOf(bitmap: Bitmap): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = contextOf(canvas);
  const image = context.createImageData(bitmap.width, bitmap.height);
  image.data.set(bitmap.data);
  context.putImageData(image, 0, 0);
  return canvas;
}

/** The imported image with the background pushed back, so the silhouette is plain to see. */
export function drawSource(
  canvas: HTMLCanvasElement,
  image: Bitmap,
  mask: Mask,
  paint: Paint | undefined,
): void {
  canvas.width = image.width;
  canvas.height = image.height;
  const context = contextOf(canvas);
  const shown = context.createImageData(image.width, image.height);
  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    const at = pixel * 4;
    const subject = (mask.on[pixel] ?? 0) === 1;
    const red = image.data[at] ?? 0;
    const green = image.data[at + 1] ?? 0;
    const blue = image.data[at + 2] ?? 0;
    shown.data[at] = subject ? red : Math.round(red * 0.25 + 40);
    shown.data[at + 1] = subject ? green : Math.round(green * 0.25);
    shown.data[at + 2] = subject ? blue : Math.round(blue * 0.25 + 30);
    shown.data[at + 3] = 255;
    // What the hand laid down, tinted so a stroke is visible over the picture it corrects.
    const said = paint?.[pixel] ?? 0;
    if (said > 0) {
      shown.data[at + 1] = Math.min(255, (shown.data[at + 1] ?? 0) + 60);
    } else if (said < 0) {
      shown.data[at] = Math.min(255, (shown.data[at] ?? 0) + 70);
      shown.data[at + 2] = Math.min(255, (shown.data[at + 2] ?? 0) + 40);
    }
  }
  context.putImageData(shown, 0, 0);
  const sole = soleOf(mask);
  context.lineWidth = Math.max(1, Math.round(image.width / 400));
  context.strokeStyle = '#3bd16f';
  context.strokeRect(
    mask.box.left,
    mask.box.top,
    mask.box.right - mask.box.left + 1,
    mask.box.bottom - mask.box.top + 1,
  );
  context.strokeStyle = '#ffb020';
  context.beginPath();
  context.moveTo(mask.box.left, sole.y + 1);
  context.lineTo(mask.box.right + 1, sole.y + 1);
  context.moveTo(sole.x, mask.box.top);
  context.lineTo(sole.x, sole.y + 1);
  context.stroke();
}

const DASH: readonly number[] = [3, 5];
const FAINT = 'rgba(255, 176, 32, 0.45)';
const MARK = '#ffb020';

/** The cell, on a checkerboard so transparency reads, with the guides its frame is judged by. */
export function drawCell(
  canvas: HTMLCanvasElement,
  cell: Bitmap,
  shown: { readonly zoom: number; readonly frame: Frame; readonly guides: boolean },
): void {
  const { zoom } = shown;
  canvas.width = cell.width * zoom;
  canvas.height = cell.height * zoom;
  const context = contextOf(canvas);
  const square = 8 * zoom;
  for (let y = 0; y < canvas.height; y += square) {
    for (let x = 0; x < canvas.width; x += square) {
      context.fillStyle = (x / square + y / square) % 2 === 0 ? '#15151c' : '#1c1c25';
      context.fillRect(x, y, square, square);
    }
  }
  context.imageSmoothingEnabled = false;
  context.drawImage(canvasOf(cell), 0, 0, canvas.width, canvas.height);
  if (!shown.guides) return;
  context.lineWidth = 1;
  if (shown.frame === 'portrait') {
    // The game's own framing: the head's middle at 45 % of the square, its crown near a sixth
    // down (tools/sprites/aseprite-template.ts). Lines to aim at, nothing the tool enforces.
    across(context, (cell.width / 2) * zoom, undefined, canvas);
    for (const share of [0.06, 0.45])
      across(context, undefined, cell.height * share * zoom, canvas);
    return;
  }
  const unit = cell.width / CELL_SIZE;
  const x = (ANCHOR.x * unit + 0.5) * zoom;
  const y = (ANCHOR.y * unit + 0.5) * zoom;
  across(context, x, undefined, canvas);
  across(context, undefined, y, canvas);
  // Solid only at the anchor itself: the lines have to be readable over a pale sprite without
  // hiding the pixels they are there to check.
  context.strokeStyle = MARK;
  const arm = 6 * zoom;
  context.beginPath();
  context.moveTo(x, y - arm);
  context.lineTo(x, y + arm);
  context.moveTo(x - arm, y);
  context.lineTo(x + arm, y);
  context.stroke();
}

/** One dashed guide, down the whole canvas or across it. */
function across(
  context: CanvasRenderingContext2D,
  x: number | undefined,
  y: number | undefined,
  canvas: HTMLCanvasElement,
): void {
  context.strokeStyle = FAINT;
  context.setLineDash([...DASH]);
  context.beginPath();
  if (x === undefined) {
    context.moveTo(0, y ?? 0);
    context.lineTo(canvas.width, y ?? 0);
  } else {
    context.moveTo(x, 0);
    context.lineTo(x, canvas.height);
  }
  context.stroke();
  context.setLineDash([]);
}
