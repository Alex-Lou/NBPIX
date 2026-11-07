/**
 * Transforme un PNG rendu par NBPIX en .aseprite, en passant par ton Aseprite.
 *
 *   npm run aseprite -- mon-sprite.png
 *   npm run aseprite -- mon-sprite.png --out ailleurs.aseprite
 *
 * Aseprite tourne sans interface (`--batch`) et exécute tools/aseprite.lua. Le binaire est
 * cherché dans le PATH, puis aux endroits où les installeurs le posent ; `--aseprite <chemin>`
 * force le sien.
 *
 * Volontairement en JavaScript et non en TypeScript : c'est le seul script que quelqu'un puisse
 * avoir besoin de lancer avec un Node plus ancien que celui du reste du projet.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Là où les installeurs posent Aseprite, quand il n'est pas dans le PATH. */
const USUAL = [
  'C:/Program Files/Aseprite/Aseprite.exe',
  'C:/Program Files (x86)/Aseprite/Aseprite.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Programs/Aseprite/Aseprite.exe`,
  `${process.env.USERPROFILE ?? ''}/scoop/apps/aseprite/current/Aseprite.exe`,
  'C:/Program Files (x86)/Steam/steamapps/common/Aseprite/Aseprite.exe',
  `${process.env.HOME ?? ''}/.steam/steam/steamapps/common/Aseprite/aseprite`,
  '/Applications/Aseprite.app/Contents/MacOS/aseprite',
  '/usr/bin/aseprite',
  '/usr/local/bin/aseprite',
];

function asepriteAt(given) {
  if (given) return given;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['aseprite'], {
    encoding: 'utf8',
  });
  const found = which.stdout?.split(/\r?\n/)[0]?.trim();
  if (found && existsSync(found)) return found;
  return USUAL.find((path) => path && existsSync(path));
}

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const sprite = args.find(
  (arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1]?.startsWith('--') !== true,
);

if (!sprite) {
  console.error(
    'Usage : npm run aseprite -- <sprite.png> [--out <fichier.aseprite>] [--aseprite <chemin>]',
  );
  process.exit(1);
}
if (!existsSync(sprite)) {
  console.error(`${sprite} est introuvable.`);
  process.exit(1);
}

const binary = asepriteAt(flag('aseprite'));
if (!binary) {
  console.error(
    'Aseprite est introuvable. Donne son chemin : npm run aseprite -- sprite.png --aseprite "C:/Program Files/Aseprite/Aseprite.exe"',
  );
  process.exit(1);
}

const out =
  flag('out') ?? resolve(dirname(sprite), `${basename(sprite).replace(/\.png$/i, '')}.aseprite`);
const run = spawnSync(
  binary,
  [
    '--batch',
    '--script-param',
    `sprite=${resolve(sprite)}`,
    '--script-param',
    `out=${out}`,
    '--script',
    join(HERE, 'aseprite.lua'),
  ],
  { stdio: 'inherit' },
);
process.exit(run.status ?? 1);
