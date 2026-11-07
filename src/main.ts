/**
 * The page of the rotoscope tool (docs/art/roto.md): `npm run roto`. State and wiring, nothing
 * else — the maths is in the pure steps (silhouette, place, pixelize, brush), the widgets in
 * controls.ts, the drawing in view.ts, the French in words.ts.
 *
 * Every number the steps need is a control here, because they are all empirical: the right
 * tolerance depends on the photo, the right height on the pose. Seeing the silhouette and the
 * anchor is the point of having a page at all.
 */

import { CELL_SIZE } from './game/contract.ts';
import { toLab } from './game/lab.ts';
import type { Sheet } from './brush.ts';
import { stamp, stroke } from './brush.ts';
import { anchorIsAGuess, concernsOf } from './concerns.ts';
import { controlsOn } from './controls.ts';
import type { Bitmap } from './pixels.ts';
import { labBufferOf } from './pixels.ts';
import type { Placed } from './place.ts';
import {
  PLACEMENT_DEFAULTS,
  placeOnCell,
  PORTRAIT_DEFAULTS,
  PORTRAIT_SIZE,
  STANDING_HEIGHT,
} from './place.ts';
import type { Pixelized } from './pixelize.ts';
import { PIXELIZE_DEFAULTS, pixelize } from './pixelize.ts';
import { pipelineProblems } from './rules.ts';
import { modelIsThere, segment } from './segment.ts';
import type { Corners, Mask, Paint } from './silhouette.ts';
import { painted, refine, SILHOUETTE_DEFAULTS, silhouetteOf, soleOf } from './silhouette.ts';
import { canvasOf, drawCell, drawSource } from './view.ts';
import { sentenceOf } from './words.ts';

/**
 * The longest side the page works at. A 4 000 px photo holds nothing a 512 px cell can show, and
 * every slider move would wait on it; 1 600 keeps the chain interactive and loses nothing.
 */
const WORK_MAX = 1600;

const state = {
  tolerance: SILHOUETTE_DEFAULTS.tolerance,
  minShare: SILHOUETTE_DEFAULTS.minShare,
  tidy: SILHOUETTE_DEFAULTS.tidy,
  corners: { ...SILHOUETTE_DEFAULTS.corners },
  /** Where the automatic mask comes from: the colour key, or the model (segment.ts). */
  source: 'key' as 'key' | 'model',
  /** How much of the model's confidence a pixel needs to count as subject. */
  floor: 0.5,
  /** What the brush lays down: 1 paints subject, -1 paints background. */
  brush: 1 as 1 | -1,
  radius: 24,
  frame: PLACEMENT_DEFAULTS.frame,
  /** The frame's own size, before `finesse`. */
  cell: PLACEMENT_DEFAULTS.cell,
  /** The subject's height in the frame's own pixels, before `finesse`. */
  height: PLACEMENT_DEFAULTS.height,
  /**
   * How many pixels the square really holds, as a multiple of the frame's own size. The grain of
   * the result is nothing but this: at ×4 the same framing is drawn four times as finely, at ×½
   * twice as coarsely. Only ×1 is the size the game loads.
   */
  finesse: 1,
  flip: PLACEMENT_DEFAULTS.flip,
  nudgeX: PLACEMENT_DEFAULTS.nudgeX,
  nudgeY: PLACEMENT_DEFAULTS.nudgeY,
  edge: PLACEMENT_DEFAULTS.edge,
  method: PIXELIZE_DEFAULTS.method,
  kuwahara: PIXELIZE_DEFAULTS.kuwahara,
  sharpen: PIXELIZE_DEFAULTS.sharpen,
  saturation: PIXELIZE_DEFAULTS.saturation,
  outline: PIXELIZE_DEFAULTS.outline,
  colors: PIXELIZE_DEFAULTS.colors,
  orphans: PIXELIZE_DEFAULTS.orphans,
  zoom: 1,
  guides: true,
};

/** Everything one imported image brings, and everything derived from it. */
interface Work {
  readonly image: Bitmap;
  readonly lab: Float32Array;
  /** The hand's word on each pixel, kept across every other change. */
  readonly paint: Paint;
  /** Room for the painted mask, so a stroke allocates nothing. */
  readonly canvas: Uint8Array;
  /** Room for the model's mask, kept apart because `refine` writes over what it is given. */
  readonly cleaned: Uint8Array;
}

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

