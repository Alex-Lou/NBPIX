/**
 * L'abstraction tenue hors du fil principal.
 *
 * Le moteur met de 0,2 s sur une case de 16 px à une vingtaine de secondes sur une planche de 256,
 * quand la page, elle, redessine à chaque mouvement de curseur. Les deux ne peuvent pas partager
 * un fil : l'onglet gèlerait pendant le calcul, et c'est précisément là qu'on veut pouvoir changer
 * d'avis.
 *
 * Ce fichier ne fait que passer les plats. Tout le calcul est dans abstract.ts, qui reste pur.
 */

import type { AbstractOptions } from './abstract.ts';
import { abstractToPixels } from './abstract.ts';
import type { Box } from './pixels.ts';

export interface Job {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly on: Uint8Array;
  readonly box: Box;
  readonly options: AbstractOptions;
}

export type Answer =
  | {
      readonly ok: true;
      readonly width: number;
      readonly height: number;
      readonly data: Uint8ClampedArray;
      readonly colors: number;
      readonly passes: number;
    }
  | { readonly ok: false; readonly why: string };

/**
 * Le tsconfig déclare la bibliothèque DOM et non celle des workers, où `postMessage` ne prend pas
 * l'origine d'une fenêtre en second argument. On le retype ici plutôt que de couper le projet en
 * deux tsconfig pour une ligne.
 */
const reply = postMessage as unknown as (answer: Answer) => void;

addEventListener('message', (event: MessageEvent) => {
  const job = event.data as Job;
  try {
    const made = abstractToPixels(
      { width: job.width, height: job.height, data: job.data },
      job.on,
      job.box,
      job.options,
    );
    reply({
      ok: true,
      width: made.cell.width,
      height: made.cell.height,
      data: made.cell.data,
      colors: made.palette.length,
      passes: made.passes,
    });
  } catch (error: unknown) {
    reply({ ok: false, why: String(error) });
  }
});
