# NBPIX — la méthode

`npm run dev` ouvre une page : on y dépose une image, l'outil en détoure le sujet, le met à la
taille des combattants, lui pose les pieds sur l'ancre du jeu et le ramène au grain du pixel art.
Ce qui en sort est une **sous-couche à dessiner par-dessus**, pas une planche que le jeu peut
charger. La différence est expliquée au §1.

```bash
npm run dev
```

Deux cadres, au choix dans la page :

| Cadre        | Taille               | Ce qu'il fait                             | Pour                               |
| ------------ | -------------------- | ----------------------------------------- | ---------------------------------- |
| **Planche**  | 256 px, ou 512 en HD | pose les pieds sur l'ancre du jeu         | une image de combattant en pied    |
| **Portrait** | **96 px**            | centre la tête, laisse les épaules sortir | un buste pour l'écran de sélection |

Et une **finesse** ×½ ×1 ×2 ×4 qui multiplie la taille réelle du carré sans rien changer au cadrage.
Le grain d'un pixel art n'est rien d'autre que ça : à ×4 le même cadrage est dessiné quatre fois
plus finement, à ×½ deux fois plus gros. Seul ×1 est la taille que le jeu lit ; au-delà, c'est une
sous-couche à réduire d'autant.

## 0. Ce que la source doit avoir

L'outil ne comprend rien, il mesure. Pour qu'il trouve l'ancre et l'échelle, l'image doit remplir
quatre conditions :

| Condition                                                 | Pourquoi                                                                                                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corps entier, **pieds visibles et posés** (cadre planche) | La rangée la plus basse du sujet devient la ligne des semelles. Des pieds coupés, et l'ancre est fausse. En cadre portrait, au contraire, il n'en faut pas : c'est la tête qui compte. |
| **Un seul sujet**                                         | Deux silhouettes, et la boîte englobante ne veut plus rien dire.                                                                                                                       |
| **Fond uni, ou canal alpha**                              | Sans modèle de segmentation, un fond chargé ne se détoure pas (§2).                                                                                                                    |
| **Tourné vers la droite**                                 | Convention des planches ; le moteur retourne le sprite. La case **Retourner** est là pour les autres.                                                                                  |

Un rendu Blender ou une image générée en PNG transparent remplit les quatre d'office. Une photo en
pied devant un mur uni marche aussi.

Pour une vidéo, rien n'est intégré : on en sort les images avec `ffmpeg`, puis on les passe une par
une.

```bash
ffmpeg -i mouvement.mp4 -vf fps=12 images/%03d.png
```

## 1. Ce que l'outil fait, et ce qu'il ne fait pas

**Il fait** : détourer, mesurer, mettre à l'échelle, poser sur l'ancre, réduire au grain, limiter la
palette, poser un contour. C'est-à-dire tout le travail d'alignement, qui est long à la main et que
la machine fait exactement.

