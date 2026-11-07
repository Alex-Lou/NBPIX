/**
 * Ce qu'est un format de sprite, et ceux qu'on connaît.
 *
 * Un format, c'est une boîte et une règle pour y poser le sujet. Rien de plus. Une planche de
 * NayosBeat pose les pieds sur une rangée précise ; un buste pend la tête sous un peu d'air ; un
 * objet de 16 × 16 se contente d'être centré. Les trois sont le même calcul — mettre à l'échelle
 * et épingler — et ne diffèrent que par le point épinglé.
 *
 * Ce sont des **données** : ajouter un format ne demande pas de toucher au calcul, et les règles
 * que la sortie doit tenir (rules.ts) se lisent dans le format lui-même.
 */

import { ANCHOR, CELL_MARGIN, CELL_SIZE, LOWEST_ROW, PORTRAIT_SIZE } from './game/contract.ts';

/** Le point du sujet qu'on épingle, et où. Tout est en pixels du format. */
export type Pin =
  /** La dernière rangée des pieds sur `row`, leur milieu sur `column`. Une planche de combat. */
  | { readonly kind: 'feet'; readonly column: number; readonly row: number }
  /** Le sommet du crâne à `air` de haut (en part de la hauteur), centré. Un buste. */
  | { readonly kind: 'crown'; readonly air: number }
  /** Le milieu de la boîte du sujet au milieu du format. Un objet, une icône. */
  | { readonly kind: 'box' };

export interface Format {
  /** Ce que la page en dit. */
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pin: Pin;
  /** Pixels vides gardés sur les bords, que la sortie doit tenir (rules.ts). */
  readonly margin: number;
  /** La rangée la plus basse où quoi que ce soit peut être dessiné. */
  readonly lowestRow: number;
  /** La hauteur du sujet proposée à l'ouverture, en pixels du format. */
  readonly height0: number;
}

/**
 * Une planche de NayosBeat, à l'échelle demandée. `scale` 1 donne la case du jeu, 2 la HD : les
 * mêmes règles, aux mêmes endroits, simplement deux fois plus finement.
 */
export function fighterFormat(scale: number): Format {
  const side = CELL_SIZE * scale;
  return {
    name: scale === 1 ? `Planche, ${side} px` : `Planche HD, ${side} px`,
    width: side,
    height: side,
    pin: { kind: 'feet', column: ANCHOR.x * scale, row: ANCHOR.y * scale },
    margin: CELL_MARGIN * scale,
    lowestRow: (LOWEST_ROW + 1) * scale - 1,
    height0: 157 * scale,
  };
}

/** Le buste de l'écran de sélection : la tête centrée, les épaules sortent par le bas. */
export const PORTRAIT: Format = {
  name: `Portrait, ${PORTRAIT_SIZE} px`,
  width: PORTRAIT_SIZE,
  height: PORTRAIT_SIZE,
  // Le cadrage du jeu met le milieu de la tête à 45 % du carré ; une tête photographiée garde plus
  // de cheveux qu'une tête dessinée, d'où un peu moins d'air.
  pin: { kind: 'crown', air: 0.06 },
  margin: 0,
  lowestRow: PORTRAIT_SIZE - 1,
  height0: PORTRAIT_SIZE,
};

/** Un carré libre où le sujet est simplement centré : un objet, une icône, une tuile. */
export function boxFormat(side: number, margin = Math.max(1, Math.round(side / 16))): Format {
  return {
    name: `Objet, ${side} × ${side}`,
    width: side,
    height: side,
    pin: { kind: 'box' },
    margin,
    lowestRow: side - 1,
    height0: side - 2 * margin,
  };
}

/**
 * Ceux qu'on propose. Les trois premiers sont les formats de NayosBeat ; les suivants sont des
 * tailles de sprite courantes, du 16 × 16 d'un objet au 128 d'un grand décor.
 */
export const FORMATS: readonly Format[] = [
  fighterFormat(1),
  fighterFormat(2),
  PORTRAIT,
  boxFormat(16),
  boxFormat(32),
  boxFormat(48),
  boxFormat(64),
  boxFormat(128),
];

/** Ce qu'un format devient à une finesse donnée : la même chose, dessinée plus ou moins finement. */
export function atFinesse(format: Format, finesse: number): Format {
  if (finesse === 1) return format;
  const scaled = (value: number) => Math.round(value * finesse);
  return {
    ...format,
    width: scaled(format.width),
    height: scaled(format.height),
    margin: scaled(format.margin),
    lowestRow: scaled(format.lowestRow + 1) - 1,
    height0: scaled(format.height0),
    pin:
      format.pin.kind === 'feet'
        ? { kind: 'feet', column: scaled(format.pin.column), row: scaled(format.pin.row + 1) - 1 }
        : format.pin,
  };
}

/** La hauteur qui fait tenir un sujet de ce rapport dans le format, marges comprises. */
export function fittingHeight(format: Format, subject: { width: number; height: number }): number {
  const room = {
    width: format.width - 2 * format.margin,
    height: format.height - 2 * format.margin,
  };
  if (subject.width <= 0 || subject.height <= 0) return room.height;
  const byWidth = (room.width * subject.height) / subject.width;
  return Math.max(1, Math.floor(Math.min(room.height, byWidth)));
}
