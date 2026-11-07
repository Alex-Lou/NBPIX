/**
 * Les styles : « ce visuel, mais en NES ». C'est le choix que l'outil demande en premier, et le
 * seul qu'il faut faire pour obtenir quelque chose.
 *
 * Un style, c'est trois choses ensemble : une **boîte** (format.ts), un **nombre de couleurs**, et
 * la **palette de la machine** quand elle en avait une. Les trois comptent : une NES à 32 couleurs
 * libres ne ressemble pas à une NES ; ce qui fait le style, c'est la contrainte, pas le filtre.
 *
 * Les contraintes sont celles du matériel, pas des approximations :
 *
 * | Machine | Couleurs par sprite | Tailles | Palette |
 * |---|---|---|---|
 * | NES | **3** + transparent | 8×8, 8×16 (un objet plus grand = plusieurs sprites) | 54 couleurs fixes |
 * | Game Boy | **3** nuances + transparent | 8×8, 8×16 | 4 niveaux, écran 160×144 |
 * | SNES | **15** + transparent | 8, 16, 32, 64 | 32 768 (5 bits par canal) |
 * | Mega Drive | **15** + transparent | 8 à 32, par tuiles | 512 (3 bits par canal) |
 *
 * **La colonne « par sprite » est le piège.** Un objet plus grand qu'un sprite est fait de
 * plusieurs sprites, et chacun choisit librement l'une des palettes matérielles : un objet de
 * 16 × 16 sur NES, c'est deux sprites de 8 × 16, donc deux palettes, donc six couleurs. Un
 * personnage en utilise quatre — le maximum simultané de la machine — soit douze. Demander trois
 * couleurs pour un personnage entier est donc *plus strict que le matériel*, et rend des sprites
 * qu'aucun jeu NES n'a jamais eus.
 *
 * Le Game Boy fait exception et reste à trois : sa DMG n'a que quatre niveaux en tout, et une
 * seconde palette de sprite y puise les mêmes. Là, la contrainte est vraiment la machine.
 */

import type { Format } from './format.ts';
import { boxFormat, fighterFormat, PORTRAIT } from './format.ts';

/** La palette d'une machine : ce à quoi une couleur a le droit de ressembler chez elle. */
export interface Master {
  readonly name: string;
  /** La couleur de la machine la plus proche de celle qu'on lui donne. */
  readonly snap: (r: number, g: number, b: number) => [number, number, number];
}

/**
 * Le PPU RGB de la NES (2C03), dont les couleurs se déduisent exactement de son convertisseur
 * 3 bits : `C = 255 × DAC / 7` (nesdev.org, *PPU palettes*). C'est une palette NES réelle et
 * vérifiable, là où les tables « NTSC » qui circulent sont des approximations d'un signal vidéo.
 * Les teintes $D à $F sont noires ou inutilisées : seules les 13 premières de chaque rangée
 * servent, plus un noir.
 */
const NES_HEX = [
  '6d6d6d',
  '002492',
  '0000db',
  '6d49db',
  '92006d',
  'b6006d',
  'b62400',
  '924900',
  '6d4900',
  '244900',
  '006d24',
  '009200',
  '004949',
  'b6b6b6',
  '006ddb',
  '0049ff',
  '9200ff',
  'b600ff',
  'ff0092',
  'ff0000',
  'db6d00',
  '926d00',
  '249200',
  '009200',
  '00b66d',
  '009292',
  'ffffff',
  '6ddbff',
  '9292ff',
  'db6dff',
  'ff00ff',
  'ff6dff',
  'ff9200',
  'ffb600',
  'dbdb00',
  '6ddb00',
  '00ff00',
  '49ffdb',
  '00ffff',
  'ffffff',
  'b6dbff',
  'dbb6ff',
  'ffb6ff',
  'ff92ff',
  'ffb6b6',
  'ffdb92',
  'ffff49',
  'ffff6d',
  'b6ff49',
  '92ff6d',
  '49ffdb',
  '92dbff',
  '000000',
] as const;

/**
 * Les quatre niveaux du Game Boy. Attention : la DMG n'avait **aucune couleur** — quatre niveaux
 * de gris sur un écran à cristaux liquides teinté vert. Ces quatre verts sont la convention qui
 * s'est imposée pour la représenter, pas une spécification du matériel.
 */
const GAME_BOY_HEX = ['0f380f', '306230', '8bac0f', '9bbc0f'] as const;

function tableOf(name: string, hex: readonly string[]): Master {
  const colors = hex.map((value) => [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ]);
  return {
    name,
    snap: (r, g, b) => {
      let best: number[] = colors[0] ?? [0, 0, 0];
      let bestDistance = Infinity;
      for (const color of colors) {
        // En lumière perçue : le vert pèse plus que le bleu pour l'œil.
        const distance =
          2 * ((color[0] ?? 0) - r) ** 2 +
          4 * ((color[1] ?? 0) - g) ** 2 +
          3 * ((color[2] ?? 0) - b) ** 2;
        if (distance >= bestDistance) continue;
        bestDistance = distance;
        best = color;
      }
      return [best[0] ?? 0, best[1] ?? 0, best[2] ?? 0];
    },
  };
}

