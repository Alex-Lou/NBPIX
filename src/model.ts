/**
 * Everything the page needs to run the model, put where it can serve it: `npm run model`.
 *
 * Two kinds of file, one folder, all of it ignored by git (`model/`):
 *
 * - **the weights**, 4.6 MB, fetched once. They are not committed: a repository carries source,
 *   and every clone would carry them forever.
 * - **the WebAssembly runtime**, copied out of node_modules. ONNX Runtime looks for it next to
 *   wherever it is told; putting it beside the weights means the page asks for one folder, served
 *   by Vite, with no CDN and nothing to configure. It works offline once fetched.
 *
 * Idempotent: a file already there with the right size and digest is left alone, so
 * `npm run dev` can call this every time and cost nothing after the first.
 *
 * The weights are U²-Net small (`u2netp`) — Qin et al., *U²-Net: Going Deeper with Nested
 * U-Structure for Salient Object Detection* — under the Apache License 2.0, which allows use and
 * redistribution provided the licence and the notices travel with it. `NOTICE.md` is written
 * beside them to carry that attribution.
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = new URL('../model/', import.meta.url);
const RUNTIME = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url);

/** The weights, pinned by digest: a file that changed at the other end is not this model. */
const WEIGHTS = {
  name: 'u2netp.onnx',
  from: 'https://huggingface.co/nfa04/u2netp-onnx/resolve/main/u2netp.onnx',
  bytes: 4_574_861,
  sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
} as const;

/** What ONNX Runtime's wasm backend loads, by these exact names. */
const RUNTIME_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'] as const;

const NOTICE = `# D'où viennent ces fichiers

Ce dossier est **ignoré par git** : \`npm run model\` le remplit (src/model.ts).

## u2netp.onnx

U²-Net small, de Qin, Zhang, Huang, Dehghan, Zaiane et Jagersand,
*U²-Net: Going Deeper with Nested U-Structure for Salient Object Detection* (Pattern Recognition,
2020). Dépôt : <https://github.com/xuebinqin/U-2-Net>.

Sous **Apache License 2.0**. Elle permet l'usage et la redistribution, y compris commerciale, à
condition de joindre la licence et de conserver les mentions — ce que fait ce fichier.
Texte de la licence : <https://www.apache.org/licenses/LICENSE-2.0>.

## ort-wasm-simd-threaded.*

Copiés depuis \`node_modules/onnxruntime-web\` (Microsoft, **MIT**), pour que la page les serve
depuis un seul dossier, sans CDN et hors ligne.
`;

async function digestOf(path: URL): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/** Whether `name` is already there, whole. */
async function held(name: string, bytes: number, sha256: string): Promise<boolean> {
  const path = new URL(name, HERE);
  const found = await stat(path).catch(() => undefined);
  if (!found || found.size !== bytes) return false;
  return (await digestOf(path)) === sha256;
}

async function main(): Promise<void> {
  await mkdir(HERE, { recursive: true });
  if (await held(WEIGHTS.name, WEIGHTS.bytes, WEIGHTS.sha256)) {
    console.log(`${WEIGHTS.name} est déjà là.`);
  } else {
    console.log(`Téléchargement de ${WEIGHTS.name} (${(WEIGHTS.bytes / 1e6).toFixed(1)} Mo)…`);
    const answer = await fetch(WEIGHTS.from);
    if (!answer.ok) throw new Error(`${WEIGHTS.from} a répondu ${answer.status}`);
    const bytes = new Uint8Array(await answer.arrayBuffer());
    const path = new URL(WEIGHTS.name, HERE);
    await writeFile(path, bytes);
    const digest = await digestOf(path);
    if (digest !== WEIGHTS.sha256) {
      throw new Error(
        `${WEIGHTS.name} n'est pas le modèle attendu : empreinte ${digest}, attendue ${WEIGHTS.sha256}`,
      );
    }
    console.log(`${WEIGHTS.name} : ${bytes.length} octets, empreinte vérifiée.`);
  }
  for (const name of RUNTIME_FILES) {
    const from = new URL(name, RUNTIME);
    if (!(await stat(from).catch(() => undefined))) {
      throw new Error(
        `${name} est introuvable dans node_modules : lancer « npm ci » avant « npm run model »`,
      );
    }
    await copyFile(fileURLToPath(from), fileURLToPath(new URL(name, HERE)));
  }
  await writeFile(new URL('NOTICE.md', HERE), NOTICE);
  console.log(`Prêt : ${fileURLToPath(HERE)}`);
}

await main();
