/**
 * The page of the rotoscope tool (docs/methode.md): `npm run dev`. State and wiring, nothing
 * else — the maths is in the pure steps (silhouette, place, pixelize, brush), the widgets in
 * controls.ts, the drawing in view.ts, the French in words.ts.
 *
 * Every number the steps need is a control here, because they are all empirical: the right
 * tolerance depends on the photo, the right height on the pose. Seeing the silhouette and the
 * anchor is the point of having a page at all.
 */

import type { Format } from './format.ts';
import { atFinesse, fittingHeight } from './format.ts';
import { STYLES } from './style.ts';
import { toLab } from './game/lab.ts';
import type { Sheet } from './brush.ts';
import { stamp, stroke } from './brush.ts';
import { anchorIsAGuess, concernsOf } from './concerns.ts';
import { controlsOn } from './controls.ts';
import type { Bitmap } from './pixels.ts';
import { labBufferOf } from './pixels.ts';
import type { Placed } from './place.ts';
import { PLACEMENT_DEFAULTS, placeOnCell } from './place.ts';
import type { Pixelized } from './pixelize.ts';
import { pixelize } from './pixelize.ts';
import { pipelineProblems } from './rules.ts';
import { modelIsThere, segment } from './segment.ts';
import type { Mask } from './silhouette.ts';
import { painted, refine, SILHOUETTE_DEFAULTS, silhouetteOf, soleOf } from './silhouette.ts';
import { canvasOf, drawCell, drawSource, fitZoom } from './view.ts';
import { sentenceOf } from './words.ts';
import { panelOn } from './panel.ts';
import type { Work } from './page-state.ts';
import { state, WORK_MAX } from './page-state.ts';

let work: Work | undefined;
/**
 * The automatic mask, kept until a silhouette setting changes. A stroke only lays the override
 * over it, so painting stays smooth instead of redoing a flood fill per pointer move.
 */
let automatic: { readonly key: string; readonly mask: Mask } | undefined;
/** What the model saw, before any cleaning: computed once per image and threshold. */
let seen: { readonly floor: number; readonly on: Uint8Array } | undefined;
/** True while the model is thinking, so the page says so instead of looking stuck. */
let thinking = false;
let made: Pixelized | undefined;
/** The format as it was really drawn, finesse included: what the page reports and checks. */
let shownFormat: Format = PLACEMENT_DEFAULTS.format;
/** The mask of the last pass, so « remplir » knows how big the subject is. */
let mask: Mask | undefined;

// The page -------------------------------------------------------------------------------------

