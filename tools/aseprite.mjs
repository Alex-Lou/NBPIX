/**
 * Transforme un PNG rendu par NBPIX en .aseprite, en passant par ton Aseprite.
 *
 *   npm run aseprite                      le nbpix-*.png le plus récent, converti puis ouvert
 *   npm run aseprite -- mon-sprite.png
 *   npm run aseprite -- mon-sprite.png --out ailleurs.aseprite
 *
 * Sans argument, il prend le `nbpix-*.png` le plus récent du dossier courant ou des
 * téléchargements : c'est exactement ce que la page vient d'enregistrer, et taper un chemin pour
 * le redire est une étape de trop.
 *
 * Aseprite tourne sans interface (`--batch`) et exécute tools/aseprite.lua. Le binaire est
 * cherché dans le PATH, puis aux endroits où les installeurs le posent ; `--aseprite <chemin>`
 * force le sien.
 *
 * Volontairement en JavaScript et non en TypeScript : c'est le seul script que quelqu'un puisse
 * avoir besoin de lancer avec un Node plus ancien que celui du reste du projet.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
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

/** Là où un PNG sorti de la page a des chances d'être : à côté de soi, ou dans les téléchargements. */
const LOOK_IN = [
  process.cwd(),
  join(homedir(), 'Downloads'),
  // Le vrai dossier s'appelle « Downloads » même en français sous Windows ; ailleurs, non.
  join(homedir(), 'Téléchargements'),
];

/**
 * Le `nbpix-*.png` le plus récent. La page nomme ses sorties ainsi (`nbpix-32x32.png`), et le
 * navigateur ajoute « (1) » quand il en enregistre un deuxième — d'où un motif et non un nom exact.
 */
function latestSprite() {
  let best;
  for (const folder of LOOK_IN) {
    let names;
    try {
      names = readdirSync(folder);
    } catch {
      continue; // Un dossier absent n'est pas une erreur : on en propose plusieurs exprès.
    }
    for (const name of names) {
      if (!/^nbpix-.*\.png$/i.test(name)) continue;
      const path = join(folder, name);
      try {
        const when = statSync(path).mtimeMs;
        if (!best || when > best.when) best = { path, when };
      } catch {
        continue;
      }
    }
  }
  return best?.path;
}

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
// L'index vient de `find` : `indexOf` rendrait la première occurrence, donc deux arguments
// identiques feraient lire le mauvais voisin.
const given = args.find(
  (arg, at) => !arg.startsWith('--') && args[at - 1]?.startsWith('--') !== true,
);
const sprite = given ?? latestSprite();

if (!sprite) {
  console.error(
    `Aucun nbpix-*.png trouvé dans :\n${LOOK_IN.map((folder) => `  ${folder}`).join('\n')}\n` +
      'Enregistre une case depuis la page, ou donne le fichier : npm run aseprite -- mon-sprite.png',
  );
  process.exit(1);
}
if (!given) console.log(`le plus récent : ${sprite}`);
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
if (run.status !== 0) process.exit(run.status ?? 1);

// Ouvrir le résultat : c'est là que le travail à la main commence, autant ne pas avoir à le
// chercher. Détaché, pour que la commande rende la main sans attendre qu'on ferme la fenêtre.
spawn(binary, [out], { detached: true, stdio: 'ignore' }).unref();
console.log(`ouvert dans Aseprite : ${out}`);