// Controls -------------------------------------------------------------------------------------

let pending = 0;

/** Redo the chain, once the hand has stopped moving for a moment. */
function schedule(): void {
  if (!work) return;
  window.clearTimeout(pending);
  pending = window.setTimeout(run, 60);
}

const ui = controlsOn(schedule);

const CORNERS: readonly { key: keyof Corners; mark: string; title: string }[] = [
  { key: 'topLeft', mark: '↖', title: 'Partir du coin haut gauche' },
  { key: 'topRight', mark: '↗', title: 'Partir du coin haut droit' },
  { key: 'bottomLeft', mark: '↙', title: 'Partir du coin bas gauche' },
  { key: 'bottomRight', mark: '↘', title: 'Partir du coin bas droit' },
];

const clear = ui.button('Effacer les retouches', () => {
  work?.paint.fill(0);
  clear.disabled = true;
  schedule();
});
clear.disabled = true;

const save = ui.button('Enregistrer la case (PNG)', exportCell);
save.disabled = true;

/**
 * The model is offered only once its weights are there: without them the page keeps the colour
 * key and says what to run, rather than failing when the choice is made.
 */
let modelReady = false;
void modelIsThere().then((there) => {
  modelReady = there;
  if (!there) note('warn', '⚠ Modèle absent : lance « npm run roto:model » pour l’activer.');
});

function chooseSource(value: number): void {
  if (value === 1 && !modelReady) {
    state.source = 'key';
    note('warn', '⚠ Modèle absent : lance « npm run roto:model » pour l’activer.');
    return;
  }
  state.source = value === 1 ? 'model' : 'key';
}

/** Picking a frame sets its size and keeps the subject's height to scale. */
function chooseFrame(size: number): void {
  if (size === PORTRAIT_SIZE) {
    state.frame = 'portrait';
    state.cell = PORTRAIT_SIZE;
    state.height = PORTRAIT_DEFAULTS.height;
    return;
  }
  state.height =
    state.frame === 'portrait'
      ? Math.round((STANDING_HEIGHT * size) / CELL_SIZE)
      : Math.round((state.height * size) / state.cell);
  state.frame = 'fighter';
  state.cell = size;
}