function must(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing from the page`);
  return element;
}

const drop = must('drop');
const file = must('file') as HTMLInputElement;
const sourceView = must('source-view');
const cellView = must('cell-view');
const sourceCanvas = must('source') as HTMLCanvasElement;
const cellCanvas = must('cell') as HTMLCanvasElement;
const sourceInfo = must('source-info');
const cellInfo = must('cell-info');
const cellLabel = must('cell-label');
const status = must('status');
const about = must('about');

/**
 * La place qu'a vraiment la case, en pixels d'écran : la largeur de sa figure, moins ce que le CSS
 * lui prend. Lue plutôt que devinée, pour que cette marge reste définie au seul endroit qui la
 * décide (index.html).
 */
function roomForCell(): number {
  const style = window.getComputedStyle(cellView);
  return (
    cellView.clientWidth -
    Number.parseFloat(style.paddingLeft) -
    Number.parseFloat(style.paddingRight)
  );
}

/**
 * Redimensionner la fenêtre change la place, donc le bon zoom. Oublier la taille pour laquelle il
 * avait été choisi suffit : la passe suivante le recalcule. Un zoom posé à la main est perdu, et
 * c'est voulu — il valait pour une largeur qui n'est plus celle-là.
 */
let resizing = 0;
window.addEventListener('resize', () => {
  window.clearTimeout(resizing);
  resizing = window.setTimeout(() => {
    state.zoomedFor = undefined;
    schedule();
  }, 200);
});

// Controls -------------------------------------------------------------------------------------

let pending = 0;

/** Redo the chain, once the hand has stopped moving for a moment. */
function schedule(): void {
  if (!work) return;
  window.clearTimeout(pending);
  pending = window.setTimeout(run, 60);
}

const ui = controlsOn(schedule);

const clear = ui.button('Effacer les retouches', () => {
  work?.paint.fill(0);
  clear.disabled = true;
  schedule();
});
clear.disabled = true;

const fitButton = ui.button('Remplir le format', fill);

const save = ui.button('Enregistrer la case (PNG)', exportCell);
save.disabled = true;

/**
 * The model is offered only once its weights are there: without them the page keeps the colour
 * key and says what to run, rather than failing when the choice is made.
 */
let modelReady = false;
void modelIsThere().then((there) => {
  modelReady = there;
  if (!there) note('warn', '⚠ Modèle absent : lance « npm run model » pour l’activer.');
});

function chooseSource(value: number): void {
  if (value === 1 && !modelReady) {
    state.source = 'key';
    note('warn', '⚠ Modèle absent : lance « npm run model » pour l’activer.');
    return;
  }
  state.source = value === 1 ? 'model' : 'key';
}

/**
 * Choisir un style pose tout : la boîte, le nombre de couleurs, la palette de la machine. C'est le
 * seul choix nécessaire pour obtenir quelque chose — le reste est là pour affiner, pas pour
 * démarrer.
 */
function chooseStyle(index: number): void {
  const picked = STYLES[index];
  if (!picked) return;
  state.style = picked;
  state.format = picked.format;
  state.height = picked.format.height0;
  state.colors = picked.colors;
  state.dither = picked.dither;
  state.nudgeX = 0;
  state.nudgeY = 0;
  about.textContent = picked.about;
  // Un objet se cadre en le faisant tenir : c'est le geste normal, autant le faire d'office.
  if (picked.format.pin.kind === 'box') fitSoon = true;
}

/** Remplir le format demande de connaître le sujet, qui n'est mesuré qu'après la passe suivante. */
let fitSoon = false;

/** The height that makes the subject fill its format, margins kept. */
function fill(): void {
  const box = mask?.box;
  if (!box) return;
  state.height = fittingHeight(state.format, {
    width: box.right - box.left + 1,
    height: box.bottom - box.top + 1,
  });
  schedule();
}

about.textContent = state.style.about;
must('controls').append(
  ...panelOn(ui, { about, clear, fit: fitButton, save, chooseStyle, chooseSource }),
);

// The chain --------------------------------------------------------------------------------------

function run(): void {
  const loaded = work;
  if (!loaded) return;
  const options = {
    tolerance: state.tolerance,
    alphaFloor: SILHOUETTE_DEFAULTS.alphaFloor,
    minShare: state.minShare,
    tidy: state.tidy,
    corners: state.corners,
  };
  const key = JSON.stringify({ ...options, source: state.source, floor: state.floor });
  if (automatic?.key !== key) {
    if (state.source === 'model') {
      if (seen?.floor !== state.floor) {
        think(loaded);
        return;
      }
      // `refine` writes over what it is given, so the model's own answer is kept untouched.
      loaded.cleaned.set(seen.on);
      automatic = {
        key,
        mask: refine(loaded.image.width, loaded.image.height, loaded.cleaned, options, {
          from: 'model',
          seeds: 0,
          dropped: 0,
        }),
      };
    } else {
      automatic = { key, mask: silhouetteOf(loaded.image, options, toLab, loaded.lab) };
    }
  }
  mask = painted(automatic.mask, loaded.paint, loaded.canvas);
  loaded.sample = sampleOf(loaded.image, mask);
  const format = atFinesse(state.format, state.finesse);
  const placed = placeOnCell(
    loaded.image,
    mask,
    {
      format,
      height: Math.round(state.height * state.finesse),
      flip: state.flip,
      nudgeX: Math.round(state.nudgeX * state.finesse),
      nudgeY: Math.round(state.nudgeY * state.finesse),
      edge: state.edge,
    },
    loaded.lab,
  );
  shownFormat = format;
  made = pixelize(placed.cell, placed.on, {
    kuwahara: state.kuwahara,
    sharpen: state.sharpen,
    saturation: state.saturation,
    outline: state.outline,
    colors: state.colors,
    orphans: state.orphans,
    method: state.method,
    dither: state.dither,
    // Les couleurs de la source, pour y choisir la palette plutôt que sur l'image déjà réduite.
    from: loaded.sample,
    ...(state.style.master ? { master: state.style.master } : {}),
  });
  if (fitSoon) {
    fitSoon = false;
    fill();
    return;
  }
  save.disabled = false;
  // Avant toute mesure : une figure cachée n'a pas de largeur.
  sourceView.hidden = false;
  cellView.hidden = false;
  // Le zoom suit la taille de la case — ×28 pour 16 px, ×1 pour 512 — et n'est recalculé que quand
  // cette taille change, pour laisser la main au curseur entre deux changements de style.
  if (state.zoomedFor !== made.cell.width) {
    state.zoomedFor = made.cell.width;
    state.zoom = fitZoom(made.cell.width, roomForCell());
  }
  ui.refresh();
  drawSource(sourceCanvas, loaded.image, mask, loaded.paint);
  drawCell(cellCanvas, made.cell, { zoom: state.zoom, format, guides: state.guides });
  report(loaded.image, mask, placed, made);
}

/** Ask the model what it sees, then come back and finish the pass. */
function think(loaded: Work): void {
  if (thinking) return;
  thinking = true;
  status.textContent = 'Le modèle regarde l’image…';
  segment(loaded.image, state.floor)
    .then((on) => {
      seen = { floor: state.floor, on };
    })
    .catch((error: unknown) => {
      state.source = 'key';
      seen = undefined;
      status.textContent = `Le modèle n’a pas pu tourner : ${String(error)}`;
    })
    .finally(() => {
      thinking = false;
      ui.refresh();
      if (state.source === 'model') run();
    });
}

/** Au plus ce nombre de couleurs du sujet : de quoi apprendre une palette sans y passer la nuit. */
const SAMPLE = 24_000;

/** Les couleurs du sujet, prises sur la source à pas régulier. */
function sampleOf(image: Bitmap, found: Mask): Uint8ClampedArray {
  const total = found.pixels;
  if (total === 0) return new Uint8ClampedArray(0);
  const stride = Math.max(1, Math.floor(total / SAMPLE));
  const taken = new Uint8ClampedArray(Math.ceil(total / stride) * 4);
  let seen = 0;
  let kept = 0;
  for (let pixel = 0; pixel < found.on.length; pixel++) {
    if ((found.on[pixel] ?? 0) === 0) continue;
    if (seen++ % stride !== 0) continue;
    if (kept * 4 + 3 >= taken.length) break;
    taken[kept * 4] = image.data[pixel * 4] ?? 0;
    taken[kept * 4 + 1] = image.data[pixel * 4 + 1] ?? 0;
    taken[kept * 4 + 2] = image.data[pixel * 4 + 2] ?? 0;
    taken[kept * 4 + 3] = 255;
    kept++;
  }
  return taken.subarray(0, kept * 4);
}

// What the page says -----------------------------------------------------------------------------

function note(kind: string, text: string): void {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = text;
  status.append(line);
}

function report(image: Bitmap, found: Mask, placed: Placed, pixels: Pixelized): void {
  const sole = soleOf(found);
  const { pin } = shownFormat;
  const concerns = concernsOf(found, sole, placed.overflow, pin.kind);
  const guessed = pin.kind === 'feet' && anchorIsAGuess(concerns);
  const height = found.box.bottom - found.box.top + 1;
  const scaled = `${height} px de source → ${state.height} px de format (×${placed.scale.toFixed(3)})`;
  /** What this format does with the subject, said plainly. */
  const posed =
    pin.kind === 'feet'
      ? guessed
        ? 'base posée sur l’ancre — mais voir ci-dessous, ce ne sont pas des pieds.'
        : `pieds posés sur l’ancre ${pin.column}, ${pin.row}, base large de ${sole.width} px.`
      : pin.kind === 'crown'
        ? `tête centrée, couronne à ${Math.round(pin.air * 100)} % du haut. Les épaules sortent par le bas, c’est voulu.`
        : `centré dans le format, ${shownFormat.margin} px de marge demandée.`;
  status.textContent = [
    `Silhouette : ${found.from === 'alpha' ? 'canal alpha de l’image' : found.from === 'model' ? `vue par le modèle (seuil ${Math.round(state.floor * 100)} %)` : `fond détouré depuis ${found.seeds} coin(s)`} — ${found.pixels.toLocaleString('fr-FR')} px, boîte ${found.box.right - found.box.left + 1} × ${height} px, ${found.islands} îlot(s) gardé(s)${found.specks > 0 ? `, ${found.specks} poussière(s) écartée(s)` : ''}.`,
    `Pose : ${scaled}, ${posed}`,
    `Pixels : ${pixels.colors} couleur(s)${state.colors > 0 ? ` (${state.method === 'kmeans' ? 'k-means Lab' : 'médiane RVB'}, ${state.colors} demandées)` : ''}, arêtes ${state.edge === 0 ? 'moyennées' : `à ${state.edge}`}.`,
    ...(state.finesse === 1
      ? []
      : [
          `Finesse ×${state.finesse} : le format fait ${shownFormat.width} × ${shownFormat.height} px au lieu de ${state.format.width} × ${state.format.height}. À réduire d’autant avant de l’installer.`,
        ]),
  ].join('\n');
  for (const concern of concerns) note('warn', `⚠ ${sentenceOf(concern)}`);
  // The pipeline's own verdict, from the pipeline's own engine (rules.ts).
  const refused = pipelineProblems(pixels.cell, placed.on, shownFormat);
  for (const problem of refused) note('warn', `✖ ${problem}`);
  if (refused.length === 0) {
    note('fine', `✔ ${shownFormat.name} : taille, marges et rangée basse tenues.`);
  }
  sourceInfo.textContent = `${image.width} × ${image.height} px`;
  cellInfo.textContent = `${placed.cell.width} × ${placed.cell.height} px`;
  cellLabel.textContent = shownFormat.name;
}

function exportCell(): void {
  if (!made) return;
  canvasOf(made.cell).toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nbpix-${shownFormat.width}x${shownFormat.height}.png`;
    link.click();
    // Not before the browser has taken the blob: revoking in the same tick can cancel the save.
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 10_000);
  }, 'image/png');
}

