/**
 * Ce qui reste à faire à la case une fois l'abstraction rendue : la poser sur la palette de la
 * machine visée, quand le style en impose une.
 *
 * Le reste du raccord n'existe pas, et c'est voulu. Le moteur reçoit la case telle que place.ts
 * l'a posée, simplement calculée plus finement, et la réduit à sa taille réelle. La mise à
 * l'échelle, l'ancre, les marges, le retournement et la règle de crête restent donc entièrement
 * l'affaire de place.ts — recalculer sa transformation ici donnerait un sujet écrasé et une
 * silhouette épaissie par la grille.
 */

import type { Bitmap } from './pixels.ts';
import type { Master } from './style.ts';

/**
 * La case rabattue sur la palette de la machine.
 *
 * Après l'abstraction et non avant : choisir directement parmi les couleurs d'une console donnerait
 * des regroupements absurdes — la NES n'a pas de bruns, elle a des oranges sombres. C'est déjà la
 * règle de pixelize.ts, on ne la contredit pas ici.
 */
export function snappedTo(cell: Bitmap, master: Master | undefined): Bitmap {
  if (!master) return cell;
  const made: Bitmap = { width: cell.width, height: cell.height, data: cell.data.slice() };
  for (let at = 0; at < cell.width * cell.height; at++) {
    if ((made.data[at * 4 + 3] ?? 0) === 0) continue;
    const [r, g, b] = master.snap(
      made.data[at * 4] ?? 0,
      made.data[at * 4 + 1] ?? 0,
      made.data[at * 4 + 2] ?? 0,
    );
    made.data[at * 4] = r;
    made.data[at * 4 + 1] = g;
    made.data[at * 4 + 2] = b;
  }
  return made;
}