must('controls').append(
  ui.group('Silhouette', [
    ui.range(
      'Tolérance du fond',
      () => state.tolerance,
      (v) => (state.tolerance = v),
      {
        min: 0,
        max: 60,
        step: 1,
      },
    ),
    ui.range(
      'Poussières ignorées',
      () => state.minShare,
      (v) => (state.minShare = v),
      { min: 0, max: 0.2, step: 0.005 },
      (value) => `${Math.round(value * 100)} %`,
    ),
    ui.range(
      'Nettoyage du bord',
      () => state.tidy,
      (v) => (state.tidy = v),
      { min: 0, max: 3, step: 1 },
      (value) => (value === 0 ? 'aucun' : `${value} passe(s)`),
    ),
    ui.choice('Détourage', () => (state.source === 'model' ? 1 : 0), chooseSource, [
      { value: 0, label: 'par la couleur' },
      { value: 1, label: 'par le modèle' },
    ]),
    ui.range(
      'Seuil du modèle',
      () => state.floor,
      (v) => (state.floor = v),
      { min: 0.05, max: 0.95, step: 0.05 },
      (value) => `${Math.round(value * 100)} %`,
    ),
    ui.toggles(
      'Coins de départ',
      CORNERS,
      (key) => state.corners[key],
      (key, value) => (state.corners = { ...state.corners, [key]: value }),
    ),
  ]),
  ui.group('Pinceau', [
    ui.choice(
      'Le trait pose',
      () => state.brush,
      (v) => (state.brush = v === 1 ? 1 : -1),
      [
        { value: 1, label: 'du sujet' },
        { value: -1, label: 'du fond' },
      ],
    ),
    ui.range(
      'Taille',
      () => state.radius,
      (v) => (state.radius = v),
      { min: 4, max: 120, step: 2 },
      (value) => `${value * 2} px`,
    ),
    clear,
  ]),
  ui.group('Pose', [
    ui.choice('Cadre', () => state.cell, chooseFrame, [
      { value: CELL_SIZE, label: `Planche, ${CELL_SIZE} px` },
      { value: CELL_SIZE * 2, label: `Planche HD, ${CELL_SIZE * 2} px` },
      { value: PORTRAIT_SIZE, label: `Portrait, ${PORTRAIT_SIZE} px` },
    ]),
    ui.range(
      'Hauteur du sujet',
      () => state.height,
      (v) => (state.height = v),
      { min: 20, max: CELL_SIZE * 2, step: 1 },
      (value) => `${value} px`,
    ),
    ui.check(
      'Retourner (doit regarder à droite)',
      () => state.flip,
      (v) => (state.flip = v),
    ),
    ui.choice(
      'Finesse',
      () => state.finesse * 100,
      (v) => (state.finesse = v / 100),
      [
        { value: 50, label: '×½ (gros grain)' },
        { value: 100, label: '×1 (taille du jeu)' },
        { value: 200, label: '×2' },
        { value: 400, label: '×4 (très fin)' },
      ],
    ),
    ui.range(
      'Décalage ←→',
      () => state.nudgeX,
      (v) => (state.nudgeX = v),
      {
        min: -80,
        max: 80,
        step: 1,
      },
    ),
    ui.range(
      'Décalage ↑↓',
      () => state.nudgeY,
      (v) => (state.nudgeY = v),
      {
        min: -80,
        max: 80,
        step: 1,
      },
    ),
  ]),
  ui.group('Pixels', [
    ui.range(
      'Arêtes nettes',
      () => state.edge,
      (v) => (state.edge = v),
      { min: 0, max: 40, step: 1 },
      (value) => (value === 0 ? 'moyenne' : String(value)),
    ),
    ui.choice(
      'Palette',
      () => (state.method === 'kmeans' ? 1 : 0),
      (v) => (state.method = v === 1 ? 'kmeans' : 'median'),
      [
        { value: 1, label: 'k-means Lab' },
        { value: 0, label: 'médiane RVB' },
      ],
    ),
    ui.range(
      'Kuwahara',
      () => state.kuwahara,
      (v) => (state.kuwahara = v),
      {
        min: 0,
        max: 4,
        step: 1,
      },
    ),
    ui.range(
      'Netteté',
      () => state.sharpen,
      (v) => (state.sharpen = v),
      {
        min: 0,
        max: 2,
        step: 0.1,
      },
    ),
    ui.range(
      'Saturation',
      () => state.saturation,
      (v) => (state.saturation = v),
      {
        min: 1,
        max: 1.6,
        step: 0.05,
      },
    ),
    ui.range(
      'Contour',
      () => state.outline,
      (v) => (state.outline = v),
      { min: 0.3, max: 1, step: 0.05 },
      (value) => (value >= 1 ? 'aucun' : `${Math.round(value * 100)} %`),
    ),
    ui.range(
      'Couleurs',
      () => state.colors,
      (v) => (state.colors = v),
      { min: 0, max: 64, step: 1 },
      (value) => (value === 0 ? 'toutes' : String(value)),
    ),
    ui.range(
      'Orphelins',
      () => state.orphans,
      (v) => (state.orphans = v),
      {
        min: 0,
        max: 4,
        step: 1,
      },
    ),
  ]),
  ui.group('Affichage', [
    ui.range(
      'Zoom',
      () => state.zoom,
      (v) => (state.zoom = v),
      { min: 1, max: 4, step: 1 },
      (value) => `×${value}`,
    ),
    ui.check(
      'Repères',
      () => state.guides,
      (v) => (state.guides = v),
    ),
    save,
  ]),
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
  const mask = painted(automatic.mask, loaded.paint, loaded.canvas);
  const placed = placeOnCell(
    loaded.image,
    mask,
    {
      frame: state.frame,
      cell: Math.round(state.cell * state.finesse),
      height: Math.round(state.height * state.finesse),
      flip: state.flip,
      nudgeX: Math.round(state.nudgeX * state.finesse),
      nudgeY: Math.round(state.nudgeY * state.finesse),
      edge: state.edge,
    },
    loaded.lab,
  );
  made = pixelize(placed.cell, placed.on, {
    kuwahara: state.kuwahara,
    sharpen: state.sharpen,
    saturation: state.saturation,
    outline: state.outline,
    colors: state.colors,
    orphans: state.orphans,
    method: state.method,
  });
  save.disabled = false;
  ui.refresh();
  sourceView.hidden = false;
  cellView.hidden = false;
  drawSource(sourceCanvas, loaded.image, mask, loaded.paint);
  drawCell(cellCanvas, made.cell, {
    zoom: state.zoom,
    frame: state.frame,
    guides: state.guides,
  });
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

// What the page says -----------------------------------------------------------------------------

function note(kind: string, text: string): void {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = text;
  status.append(line);
}

function report(image: Bitmap, mask: Mask, placed: Placed, pixels: Pixelized): void {
  const sole = soleOf(mask);
  const concerns = concernsOf(mask, sole, placed.overflow, state.frame);
  const guessed = state.frame === 'fighter' && anchorIsAGuess(concerns);
  const height = mask.box.bottom - mask.box.top + 1;
  const scaled = `${height} px de source → ${state.height} px de carré (×${placed.scale.toFixed(3)})`;
  status.textContent = [
    `Silhouette : ${mask.from === 'alpha' ? 'canal alpha de l’image' : mask.from === 'model' ? `vue par le modèle (seuil ${Math.round(state.floor * 100)} %)` : `fond détouré depuis ${mask.seeds} coin(s)`} — ${mask.pixels.toLocaleString('fr-FR')} px, boîte ${mask.box.right - mask.box.left + 1} × ${height} px, ${mask.islands} îlot(s) gardé(s)${mask.specks > 0 ? `, ${mask.specks} poussière(s) écartée(s)` : ''}.`,
    state.frame === 'portrait'
      ? `Cadrage : ${scaled}, tête centrée sur le carré, couronne à 6 % du haut. Les épaules sortent par le bas, c’est voulu.`
      : `Pose : ${scaled}, ` +
        (guessed
          ? 'base posée sur l’ancre — mais voir ci-dessous, ce ne sont pas des pieds.'
          : `pieds posés sur l’ancre, base large de ${sole.width} px.`),
    `Pixels : ${pixels.colors} couleur(s)${state.colors > 0 ? ` (${state.method === 'kmeans' ? 'k-means Lab' : 'médiane RVB'}, ${state.colors} demandées)` : ''}, arêtes ${state.edge === 0 ? 'moyennées' : `à ${state.edge}`}.`,
    ...(state.finesse === 1
      ? []
      : [
          `Finesse ×${state.finesse} : le carré fait ${placed.cell.width} px au lieu de ${state.cell}. À réduire d’autant avant de l’installer — le jeu ne lit que la taille du cadre.`,
        ]),
  ].join('\n');
  for (const concern of concerns) note('warn', `⚠ ${sentenceOf(concern)}`);
  // The pipeline's own verdict, from the pipeline's own engine (rules.ts).
  const refused = pipelineProblems(pixels.cell, placed.on, state.frame, state.cell);
  for (const problem of refused) note('warn', `✖ ${problem}`);
  if (refused.length === 0) {
    note(
      'fine',
      '✔ La géométrie passe les règles de « npm run sprites » (taille, marges, rangée basse).',
    );
  }
  sourceInfo.textContent = `${image.width} × ${image.height} px`;
  cellInfo.textContent = `${placed.cell.width} × ${placed.cell.height} px`;
  cellLabel.textContent =
    state.frame === 'portrait' ? 'Portrait' : state.cell === CELL_SIZE ? 'Case du jeu' : 'Case HD';
}

function exportCell(): void {
  if (!made) return;
  canvasOf(made.cell).toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `roto-${state.frame}-${made?.cell.width ?? 0}.png`;
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
  // A subject that fills the frame is the common case: start at the measured standing height.
  state.height = Math.round((STANDING_HEIGHT * state.cell) / CELL_SIZE);
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
