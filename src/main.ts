/**
 * The page of the rotoscope tool (docs/art/roto.md): `npm run roto`. State and wiring, nothing
 * else — the maths is in the pure steps (silhouette, place, pixelize, brush), the widgets in
 * controls.ts, the drawing in view.ts, the French in words.ts.
 *
 * Every number the steps need is a control here, because they are all empirical: the right
 * tolerance depends on the photo, the right height on the pose. Seeing the silhouette and the
 * anchor is the point of having a page at all.
 */

import type { Format } from './format.ts';
import { atFinesse, fittingHeight } from './format.ts';
import type { Style } from './style.ts';
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
  /** Le style visé : une boîte, un nombre de couleurs, la palette d'une machine (style.ts). */
  style: STYLES[0] as Style,
  /** The box and the rule for putting the subject in it, before `finesse` (format.ts). */
  format: STYLES[0]?.format ?? PLACEMENT_DEFAULTS.format,
  /** The subject's height in the format's own pixels, before `finesse`. */
  height: STYLES[0]?.format.height0 ?? PLACEMENT_DEFAULTS.height,
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
  colors: STYLES[0]?.colors ?? PIXELIZE_DEFAULTS.colors,
  dither: STYLES[0]?.dither ?? PIXELIZE_DEFAULTS.dither,
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
  /**
   * Un échantillon des couleurs du sujet, prises sur la source avant toute réduction : c'est là
   * qu'on apprend la palette, pour qu'elle représente ce qu'on a donné à l'outil et non ce qui
   * reste après coup.
   */
  sample?: Uint8ClampedArray;
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
    ui.choice(
      'Style',
      () => STYLES.indexOf(state.style),
      chooseStyle,
      STYLES.map((style, index) => ({ value: index, label: style.name })),
    ),
    ui.range(
      'Hauteur du sujet',
      () => state.height,
      (v) => (state.height = v),
      { min: 2, max: 512, step: 1 },
      (value) => `${value} px`,
    ),
    fitButton,
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
  ui.refresh();
  sourceView.hidden = false;
  cellView.hidden = false;
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