**Il ne fait pas** : écrire une planche ni un portrait que le jeu charge. Les deux sont des PNG
indexés **dont les pixels sont les numéros de slots** de la palette du combattant
([docs/art/aseprite.md](https://github.com/Alex-Lou/NayosBeat/blob/main/docs/art/aseprite.md)), parce que la tenue alt est la même image avec une autre palette. Pour y arriver automatiquement, il faudrait savoir que
_ce_ gris sombre est le contour de la veste et _celui-là_ le contour du pantalon : c'est un problème
de segmentation que cet outil ne résout pas. La sortie est donc en vraies couleurs, et c'est au
dessin de la ramener dans la palette.

> **Incertitude à lever.** La sous-couche se charge aujourd'hui à la main dans Aseprite. Les
> _reference layers_ d'Aseprite acceptent sans doute une image RGB même en mode Indexé, mais ce
> n'est pas vérifié. Si ce n'est pas le cas, il faudra injecter le calque dans le gabarit
> (`tools/sprites/aseprite-template.ts` (NayosBeat), qui sait déjà poser un calque verrouillé jamais exporté),
> ce qui touche le format v3 et l'extension.

## 2. La silhouette (`src/silhouette.ts`)

Deux voies, dans cet ordre :

- **l'image le dit déjà** : assez de pixels transparents, et le canal alpha fait foi ;
- **sinon le fond est détouré** : un remplissage part des **quatre coins**, chacun gardant sa propre
  couleur de référence, et s'étend tant que la couleur reste à moins de `tolérance` de ce coin
  (ΔE en Lab).

Quatre références, donc un mur et un sol de deux couleurs différentes s'en vont tous les deux. La
référence ne bouge jamais, donc un remplissage ne peut pas dériver le long d'un bord doux jusque
dans le sujet. Et ce sont les coins, pas tout le bord, **parce que les pieds touchent souvent le bas
du cadre** : un remplissage parti des pieds mangerait le personnage.

**Un coin qui ne ressemble à aucun autre est écarté.** Un sujet qui remplit le cadre déborde dans un
coin ; y amorcer un remplissage inonde le sujet et rend une silhouette vide, et c'était la seule
façon dont cette méthode échouait sans rien dire. Un coin n'amorce donc un remplissage que si au
moins un autre coin lui ressemble (même tolérance). Si aucun ne s'accorde, les quatre servent : il
n'y a rien à en tirer, et les avertissements du §2.1 diront ce que cela a donné.

**Et les quatre coins se décochent à la main**, parce que cette règle a sa limite, et qu'un selfie
l'a montrée tout de suite : quelqu'un en chemise sombre devant un mur clair met deux coins sur le
mur et deux sur la chemise. Chaque paire s'accorde avec elle-même, la règle ne voit rien d'anormal,
et le remplissage parti de la chemise emporte les cheveux et la barbe avec elle. Aucune règle ne
peut trancher ce cas : deux coins clairs, deux coins sombres, rien ne dit lesquels sont le fond.
L'outil montre donc le choix (↖ ↗ ↙ ↘) au lieu de le deviner. Décocher les deux du bas suffit.

Ensuite le bord est nettoyé (`tidy`, une passe par défaut) : un pixel de sujet qui n'a qu'un voisin
de sujet s'en va, un pixel de fond qui en a trois rentre. Les cheveux, la fourrure et le flou de
bougé laissent exactement cette frange d'un pixel sur une photo détourée, et elle se met à grouiller
dès que l'image est réduite. Rien de plus large qu'un pixel n'est touché.

Enfin les poussières partent : le plus grand îlot est gardé, et tout îlot valant au moins `minShare`
de lui (une main détachée, une arme). Un trou à l'intérieur du sujet est gardé par construction — le
remplissage ne l'atteint jamais.

**La limite est celle de la méthode, pas un défaut** : fond uni, oui ; bibliothèque derrière le
sujet, non.

## 2.2 Le modèle, quand la couleur ne peut rien

`src/segment.ts`. Le détourage par couleur perce des trous dans la peau éclairée d'un selfie
devant un mur clair, et **aucun réglage ne les referme** (§2.3). Un modèle de segmentation ne
cherche pas une marche de couleur : il cherche à quoi ressemble une personne.

**U²-Net small** (`u2netp`), 4,6 Mo, **Apache-2.0** — Qin et al., _U²-Net: Going Deeper with Nested
U-Structure for Salient Object Detection_. Mesuré sur la photo qui mettait la couleur en échec : le
trou de la poitrine se referme entièrement, les cheveux sont nets, et les 143 îlots de poussière
disparaissent. Environ **1,5 s** dans la page, chargement du moteur compris, une fois par image.

Ce n'est **pas** un remplacement : le modèle produit un masque, et la suite ne change pas d'un
iota — même nettoyage du bord, mêmes poussières écartées (`refine`, partagé), même pinceau par
dessus, même pose, même chaîne de pixels. C'est une source de plus, au curseur **Détourage**.

### Ce que ça coûte, honnêtement

|                             |                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------- |
| Les poids                   | 4,6 Mo, **non commités** : `npm run model` les récupère, empreinte SHA-256 épinglée |
| Le moteur `onnxruntime-web` | **145 Mo** dans `node_modules`, à chaque `npm ci`, CI comprise                      |
| Ce que la page charge       | ~15 Mo de WebAssembly, à la première utilisation du modèle seulement                |

Le moteur est chargé **par import dynamique** : une page qui détoure par la couleur ne paie rien.
Le wasm et les poids vivent dans le même dossier ignoré par git, servi par Vite — pas de CDN, et ça
marche hors ligne une fois récupéré. `npm run dev` lance la récupération avant d'ouvrir la page,
donc il n'y a aucune étape à retenir ; sans les poids, la page garde la couleur et dit quoi lancer.

### Le pinceau, quand le modèle n'y est pas non plus

Sur un selfie devant un mur clair, le détourage par couleur perce des trous dans la peau éclairée.
Trois pistes ont été essayées et **mesurées** avant d'en arriver au pinceau — et c'est leur échec
qui a justifié le modèle du §2.2 :

| Piste                                                                            | Résultat                                                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| boucher les trous fermés                                                         | **inutile** : il n'y en a aucun, le fond est une seule région reliée au bord                  |
| barrage de contraste (le remplissage refuse de franchir une arête)               | **53,0 % → 53,8 % gardé.** Rien : un remplissage n'a besoin que d'un pixel faible pour passer |
| fermer les goulots (le fond atteignable par un couloir étroit n'est pas du fond) | **+0,9 %** même pour des couloirs de 48 px. Ça grignote, ça ne corrige pas                    |

La raison est qu'il n'y a rien à détecter : la peau éclairée et le mur éclairé ont **la même
couleur** et se touchent. Aucune méthode fondée sur la couleur ne les séparera, à aucun réglage.

D'où le **pinceau** : on peint du sujet ou du fond par-dessus le détourage automatique. C'est le
dernier mot — l'override est appliqué **après** le nettoyage du bord et les poussières, donc un
trait n'est jamais grignoté ni écarté. Les traits survivent à tous les autres réglages ; seule une
nouvelle image les efface, et le bouton les efface à la demande.

C'est aussi ce que fait tout vrai outil, et ce n'est pas un aveu d'échec : l'automatique fait la
masse du travail, la main corrige en trois traits. Le pinceau reste utile avec le modèle : il
corrige ce qu'aucun détourage ne devine, comme garder un accessoire ou retirer une main de trop.

## 2.1 Ce que l'outil refuse de deviner

`src/concerns.ts`. L'outil mesure, il ne comprend pas. Un portrait de studio sans pieds dans
le cadre lui donne une silhouette parfaitement propre dont le pixel le plus bas est l'ombre d'un
col — et il posera ce col sur l'ancre, mettra une tête à la hauteur d'un combattant entier, et
annoncera « pieds posés sur l'ancre » sans ciller. **Une réponse fausse et confiante est pire que
pas de réponse.** Chaque jugement qu'il ne peut pas porter est donc levé par son nom, avec le chiffre
qui l'a levé.

| Avertissement                            | Ce qu'il mesure                                       | Ce qu'il veut dire                                                                      |
| ---------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `narrow-base`                            | la base fait moins de **25 %** de la largeur du sujet | ce n'est pas des pieds : une ombre, une queue, un col. **L'ancre est une supposition.** |
| `cut-off`                                | la boîte du sujet touche un bord de l'image           | ce qui est hors cadre manque à toutes les mesures                                       |
| `nothing-kept`                           | moins d'1 % de l'image gardé                          | tolérance trop haute, ou le sujet a la couleur de son fond                              |
| `everything-kept`                        | plus de 95 % gardé                                    | le fond n'a pas été reconnu                                                             |
| `corner-dropped`                         | un coin se tenait sur le sujet                        | le sujet remplit le cadre                                                               |
| `specks` au-dessus de quelques centaines | le fond est texturé ou dégradé                        | monter la tolérance, ou décocher des coins                                              |
| `specks`                                 | plus de 3 îlots écartés                               | le détourage accroche le fond                                                           |
| `overflow`                               | le sujet sort de la case                              | la hauteur demandée est trop grande                                                     |

Ce sont des **avertissements, pas des erreurs** : chacun a un cas où il est normal, donc rien n'est
refusé. `anchorIsAGuess` regroupe ceux qui ruinent une planche, et la ligne « Pose » change alors de
mot : « base posée sur l'ancre », pas « pieds ».

**Le cadre décide de ce qui a un sens.** Un buste n'a pas de pieds et est _fait_ pour être coupé en
bas : en cadre portrait, `narrow-base`, `cut-off` par le bas et le débordement par le bas ne sont pas
levés. Les lever là apprendrait à l'œil à ignorer les avertissements, ce qui coûte plus cher que le
silence.

Et rien n'avertit qu'on a donné une silhouette entière au cadre portrait. Mesuré : un combattant en
garde est 1,4 fois plus haut que large, un buste à peu près autant — la forme ne les distingue pas
mieux qu'une pièce de monnaie. Et contrairement à une ancre fausse, un bonhomme minuscule dans le
carré est la première chose que l'aperçu montre. Un avertissement qui tombe à pile ou face, sur une
chose qu'on voit, n'apprend qu'à sauter ceux qui comptent.

## 3. La pose (`src/place.ts`)

Les deux cadres font la même chose — mettre le sujet à l'échelle et l'épingler — et ne diffèrent que
par le point épinglé :

| Cadre    | Point du sujet                                              | Point du carré                         |
| -------- | ----------------------------------------------------------- | -------------------------------------- |
| Planche  | la rangée sous les semelles, au milieu des pieds (`soleOf`) | la rangée sous l'ancre, sur sa colonne |
| Portrait | le sommet du crâne, au milieu de la bande haute (`crownOf`) | le milieu du carré, à **6 %** du haut  |

`crownOf` prend la bande haute plutôt que la boîte entière : de profil, le milieu du crâne n'est pas
le milieu du sujet, les épaules sont plus larges et d'un seul côté.

> **La colonne de l'ancre est un jugement, pas une mesure.** Sur `feline/idle`, l'ancre dessinée est
> **9 px à droite** du centroïde des pieds — 8 % de la largeur du sprite. Aucun estimateur ne la
> trouve : le centroïde de la bande basse fait −9, le milieu de son étendue −12, le centre de la
> boîte −15, le centroïde de tout le sujet −18. L'artiste ancre sur l'équilibre du personnage, pas
> sur la masse de ses pixels. Le centroïde reste le défaut parce qu'il est le moins mauvais, et le
> **décalage ←→ est fait pour ça** : c'est le seul réglage qu'il faut presque toujours toucher.

Les **96 px** du portrait sont le contrat du pipeline (`PORTRAIT_SIZE` dans
`tools/sprites/drawn.ts` (NayosBeat)). Ce module lit le disque et ne peut pas être chargé dans une page, donc
l'outil garde sa propre constante — et un test tient les deux ensemble.

Les repères dessinés sur le carré en mode portrait sont le cadrage du jeu lui-même : le centre de la
tête à **45 %** de la hauteur, la couronne vers le sixième. Ce sont des lignes à viser, l'outil
n'impose rien.

Deux règles viennent du pipeline et ne sont pas des réglages :

- la dernière rangée des pieds est sur la rangée de l'ancre (`src/art/types.ts` (NayosBeat) `ANCHOR`, rangée
  248 d'une case de 256), et le centre des pieds sur sa colonne ;
- **aucun pixel à demi transparent** ([docs/art/aseprite.md](https://github.com/Alex-Lou/NayosBeat/blob/main/docs/art/aseprite.md)) : le rééchantillonnage garde la
  couverture pour moyenner les couleurs, puis l'alpha bascule à la moitié.

Le rééchantillonnage est **par aires, en lumière linéaire, et seulement sur les pixels du sujet** :
le bord de la silhouette ne prend jamais la couleur du mur derrière. Quand la source est plus petite
que la cible, les aires tombent sous le pixel et cela devient une copie au plus proche — ce que veut
le pixel art de toute façon, rien n'est interpolé (D23).

La **hauteur debout** par défaut est de **157 px d'art** (314 sur une case HD). Ce n'est pas la
valeur de [docs/art/prompt-sprites.md](https://github.com/Alex-Lou/NayosBeat/blob/main/docs/art/prompt-sprites.md) §0 (84 px du monde, soit 168 d'art) : 157 est ce que mesure
la seule planche dessinée à la main aujourd'hui, `art-src/feline/idle.png` (NayosBeat), image 1, rangées 92 à 248. Le tableau est une cible, la planche est le dessin.

## 4. La chaîne de pixels (`src/pixelize.ts`)

Elle part de celle des décors ([docs/art/manifeste-pixel-art.md](https://github.com/Alex-Lou/NayosBeat/blob/main/docs/art/manifeste-pixel-art.md) §2, `tools/stage/sahel/adapt.ts` (NayosBeat)),
mais la mesure du §5.2 en a changé deux pièces et débranché trois étapes :

```
réduction à arêtes nettes → [Kuwahara] → [netteté] → [saturation] → contour → palette k-means Lab → [orphelins]
```

**La réduction à arêtes nettes** (`place.ts`, réglage `edge`). Une moyenne par aires est correcte et
floue : un pixel de sortie à cheval sur une arête sort la moyenne des deux côtés, une couleur qui
n'est ni l'une ni l'autre. Avec `edge > 0`, le pixel cherche d'abord la **couleur dominante** de ce
qu'il couvre — la moyenne est réestimée deux fois à partir des poids qu'elle implique — puis prend
ce côté-là. C'est l'idée du _content-adaptive downscaling_ de Kopf, Shamir et Peers (SIGGRAPH Asia 2013) sans sa machinerie EM. Mesuré : **ΔE 2,53 à 0, ΔE 0,20 à 8**.

**La palette k-means en Lab** (`pixelize.ts`, réglage `method`). La médiane coupe des boîtes en RVB,
où des distances égales ne se voient pas égales ; k-means pose ses couleurs là où l'œil les compte.
Sur un visage, c'est la différence entre une peau qui garde trois tons et une peau qui n'en garde
qu'un. Mesuré : **ΔE 1,44 pour la médiane, 0,15 pour k-means**. Graine fixe, donc même case, même
palette.

Les étapes entre crochets sont **éteintes par défaut** : la mesure dit qu'elles coûtent plus
qu'elles ne rapportent sur une source photographique. Elles restent au curseur.

Ce qu'un personnage a en plus : **le contour est dessiné sur le bord de la silhouette**, avant le
choix de la palette, pour que la médiane lui dépense un slot au lieu de l'arrondir. Ce trait sombre
d'1 px est l'essentiel de ce qui fait qu'un sprite se lit sur n'importe quel fond.

Ce qui est laissé de côté dans cette première version, et pourquoi :

- **pas de tramage.** Sur un décor il ne tourne que sur les dégradés ; sur un personnage c'est du
  bruit qui grouille dès que la caméra bouge ([docs/art/proprete.md](https://github.com/Alex-Lou/NayosBeat/blob/main/docs/art/proprete.md)). Un sprite veut des aplats.
- **pas de slots de palette.** Voir §1.
- **médiane plutôt que la méthode par superpixels.** Voir §6.

## 5. Comment les valeurs par défaut ont été choisies

Par mesure, sur une planche qu'on a déjà. `art-src/feline/idle.png` (NayosBeat), image 1, a été agrandie ×4,
posée sur un mur éclairé avec du grain, puis repassée dans la chaîne et comparée au dessin
d'origine.

Résultat : la silhouette mesure **629 px** pour 628 attendus, et la case retombe sur **314 px** de
haut, soit exactement les 157 px d'art du sprite ×2. L'échelle et l'ancre sont donc justes au pixel.

En revanche, les premiers réglages (Kuwahara 2, orphelins 2) **effaçaient l'œil et l'oreille** : à
cette taille ces détails font deux pixels, et Kuwahara, qui prend la moyenne du quadrant le plus
calme, préfère la masse de cheveux unie. D'où les valeurs retenues :

| Réglage           | Défaut            | Pourquoi                                                                                          |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| Arêtes nettes     | **8**             | ΔE 2,53 → 0,20. Le gain le plus net de toute la chaîne.                                           |
| Palette           | **k-means Lab**   | ΔE 1,44 → 0,15 contre la médiane RVB.                                                             |
| Kuwahara          | **0**             | Utile sur une peinture, destructeur sur un visage de 2 px.                                        |
| Netteté           | **0**             | ΔE 0,20 → 4,77. Le noyau à arêtes nettes fait déjà le travail ; en rajouter double la dose.       |
| Saturation        | **1**             | 1,1 est l'habitude des pixel artists (Gerstner et al. §4.4), pas de la fidélité : ΔE 0,20 → 0,80. |
| Contour           | 70 % de la clarté | ΔE 0,20 → 0,26. Presque gratuit, et c'est ce qui fait lire un sprite.                             |
| Couleurs          | 32                | À 16, ΔE 0,78 ; à 64, 0,23 — rien à gagner au-delà.                                               |
| Orphelins         | **0**             | ΔE 0,26 → 3,62. Du nettoyage, pas de la fidélité : à monter sur une photo bruitée.                |
| Nettoyage du bord | 1 passe           | Enlève la frange d'un pixel des cheveux sans toucher aux vraies formes.                           |

### Le seuil de `narrow-base`

Mesuré sur les deux cas sous la main : la planche sur un mur plante ses pieds sur **94 %** de sa
largeur, le portrait pose son col sur **5 %**. Un quart passe loin des deux, et du bon côté — celui
qui laisse un combattant se tenir les pieds joints.

## 5.2 Mesurer la fidélité, et ce que ça a corrigé

Le même faux-photo, mais agrandi **au plus proche voisin** : chaque pixel du sprite devient un bloc
net de 4 × 4, donc une chaîne qui ne perd rien doit rendre le dessin **exactement**. Le score est le
ΔE moyen en Lab sur les pixels que les deux disent opaques. Sous 1, deux couleurs ne se distinguent
qu'à l'œil exercé, côte à côte.

Trois choses sont sorties de là, dans cet ordre :

1. **La mesure elle-même était fausse d'abord.** Le premier faux-photo était agrandi en
   _bilinéaire_ : le détail fin du sprite y était déjà détruit avant d'entrer dans l'outil, et le
   ΔE de 24 mesurait cette destruction, pas la chaîne. Un agrandissement au plus proche voisin a
   rendu la mesure honnête.
2. **Puis le décalage de l'ancre a tout masqué.** ΔE 25 encore, identique quel que soit le noyau ou
   la palette — parce que le sprite sortait **9 px trop à droite** (§3). Un ΔE par pixel sur un
   dessin détaillé ne mesure plus rien dès qu'il y a un décalage. Corrigé : ΔE 2,53.
3. **Alors seulement les vraies différences sont apparues.**

| Étape ajoutée             | ΔE, noyau moyenne | ΔE, noyau arêtes nettes |
| ------------------------- | ----------------- | ----------------------- |
| réduction seule           | 2,53              | **0,20**                |
| + netteté 0,7             | 4,41              | 4,77                    |
| + saturation 1,1          | 2,98              | 0,80                    |
| + contour 70 %            | 2,59              | 0,26                    |
| + palette 32, médiane RVB | 4,05              | 1,44                    |
| + palette 32, k-means Lab | 2,82              | **0,15**                |
| + orphelins 1             | 6,83              | 3,62                    |

**Bilan : ΔE 7,89 avant, 0,16 après.** `tests/roto.test.ts` refabrique ce faux-photo et
refuse une chaîne qui repasse au-dessus de 1 — et un second test vérifie que les anciens réglages,
eux, dépassent 5, pour que le test ne puisse pas passer par accident.

**Ce que cette mesure ne dit pas.** C'est un meilleur cas synthétique : du pixel art agrandi
proprement sur un mur uni. Sur une vraie photo il n'y a pas de « bonne réponse », et des étapes qui
coûtent en fidélité (netteté, orphelins) peuvent aider à la **lisibilité**. La mesure sert à ne pas
perdre ce qui est là ; elle ne dit pas ce qui est beau.

## 5.1 Un cas réel, de bout en bout

Un selfie : mur blanc crépi, **grosse ombre portée** à droite, chemise noire qui touche les deux
coins du bas, épaules coupées par le cadre. Ce que l'outil a fait, dans l'ordre :

| Réglage                               | Ce qui s'est passé                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tolérance 14, quatre coins            | L'ombre du mur est **gardée comme sujet** : trop loin du blanc pour que le remplissage la traverse. 818 îlots écartés, l'outil le dit.                             |
| tolérance 32, quatre coins            | L'ombre part, **mais la barbe, les cheveux et la chemise aussi** : les coins du bas sont sur la chemise noire et leur remplissage dévore toutes les zones sombres. |
| tolérance 30, coins du haut seulement | Le mur **et** son ombre partent, le sujet reste entier.                                                                                                            |

Il reste un trou sous le menton : la peau éclairée du cou passe sous la tolérance et rejoint le
mur. C'est la limite de la méthode (§2), pas un réglage à trouver.

## 5.3 Le verdict du pipeline

`src/rules.ts`. Le dépôt a déjà un moteur de règles — `checkDrawn`, celui que
`npm run sprites` applique et que l'extension Aseprite reflète. Plutôt que d'en écrire un sosie, la
page fait passer **sa propre sortie par ce moteur-là**. Ce que l'outil annonce est donc ce que le
pipeline dira, maintenant et après que les règles auront changé : rien à tenir en phase à la main.

Pour que ce soit possible, `checkDrawn` et `DrawnRules` ont été sortis de `drawn.ts` (qui lit le
disque) dans `tools/sprites/drawn-rules.ts` (NayosBeat), qui ne touche ni disque ni moteur. `drawn.ts` les
réexporte : aucun appelant ne change.

Seules les règles **géométriques** peuvent s'appliquer, la sortie étant en vraies couleurs (§1) :
taille du carré, image non vide, **4 px de marge** sur les bords gauche, droit et haut, rien sous la
rangée du sol. La marge est la plus utile : c'est une vraie règle, plus stricte que « le sujet
tient-il dans la case », et celle qu'un sujet rotoscopé enfreint le plus souvent. Un carré dessiné
plus fin (finesse ×2, ×4) est tenu aux mêmes règles à son échelle : 4 px de marge à ×1 font 8 px à
×2, parce que ce sont les mêmes 2 pixels du monde.

## 6. La suite, si cela vaut le coup

**La méthode par superpixels.** Gerstner, DeCarlo, Alexa, Finkelstein, Gingold et Nealen,
_Pixelated Image Abstraction_ (NPAR 2012), optimisent **ensemble** le découpage de l'image et la
palette, au lieu de réduire puis quantifier. Leur étude utilisateur la donne meilleure que la
méthode naïve. Les paramètres du papier, pour le jour où :

- superpixels initialisés sur une grille régulière, un par pixel de sortie ; SLIC modifié,
  `d = dc + m·√(N/M)·dp` en Lab avec **m = 45** (SLIC seul conseille 10), la couleur d'un superpixel
  étant **sa couleur de palette**, pas sa moyenne — c'est là toute l'astuce ;
- lissage laplacien des centres, **40 %** vers la moyenne des 4 voisins, puis filtre bilatéral sur
  les couleurs représentatives ;
- palette par recuit déterministe à masse contrainte : `T₀ = 1,1·Tc`, `α = 0,7`, `Tf = 1`,
  `P(ck|ps) ∝ P(ck)·e^(−‖ms′−ck‖/T)`, séparation des sous-clusters le long de l'axe principal ;
- **carte d'importance** (§4.5) : `P(ps)` pondéré par l'importance moyenne des pixels du superpixel.
  C'est exactement là que **notre silhouette se branche** — le sujet important, le reste non.

**Les slots de palette**, si la segmentation par matériau devient faisable.

**Désigner le fond au clic.** Les coins se décochent déjà (§2) et le pinceau rattrape le reste. Un
clic pour amorcer un remplissage à un endroit choisi reste le chaînon manquant quand le fond ne
touche aucun coin.

**Les séquences.** Une planche entière, pas une image : le nombre d'images vient de
`src/art/<perso>/sheets.ts` (NayosBeat), et il faudra une palette figée pour toute la planche et un ancrage
repris image par image, sinon le résultat grouille.

## 7. Ce qui n'est pas la solution

Il existe une famille célèbre d'algorithmes « pixel art » — EPX / Scale2x, HQ2x/3x/4x (Maxim
Stepin, 2003), xBR et xBRZ (Hyllian, 2011) — et ils ne servent à rien ici. Ils **agrandissent** du
pixel art existant en devinant des diagonales lisses là où il y avait des escaliers : c'est le
problème inverse du nôtre, qui est de **réduire** une image riche en pixel art. Les appliquer
reviendrait à lisser ce qu'on vient de fabriquer.

Côté Apple, il n'y a pas de recette cachée. Ce qu'Apple fait et qui compte vraiment, le jeu le fait
déjà : **mise à l'échelle par nombres entiers** (le @2x/@3x des écrans Retina) et **plus proche
voisin** à l'affichage (`image-rendering: pixelated`, que WebKit respecte). Rien d'autre. Pixelmator,
racheté par Apple, a bien un agrandisseur par apprentissage (_ML Super Resolution_) — mais sa propre
documentation renvoie au plus proche voisin pour le pixel art : Super Resolution lisse précisément
ce qu'on veut garder dur.

La vraie littérature utile est celle de la **réduction** : Kopf, Shamir et Peers 2013 (reprise au
§4), Öztireli et Gross 2015 (réduction optimisée sur une métrique perceptuelle, SSIM), et Gerstner
et al. 2012 pour la palette (§6).

## Sources

- Gerstner, DeCarlo, Alexa, Finkelstein, Gingold, Nealen, _Pixelated Image Abstraction_, NPAR 2012 —
  <https://pixl.cs.princeton.edu/pubs/Gerstner_2012_PIA/index.php>
- Version journal, _Pixelated image abstraction with integrated user constraints_, Computers &
  Graphics 37(5) — <http://www.nealen.net/papers/pixelated_image_abstraction-journal.pdf>
- MakeItPixel, le détail d'un convertisseur libre (réduction, quantification, tramage) —
  <https://github.com/MiguelMJ/MakeItPixel/wiki/Process>
- Kopf, Shamir, Peers, _Content-Adaptive Image Downscaling_, SIGGRAPH Asia 2013 —
  <https://johanneskopf.de/publications/downscaling/>
- Öztireli, Gross, _Perceptually Based Downscaling of Images_, SIGGRAPH 2015 —
  <https://www.cl.cam.ac.uk/~aco41/Files/Sig15PerceptualDownscaling.pdf>
- Les algorithmes d'agrandissement de pixel art (EPX, HQx, xBR), pour mémoire —
  <https://en.wikipedia.org/wiki/Pixel-art_scaling_algorithms>
- Pixelmator, _Super Resolution_, et son renvoi au plus proche voisin pour le pixel art —
  <https://support.pixelmator.com/photomator-user-guide/ai-editing-tools/super-resolution>
- Qin, Zhang, Huang, Dehghan, Zaiane, Jagersand, _U²-Net_, Pattern Recognition 2020 —
  <https://github.com/xuebinqin/U-2-Net> (Apache-2.0)
