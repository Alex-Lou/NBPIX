/**
 * What the page says, in French. The judgements themselves are data (concerns.ts); this turns them
 * into sentences. Apart, because text and reasoning have no business in the same file: the tests
 * read the names, the artist reads the words, and neither has to care about the other.
 */

import type { Concern } from './concerns.ts';
import type { Edges } from './silhouette.ts';

export function percent(share: number): string {
  return `${Math.round(share * 100)} %`;
}

/** A list as a sentence says it: "a, b et c". */
export function listOf(parts: readonly (string | false)[]): string {
  const kept = parts.filter((part): part is string => part !== false);
  const last = kept[kept.length - 1] ?? '';
  return kept.length <= 1 ? last : `${kept.slice(0, -1).join(', ')} et ${last}`;
}

export function sidesOf(edges: Edges): string {
  return listOf([
    edges.left && 'gauche',
    edges.top && 'haut',
    edges.right && 'droit',
    edges.bottom && 'bas',
  ]);
}

/** A concern (concerns.ts) in the words the page says it. */
export function sentenceOf(concern: Concern): string {
  switch (concern.kind) {
    case 'nothing-kept':
      return `Presque rien n’a été gardé (${percent(concern.share)} de l’image) : la tolérance est trop haute, ou le sujet a la couleur de son fond.`;
    case 'everything-kept':
      return `Presque tout a été gardé (${percent(concern.share)}) : le fond n’a pas été reconnu. Baisse la tolérance.`;
    case 'narrow-base':
      return `Ce qui est pris pour les pieds ne fait que ${concern.width} px, soit ${percent(concern.share)} de la largeur du sujet : c’est une ombre, une queue ou un col, pas des semelles. L’ancre est une supposition.`;
    case 'cut-off':
      return `Le sujet touche le bord ${sidesOf(concern.edges)} de l’image : ce qui est hors cadre manque à toutes les mesures.`;
    case 'corner-dropped':
      return `${concern.dropped} coin(s) de l’image écarté(s) : ils tombent sur le sujet, pas sur le fond. Le détourage est parti des autres.`;
    case 'specks':
      return `${concern.specks} îlots écartés : le détourage accroche le fond, le bord de la silhouette n’est pas sûr.`;
    case 'overflow': {
      const over = concern.overflow;
      return `Le sujet dépasse la case de ${listOf([
        over.left > 0 && `${over.left} px à gauche`,
        over.top > 0 && `${over.top} px en haut`,
        over.right > 0 && `${over.right} px à droite`,
        over.bottom > 0 && `${over.bottom} px en bas`,
      ])} : baisse la hauteur.`;
    }
  }
}