// The brush --------------------------------------------------------------------------------------

/** Where a pointer landed, in the work image's pixels. */
function pointOf(event: PointerEvent): { x: number; y: number } {
  const rect = sourceCanvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * sourceCanvas.width,
    y: ((event.clientY - rect.top) / rect.height) * sourceCanvas.height,
  };
}

function sheetOf(loaded: Work): Sheet {
  return { width: loaded.image.width, height: loaded.image.height, paint: loaded.paint };
}

let drawing: { x: number; y: number } | undefined;

sourceCanvas.addEventListener('pointerdown', (event) => {
  const loaded = work;
  if (!loaded) return;
  event.preventDefault();
  sourceCanvas.setPointerCapture(event.pointerId);
  drawing = pointOf(event);
  stamp(sheetOf(loaded), drawing, state.radius, state.brush);
  clear.disabled = false;
  schedule();
});

sourceCanvas.addEventListener('pointermove', (event) => {
  const loaded = work;
  if (!drawing || !loaded) return;
  const at = pointOf(event);
  stroke(sheetOf(loaded), drawing, at, state.radius, state.brush);
  drawing = at;
  schedule();
});

for (const name of ['pointerup', 'pointercancel'] as const) {
  sourceCanvas.addEventListener(name, () => {
    drawing = undefined;
  });
}