/** Une machine qui code chaque canal sur `bits` bits : la couleur se pose sur la grille la plus proche. */
function stepped(name: string, bits: number): Master {
  const steps = (1 << bits) - 1;
  const step = (value: number) => Math.round((Math.round((value / 255) * steps) / steps) * 255);
  return { name, snap: (r, g, b) => [step(r), step(g), step(b)] };
}

export const NES = tableOf('NES', NES_HEX);
export const GAME_BOY = tableOf('Game Boy', GAME_BOY_HEX);
/** 15 bits : 5 par canal, 32 768 couleurs. */
export const SNES = stepped('SNES', 5);
/** 9 bits : 3 par canal, 512 couleurs. */
export const MEGA_DRIVE = stepped('Mega Drive', 3);

export interface Style {
  readonly name: string;
  /** Une ligne, pour que la page dise ce que ce choix impose. */
  readonly about: string;
  readonly format: Format;
  /** Couleurs opaques, hors transparence. */
  readonly colors: number;
  /** La palette de la machine, quand elle en imposait une. */
  readonly master?: Master;
  /**
   * Combien tramer. Plus la palette est courte, plus le tramage compte : c'est lui qui rendait
   * leurs dégradés aux machines qui n'avaient pas les teintes pour.
   */
  readonly dither: number;
}

/**
 * Ce qu'on propose, du plus contraint au plus libre, puis les formats du jeu. L'ordre compte :
 * c'est la première chose que l'œil lit en ouvrant la page.
 */
export const STYLES: readonly Style[] = [
  {
    name: 'NES — objet 16 × 16',
    about: '6 couleurs de la machine : deux sprites de 8 × 16, donc deux de ses quatre palettes.',
    format: boxFormat(16, 0),
    colors: 6,
    master: NES,
    dither: 1,
  },
  {
    name: 'Game Boy — objet 16 × 16',
    about:
      '3 nuances sur 4. La console n’avait pas de couleurs : quatre niveaux sur un écran vert.',
    format: boxFormat(16, 0),
    colors: 3,
    master: GAME_BOY,
    dither: 1,
  },
  {
    name: 'NES — personnage 16 × 32',
    about: '12 couleurs : les quatre palettes de la machine, ce qu’un héros de 1985 pouvait avoir.',
    format: { ...boxFormat(16, 0), name: 'NES 16 × 32', height: 32, lowestRow: 31, height0: 30 },
    colors: 12,
    master: NES,
    dither: 1,
  },
  {
    name: 'NES — personnage 32 × 32',
    about: 'Les mêmes 12 couleurs, sur quatre fois plus de pixels : un personnage s’y lit.',
    format: boxFormat(32, 1),
    colors: 12,
    master: NES,
    dither: 1,
  },
  {
    name: 'Game Boy — personnage 32 × 32',
    about: 'Toujours 3 nuances — c’est la machine — mais assez de pixels pour une silhouette.',
    format: boxFormat(32, 1),
    colors: 3,
    master: GAME_BOY,
    dither: 1,
  },
  {
    name: 'SNES — objet 32 × 32',
    about: '15 couleurs parmi 32 768. La génération 16 bits, où la palette cesse d’être le mur.',
    format: boxFormat(32, 1),
    colors: 15,
    master: SNES,
    dither: 0.6,
  },
  {
    name: 'Mega Drive — objet 32 × 32',
    about: '15 couleurs parmi 512. Moins de teintes que la SNES, d’où ses contrastes plus durs.',
    format: boxFormat(32, 1),
    colors: 15,
    master: MEGA_DRIVE,
    dither: 0.6,
  },
  {
    name: 'Mega Drive — personnage 48 × 48',
    about: '15 couleurs, sur la taille où un personnage de la machine commence à se lire.',
    format: boxFormat(48, 2),
    colors: 15,
    master: MEGA_DRIVE,
    dither: 0.6,
  },
  {
    name: 'SNES — personnage 64 × 64',
    about: '15 couleurs, la plus grande taille qu’un seul sprite SNES pouvait prendre.',
    format: boxFormat(64, 2),
    colors: 15,
    master: SNES,
    dither: 0.6,
  },
  {
    name: 'Moderne — 128 × 128',
    about: 'Aucune contrainte de machine : autant de couleurs que le dessin en demande.',
    format: boxFormat(128, 4),
    colors: 32,
    dither: 0,
  },
  {
    name: 'Moderne — 256 × 256',
    about: 'Grand format, 48 couleurs : pour un objet qu’on regarde de près.',
    format: boxFormat(256, 8),
    colors: 48,
    dither: 0,
  },
  {
    name: 'Moderne — 512 × 512',
    about: 'Le plus fin que l’outil propose. Au-delà, c’est une photo réduite, plus du pixel art.',
    format: boxFormat(512, 16),
    colors: 64,
    dither: 0,
  },
  {
    name: 'NayosBeat — planche 256',
    about: 'Le format du jeu : les pieds sur l’ancre, 4 px de marge.',
    format: fighterFormat(1),
    colors: 32,
    dither: 0,
  },
  {
    name: 'NayosBeat — planche HD 512',
    about: 'Le même, dessiné deux fois plus finement.',
    format: fighterFormat(2),
    colors: 32,
    dither: 0,
  },
  {
    name: 'NayosBeat — portrait 96',
    about: 'Le buste de l’écran de sélection : la tête centrée, les épaules sortent par le bas.',
    format: PORTRAIT,
    colors: 32,
    dither: 0,
  },
];
