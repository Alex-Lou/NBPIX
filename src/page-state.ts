/**
 * Ce que la page retient. Une seule source de vérité : les widgets la lisent et l'écrivent, la
 * chaîne la lit, personne n'en garde une copie.
 *
 * Tous ces nombres sont empiriques — la bonne tolérance dépend de la photo, la bonne hauteur de la
 * pose — d'où un réglage pour chacun plutôt qu'une constante.
 */

import type { Bitmap } from './pixels.ts';
import { PIXELIZE_DEFAULTS } from './pixelize.ts';
import { PLACEMENT_DEFAULTS } from './place.ts';
import type { Paint } from './silhouette.ts';
import { SILHOUETTE_DEFAULTS } from './silhouette.ts';
import type { Style } from './style.ts';
import { STYLES } from './style.ts';

/**
 * The longest side the page works at. A 4 000 px photo holds nothing a 512 px cell can show, and
 * every slider move would wait on it; 1 600 keeps the chain interactive and loses nothing.
 */
export const WORK_MAX = 1600;

export const state = {
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
  /**
   * La largeur de case pour laquelle le zoom courant a été choisi. Tant qu'elle ne change pas, le
   * curseur garde la main — sans cette mémoire, chaque passe écraserait le zoom demandé à la main.
   */
  zoomedFor: undefined as number | undefined,
  guides: true,
};

/** Everything one imported image brings, and everything derived from it. */
export interface Work {
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
