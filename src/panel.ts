/**
 * Le panneau de réglages : quels widgets, dans quel ordre, branchés sur quel morceau de l'état.
 * Rien d'autre — il ne connaît ni la chaîne, ni les toiles, ni ce que les valeurs veulent dire.
 *
 * L'ordre est le propos : le style et l'enregistrement en tête, parce que ce sont les deux seules
 * choses nécessaires pour obtenir un sprite ; tout le reste sert à affiner, et se replie.
 */

import type { Controls } from './controls.ts';
import { state } from './page-state.ts';
import type { Corners } from './silhouette.ts';
import { STYLES } from './style.ts';
import { maxZoom } from './view.ts';

export interface PanelParts {
  readonly about: HTMLElement;
  readonly clear: HTMLButtonElement;
  readonly fit: HTMLButtonElement;
  readonly save: HTMLButtonElement;
  readonly chooseStyle: (index: number) => void;
  readonly chooseSource: (value: number) => void;
}

const CORNERS: readonly { key: keyof Corners; mark: string; title: string }[] = [
  { key: 'topLeft', mark: '↖', title: 'Partir du coin haut gauche' },
  { key: 'topRight', mark: '↗', title: 'Partir du coin haut droit' },
  { key: 'bottomLeft', mark: '↙', title: 'Partir du coin bas gauche' },
  { key: 'bottomRight', mark: '↘', title: 'Partir du coin bas droit' },
];

export function panelOn(ui: Controls, parts: PanelParts): readonly HTMLElement[] {
  return [
    // Le seul choix nécessaire pour obtenir quelque chose, et le bouton qui sort le résultat. Tout le
    // reste sert à affiner : replié, pour que la page s'ouvre sur une décision et non sur vingt.
    ui.choice(
      'Style',
      () => STYLES.indexOf(state.style),
      parts.chooseStyle,
      STYLES.map((style, index) => ({ value: index, label: style.name })),
    ),
    // La ligne qui dit ce que ce style impose commente le choix : elle le suit, elle ne le précède pas.
    parts.about,
    parts.save,
    ui.fold('Réglages fins', [
      ui.group('Silhouette', [
        ui.range(
          'Tolérance du fond',
          () => state.tolerance,
          (v) => (state.tolerance = v),
          {
            min: 0,
            max: 60,
            step: 1,
          },
        ),
        ui.range(
          'Poussières ignorées',
          () => state.minShare,
          (v) => (state.minShare = v),
          { min: 0, max: 0.2, step: 0.005 },
          (value) => `${Math.round(value * 100)} %`,
        ),
        ui.range(
          'Nettoyage du bord',
          () => state.tidy,
          (v) => (state.tidy = v),
          { min: 0, max: 3, step: 1 },
          (value) => (value === 0 ? 'aucun' : `${value} passe(s)`),
        ),
        ui.choice('Détourage', () => (state.source === 'model' ? 1 : 0), parts.chooseSource, [
          { value: 0, label: 'par la couleur' },
          { value: 1, label: 'par le modèle' },
        ]),
        ui.range(
          'Seuil du modèle',
          () => state.floor,
          (v) => (state.floor = v),
          { min: 0.05, max: 0.95, step: 0.05 },
          (value) => `${Math.round(value * 100)} %`,
        ),
        ui.toggles(
          'Coins de départ',
          CORNERS,
          (key) => state.corners[key],
          (key, value) => (state.corners = { ...state.corners, [key]: value }),
        ),
      ]),
      ui.group('Pinceau', [
        ui.choice(
          'Le trait pose',
          () => state.brush,
          (v) => (state.brush = v === 1 ? 1 : -1),
          [
            { value: 1, label: 'du sujet' },
            { value: -1, label: 'du fond' },
          ],
        ),
        ui.range(
          'Taille',
          () => state.radius,
          (v) => (state.radius = v),
          { min: 4, max: 120, step: 2 },
          (value) => `${value * 2} px`,
        ),
        parts.clear,
      ]),
      ui.group('Pose', [
        ui.range(
          'Hauteur du sujet',
          () => state.height,
          (v) => (state.height = v),
          { min: 2, max: 512, step: 1 },
          (value) => `${value} px`,
        ),
        parts.fit,
        ui.check(
          'Retourner (doit regarder à droite)',
          () => state.flip,
          (v) => (state.flip = v),
        ),
        ui.choice(
          'Finesse',
          () => state.finesse * 100,
          (v) => (state.finesse = v / 100),
          [
            { value: 50, label: '×½ (gros grain)' },
            { value: 100, label: '×1 (taille du jeu)' },
            { value: 200, label: '×2' },
            { value: 400, label: '×4 (très fin)' },
          ],
        ),
        ui.range(
          'Décalage ←→',
          () => state.nudgeX,
          (v) => (state.nudgeX = v),
          {
            min: -80,
            max: 80,
            step: 1,
          },
        ),
        ui.range(
          'Décalage ↑↓',
          () => state.nudgeY,
          (v) => (state.nudgeY = v),
          {
            min: -80,
            max: 80,
            step: 1,
          },
        ),
      ]),
      ui.group('Pixels', [
        ui.range(
          'Arêtes nettes',
          () => state.edge,
          (v) => (state.edge = v),
          { min: 0, max: 40, step: 1 },
          (value) => (value === 0 ? 'moyenne' : String(value)),
        ),
        ui.choice(
          'Palette',
          () => (state.method === 'kmeans' ? 1 : 0),
          (v) => (state.method = v === 1 ? 'kmeans' : 'median'),
          [
            { value: 1, label: 'k-means Lab' },
            { value: 0, label: 'médiane RVB' },
          ],
        ),
        ui.range(
          'Kuwahara',
          () => state.kuwahara,
          (v) => (state.kuwahara = v),
          {
            min: 0,
            max: 4,
            step: 1,
          },
        ),
        ui.range(
          'Netteté',
          () => state.sharpen,
          (v) => (state.sharpen = v),
          {
            min: 0,
            max: 2,
            step: 0.1,
          },
        ),
        ui.range(
          'Saturation',
          () => state.saturation,
          (v) => (state.saturation = v),
          {
            min: 1,
            max: 1.6,
            step: 0.05,
          },
        ),
        ui.range(
          'Contour',
          () => state.outline,
          (v) => (state.outline = v),
          { min: 0.3, max: 1, step: 0.05 },
          (value) => (value >= 1 ? 'aucun' : `${Math.round(value * 100)} %`),
        ),
        ui.range(
          'Couleurs',
          () => state.colors,
          (v) => (state.colors = v),
          { min: 0, max: 64, step: 1 },
          (value) => (value === 0 ? 'toutes' : String(value)),
        ),
        ui.range(
          'Orphelins',
          () => state.orphans,
          (v) => (state.orphans = v),
          {
            min: 0,
            max: 4,
            step: 1,
          },
        ),
      ]),
      ui.group('Affichage', [
        ui.range(
          'Zoom',
          () => state.zoom,
          // Le zoom automatique vaut ×28 sur une case de 16 px : le curseur doit pouvoir aller bien
          // au-delà de ×4 pour servir à quelque chose, et s'arrêter avant la toile que le navigateur
          // refuserait d'allouer.
          (v) => (state.zoom = Math.min(v, maxZoom(state.zoomedFor ?? 1))),
          { min: 1, max: 32, step: 1 },
          (value) => `×${value}`,
        ),
        ui.check(
          'Repères',
          () => state.guides,
          (v) => (state.guides = v),
        ),
      ]),
    ]),
  ];
}
