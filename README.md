# NBPIX

Une image entre, un **sprite** sort — détouré, mis à l'échelle, posé au bon endroit dans sa case et
ramené au grain du pixel art. Fait pour [NayosBeat](https://github.com/Alex-Lou/NayosBeat), dont il
respecte les formats.

```bash
npm ci
npm run dev
```

La première fois, `npm run dev` télécharge 4,6 Mo de poids et copie le moteur WebAssembly dans
`model/` (ignoré par git). Ensuite c'est instantané. Puis la page s'ouvre : dépose une image.

## Ce qu'il fait

- **Détourer** le sujet, par la couleur (un remplissage depuis les coins, en Lab) ou par un
  **modèle de segmentation** quand la couleur ne suffit pas — une peau éclairée devant un mur
  éclairé n'a aucune marche de couleur à trouver.
- **Corriger à la main** au pinceau ce qu'aucun automatisme ne devine.
- **Poser** le sujet dans le format voulu : les pieds sur l'ancre d'une planche, la tête centrée
  pour un buste, ou simplement centré pour un objet. Planche 256, HD 512, portrait 96, objets de
  16 × 16 à 128 × 128 — et le bouton **Remplir** trouve la hauteur qui tient dans la boîte.
- **Pixeliser** : réduction à arêtes nettes, palette k-means en Lab, contour, grain réglable de ×½
  à ×4.
- **Dire ce qu'il ne sait pas**, par son nom et avec le chiffre qui l'a levé, plutôt que de rendre
  une réponse fausse et confiante.
- **Vérifier** sa sortie avec le moteur de règles de NayosBeat lui-même.

Tout est mesuré, pas réglé à l'œil : [`docs/methode.md`](docs/methode.md) donne les chiffres, les
sources et les essais qui ont échoué.

## Ce qu'il ne fait pas encore

Il rend une image en **vraies couleurs**, à dessiner par-dessus. Une planche que le jeu charge est
un PNG indexé dont les pixels sont les **numéros de slots** de la palette d'un combattant — c'est
le prochain chantier.

## Le contrat de NayosBeat

Les formats du jeu (taille de case, ancre, marges, portrait) sont copiés dans
[`src/game/contract.ts`](src/game/contract.ts). **Rien ne force les deux dépôts à rester en
phase** : si le jeu change un de ces chiffres, il faut le changer ici aussi. Un test les énonce un
par un pour qu'une dérive soit un test rouge et non un sprite qui tombe de travers.

## Développer

|                 |                                                        |
| --------------- | ------------------------------------------------------ |
| `npm run dev`   | la page, modèle compris                                |
| `npm test`      | la suite (52 tests)                                    |
| `npm run check` | ce que la CI lance : format, lint, types, tests, build |

## Licences

Le code est à Alex Lou. Les poids du modèle, téléchargés et non commités, sont ceux d'**U²-Net**
(Qin et al.) sous **Apache-2.0** ; `model/NOTICE.md` porte l'attribution. Le moteur est
**onnxruntime-web** (Microsoft, MIT).

`tests/fixtures/idle.png` est une planche de NayosBeat, gardée comme vérité terrain : la chaîne
doit savoir la retrouver à un ΔE inférieur à 1.
