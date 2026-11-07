import { describe, expect, it } from 'vitest';
import { snappedTo } from '../src/abstract-cell';
import { bitmap } from '../src/pixels';
import { GAME_BOY, NES } from '../src/style';

/** Une case de quelques couleurs quelconques, dont un pixel transparent. */
function cell() {
  const made = bitmap(2, 2);
  const colors = [
    [123, 45, 67],
    [200, 180, 40],
    [10, 90, 160],
  ];
  for (let at = 0; at < 3; at++) {
    made.data[at * 4] = colors[at]?.[0] ?? 0;
    made.data[at * 4 + 1] = colors[at]?.[1] ?? 0;
    made.data[at * 4 + 2] = colors[at]?.[2] ?? 0;
    made.data[at * 4 + 3] = 255;
  }
  return made;
}

const rgbaAt = (made: ReturnType<typeof bitmap>, at: number) =>
  [made.data[at * 4], made.data[at * 4 + 1], made.data[at * 4 + 2], made.data[at * 4 + 3]] as const;

describe('la case rabattue sur la palette machine', () => {
  it('ne touche à rien quand le style n’impose pas de palette', () => {
    const made = cell();
    expect(snappedTo(made, undefined)).toBe(made);
  });

  it('ne rend que des couleurs que la machine savait afficher', () => {
    const snapped = snappedTo(cell(), NES);
    for (let at = 0; at < 3; at++) {
      const [r, g, b] = rgbaAt(snapped, at);
      expect(NES.snap(r ?? 0, g ?? 0, b ?? 0)).toEqual([r, g, b]);
    }
  });

  it('laisse la transparence transparente', () => {
    // Un pixel vide rabattu deviendrait un pixel noir opaque : la silhouette y passerait.
    expect(rgbaAt(snappedTo(cell(), GAME_BOY), 3)[3]).toBe(0);
  });

  it('ne modifie pas la case qu’on lui donne', () => {
    const made = cell();
    const before = Array.from(made.data);
    snappedTo(made, NES);
    expect(Array.from(made.data)).toEqual(before);
  });
});