// Loading ----------------------------------------------------------------------------------------

async function load(blob: Blob): Promise<void> {
  const source = await createImageBitmap(blob);
  const scale = Math.min(1, WORK_MAX / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const sheet = document.createElement('canvas');
  sheet.width = width;
  sheet.height = height;
  const context = sheet.getContext('2d');
  if (!context) throw new Error('This browser gives no 2D canvas');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  source.close();
  const image = context.getImageData(0, 0, width, height);
  work = {
    image,
    lab: labBufferOf(image, toLab),
    paint: new Int8Array(width * height),
    canvas: new Uint8Array(width * height),
    cleaned: new Uint8Array(width * height),
  };
  automatic = undefined;
  seen = undefined;
  clear.disabled = true;
  // Chaque format propose sa hauteur : un objet de 16 px n'est pas un combattant.
  state.height = state.format.height0;
  drop.hidden = true;
  run();
}

function take(files: FileList | null | undefined): void {
  const first = files?.[0];
  if (!first) return;
  load(first).catch((error: unknown) => {
    status.textContent = `Image illisible : ${String(error)}`;
  });
}

drop.addEventListener('click', () => {
  file.click();
});
file.addEventListener('change', () => {
  take(file.files);
});
for (const name of ['dragenter', 'dragover'] as const) {
  drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.add('over');
  });
}
drop.addEventListener('dragleave', () => {
  drop.classList.remove('over');
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('over');
  take(event.dataTransfer?.files);
});
document.addEventListener('dragover', (event) => {
  event.preventDefault();
});
document.addEventListener('paste', (event) => {
  take(event.clipboardData?.files);
});
