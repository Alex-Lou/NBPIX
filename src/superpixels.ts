/**
 * La moitié « découpe » de l'abstraction (Gerstner et al. §4.2) : quels pixels de la source
 * forment quel pixel de la sortie.
 *
 * Trois écarts au SLIC d'origine, et c'est là que tout se joue :
 * 1. la couleur d'un superpixel est celle de sa couleur de palette, pas sa moyenne — sinon les
 *    pixels se regroupent sur des couleurs qui n'existeront pas dans l'image finale ;
 * 2. un lissage laplacien ramène le voisinage hexagonal de SLIC sur la grille rectangulaire de la
 *    sortie, sans quoi les formes se tordent ;
 * 3. un filtre bilatéral garde continus les dégradés, qui sinon cassent en marches.
 *
 * Les tampons vivent dans la fermeture : un pas est appelé quelques centaines de fois, et les
 * réallouer à chaque fois coûterait plus que le calcul lui-même.
 */

import { toLab } from './game/lab.ts';
import type { Bitmap, Box } from './pixels.ts';
import { widthOf } from './pixels.ts';

/** Le papier prend 45 là où SLIC prend 10 : la palette porte l'erreur de couleur, donc on tient à
 * des superpixels de taille régulière. */
const COMPACTNESS = 45;

/** Part du chemin parcourue vers la moyenne des 4 voisins, à chaque pas. */
const LAPLACIAN = 0.4;

const BLUR_REACH = 2;
const BLUR_SPACE = 1.5;
const BLUR_RANGE = 12;

export type Lab = readonly [number, number, number];

/** La source ramenée à une taille qui tient le coût, en Lab, le sujet marqué. */
export interface Source {
  readonly width: number;
  readonly height: number;
  readonly lab: Float32Array;
  readonly on: Uint8Array;
}

/**
 * La boîte du sujet rééchantillonnée à au plus `maxW × maxH`, au plus proche voisin — moyenner
 * mêlerait le sujet au fond sur tout le contour, et c'est ce bord qu'on veut franc.
 */
export function sourceOf(
  image: Bitmap,
  on: Uint8Array,
  box: Box,
  maxW: number,
  maxH: number,
): Source {
  const inW = widthOf(box);
  const inH = box.bottom - box.top + 1;
  const width = Math.max(1, Math.min(inW, Math.round(maxW)));
  const height = Math.max(1, Math.min(inH, Math.round(maxH)));
  const lab = new Float32Array(width * height * 3);
  const kept = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = box.top + Math.min(inH - 1, Math.floor(((y + 0.5) * inH) / height));
    for (let x = 0; x < width; x++) {
      const sx = box.left + Math.min(inW - 1, Math.floor(((x + 0.5) * inW) / width));
      const from = sy * image.width + sx;
      const at = y * width + x;
      if ((on[from] ?? 0) === 0) continue;
      kept[at] = 1;
      const [L, A, B] = toLab(
        image.data[from * 4] ?? 0,
        image.data[from * 4 + 1] ?? 0,
        image.data[from * 4 + 2] ?? 0,
      );
      lab[at * 3] = L;
      lab[at * 3 + 1] = A;
      lab[at * 3 + 2] = B;
    }
  }
  return { width, height, lab, on: kept };
}

export interface Superpixels {
  /** La couleur représentative de chaque superpixel, filtrée : trois flottants par cellule. */
  readonly colors: Float64Array;
  /** Combien de pixels de source chaque superpixel a récoltés ; 0 signifie vide. */
  readonly weight: Float64Array;
  /** Un pas, d'après la couleur de palette actuellement associée à chaque superpixel. */
  readonly step: (palette: readonly Lab[], mine: Int32Array) => void;
}

export function superpixelsOn(source: Source, outW: number, outH: number): Superpixels {
  const cells = outW * outH;
  const stepX = source.width / outW;
  const stepY = source.height / outH;
  const spatial = (COMPACTNESS / Math.max(1e-6, Math.max(stepX, stepY))) ** 2;
  const reachX = Math.ceil(stepX);
  const reachY = Math.ceil(stepY);

  const centreX = new Float64Array(cells);
  const centreY = new Float64Array(cells);
  const wasX = new Float64Array(cells);
  const wasY = new Float64Array(cells);
  const mean = new Float64Array(cells * 3);
  const colors = new Float64Array(cells * 3);
  const weight = new Float64Array(cells);
  const sumX = new Float64Array(cells);
  const sumY = new Float64Array(cells);
  const owner = new Int32Array(source.width * source.height);
  const best = new Float64Array(source.width * source.height);

  for (let sy = 0; sy < outH; sy++) {
    for (let sx = 0; sx < outW; sx++) {
      centreX[sy * outW + sx] = (sx + 0.5) * stepX;
      centreY[sy * outW + sx] = (sy + 0.5) * stepY;
    }
  }

  function assign(palette: readonly Lab[], mine: Int32Array): void {
    owner.fill(-1);
    best.fill(Infinity);
    for (let s = 0; s < cells; s++) {
      const colour = palette[mine[s] ?? 0] ?? [0, 0, 0];
      const cx = centreX[s] ?? 0;
      const cy = centreY[s] ?? 0;
      const fromY = Math.max(0, Math.floor(cy - reachY));
      const toY = Math.min(source.height - 1, Math.ceil(cy + reachY));
      const fromX = Math.max(0, Math.floor(cx - reachX));
      const toX = Math.min(source.width - 1, Math.ceil(cx + reachX));
      for (let y = fromY; y <= toY; y++) {
        for (let x = fromX; x <= toX; x++) {
          const at = y * source.width + x;
          if ((source.on[at] ?? 0) === 0) continue;
          const dL = (source.lab[at * 3] ?? 0) - colour[0];
          const dA = (source.lab[at * 3 + 1] ?? 0) - colour[1];
          const dB = (source.lab[at * 3 + 2] ?? 0) - colour[2];
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          const d = dL * dL + dA * dA + dB * dB + spatial * (dx * dx + dy * dy);
          if (d >= (best[at] ?? Infinity)) continue;
          best[at] = d;
          owner[at] = s;
        }
      }
    }
  }

  function gather(): void {
    mean.fill(0);
    weight.fill(0);
    sumX.fill(0);
    sumY.fill(0);
    for (let at = 0; at < owner.length; at++) {
      const s = owner[at] ?? -1;
      if (s < 0) continue;
      mean[s * 3] = (mean[s * 3] ?? 0) + (source.lab[at * 3] ?? 0);
      mean[s * 3 + 1] = (mean[s * 3 + 1] ?? 0) + (source.lab[at * 3 + 1] ?? 0);
      mean[s * 3 + 2] = (mean[s * 3 + 2] ?? 0) + (source.lab[at * 3 + 2] ?? 0);
      sumX[s] = (sumX[s] ?? 0) + ((at % source.width) + 0.5);
      sumY[s] = (sumY[s] ?? 0) + (Math.floor(at / source.width) + 0.5);
      weight[s] = (weight[s] ?? 0) + 1;
    }
    for (let s = 0; s < cells; s++) {
      const n = weight[s] ?? 0;
      if (n === 0) continue;
      mean[s * 3] = (mean[s * 3] ?? 0) / n;
      mean[s * 3 + 1] = (mean[s * 3 + 1] ?? 0) / n;
      mean[s * 3 + 2] = (mean[s * 3 + 2] ?? 0) / n;
      centreX[s] = (sumX[s] ?? 0) / n;
      centreY[s] = (sumY[s] ?? 0) / n;
    }
  }

  function relax(): void {
    wasX.set(centreX);
    wasY.set(centreY);
    for (let sy = 0; sy < outH; sy++) {
      for (let sx = 0; sx < outW; sx++) {
        const s = sy * outW + sx;
        let aroundX = 0;
        let aroundY = 0;
        let count = 0;
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = sx + dx;
          const ny = sy + dy;
          if (nx < 0 || ny < 0 || nx >= outW || ny >= outH) continue;
          aroundX += wasX[ny * outW + nx] ?? 0;
          aroundY += wasY[ny * outW + nx] ?? 0;
          count++;
        }
        if (count === 0) continue;
        const homeX = (sx + 0.5) * stepX;
        const homeY = (sy + 0.5) * stepY;
        const pulledX = (wasX[s] ?? 0) + LAPLACIAN * (aroundX / count - (wasX[s] ?? 0));
        const pulledY = (wasY[s] ?? 0) + LAPLACIAN * (aroundY / count - (wasY[s] ?? 0));
        // Un centre qui quitterait sa case ferait recouvrir deux superpixels.
        centreX[s] = Math.max(homeX - stepX, Math.min(homeX + stepX, pulledX));
        centreY[s] = Math.max(homeY - stepY, Math.min(homeY + stepY, pulledY));
      }
    }
  }

  function bilateral(): void {
    for (let sy = 0; sy < outH; sy++) {
      for (let sx = 0; sx < outW; sx++) {
        const s = sy * outW + sx;
        if ((weight[s] ?? 0) === 0) {
          colors.set(mean.subarray(s * 3, s * 3 + 3), s * 3);
          continue;
        }
        let L = 0;
        let A = 0;
        let B = 0;
        let total = 0;
        for (let dy = -BLUR_REACH; dy <= BLUR_REACH; dy++) {
          const ny = sy + dy;
          if (ny < 0 || ny >= outH) continue;
          for (let dx = -BLUR_REACH; dx <= BLUR_REACH; dx++) {
            const nx = sx + dx;
            if (nx < 0 || nx >= outW) continue;
            const n = ny * outW + nx;
            if ((weight[n] ?? 0) === 0) continue;
            const dL = (mean[n * 3] ?? 0) - (mean[s * 3] ?? 0);
            const dA = (mean[n * 3 + 1] ?? 0) - (mean[s * 3 + 1] ?? 0);
            const dB = (mean[n * 3 + 2] ?? 0) - (mean[s * 3 + 2] ?? 0);
            const weighted =
              (SPACE_WEIGHT[(dy + BLUR_REACH) * BLUR_SIDE + (dx + BLUR_REACH)] ?? 0) *
              Math.exp(-(dL * dL + dA * dA + dB * dB) / (2 * BLUR_RANGE * BLUR_RANGE));
            L += weighted * (mean[n * 3] ?? 0);
            A += weighted * (mean[n * 3 + 1] ?? 0);
            B += weighted * (mean[n * 3 + 2] ?? 0);
            total += weighted;
          }
        }
        colors[s * 3] = total > 0 ? L / total : (mean[s * 3] ?? 0);
        colors[s * 3 + 1] = total > 0 ? A / total : (mean[s * 3 + 1] ?? 0);
        colors[s * 3 + 2] = total > 0 ? B / total : (mean[s * 3 + 2] ?? 0);
      }
    }
  }

  return {
    colors,
    weight,
    step: (palette, mine) => {
      assign(palette, mine);
      gather();
      relax();
      bilateral();
    },
  };
}

const NEIGHBOURS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

const BLUR_SIDE = 2 * BLUR_REACH + 1;

/** Le terme spatial du filtre bilatéral ne dépend que du décalage : calculé une fois. */
const SPACE_WEIGHT = (() => {
  const table = new Float64Array(BLUR_SIDE * BLUR_SIDE);
  for (let dy = -BLUR_REACH; dy <= BLUR_REACH; dy++) {
    for (let dx = -BLUR_REACH; dx <= BLUR_REACH; dx++) {
      table[(dy + BLUR_REACH) * BLUR_SIDE + (dx + BLUR_REACH)] = Math.exp(
        -(dx * dx + dy * dy) / (2 * BLUR_SPACE * BLUR_SPACE),
      );
    }
  }
  return table;
})();
