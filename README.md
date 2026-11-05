# EditGo

Création automatique de films souvenirs à partir des photos et vidéos d'un téléphone, d'un dossier du PC ou d'un dossier Google Drive synchronisé. Tout est calculé sur l'appareil : aucun fichier n'est envoyé en ligne, et l'application fonctionne hors ligne après la première visite (PWA).

En ligne : **https://engob.github.io/EditGo/** (déployé automatiquement par `.github/workflows/deploy.yml` à chaque push sur `main`).
Version autonome en un seul fichier : **https://engob.github.io/EditGo/editgo-hors-ligne.html** (à enregistrer et ouvrir sans connexion).

## Ce que fait l'application

**Import et analyse**
- Fichiers, dossier complet (sous-dossiers compris) ou glisser-déposer. Pour Google Drive : choisir le dossier « Google Drive » synchronisé sur le PC.
- Chronologie : date EXIF des photos, date de tournage des vidéos (QuickTime / MP4, fuseau Apple compris), sinon date dans le nom du fichier (`IMG_20240512_…`, `PXL_…`, WhatsApp), sinon date du fichier.
- Doublons stricts ignorés (empreinte SHA-256 du contenu).
- Quasi-doublons regroupés, réglables : rafales, copies recompressées (dHash + signature 16×16), vidéos Live Photo. La meilleure image du groupe est gardée ; « Garder aussi » réintègre une image.
- Score de qualité (netteté, exposition, contraste, couleurs) et point d'intérêt pour le cadrage.

**Projets**
- Enregistrement automatique sur l'appareil (IndexedDB + copie locale des médias, dédupliquée) : on rouvre un projet sans rien réimporter.
- Panneau « Projets » : reprendre, renommer, supprimer ; exporter / importer un projet en `.editgo.json` (les médias absents se réassocient en réimportant le dossier).

**Montage automatique**
- Deux constructions : **Tous les médias** (par défaut — chaque photo et chaque vidéo en entier, durée naturelle affichée avant création) ou **Meilleurs moments** (sélection pour 30 s à 5 min).
- Durée du film ajustable après coup : curseur, durée exacte (ex. `2:30`), ±10 %, calage sur la longueur du morceau ; les proportions sont conservées et une vidéo ne dépasse jamais sa longueur réelle.
- Découpage en moments (écart de temps réglable), titres de chapitres datés.
- 6 ambiances : Cinéma, Douceur, Énergie, Argentique, Noir & blanc, Épure (étalonnage, transitions, titrage, rythme, musique).
- Coupes calées sur le tempo de la musique.

**Mosaïques (2 à 4 photos sur une même image)**
- Regroupement automatique (réglage Jamais / Automatique / Souvent) : les portraits dans un film paysage (ou l'inverse) sont réunis entre eux ou avec leur voisine la plus proche dans le temps, les photos secondaires prises à quelques minutes d'écart sont regroupées, les plus belles photos restent en plein cadre.
- Disposition choisie automatiquement pour rogner le moins possible (côte à côte, superposées, grande + petites, grille, colonnes…), recalculée si le format du film change ; cases arrondies sur fond flouté, apparition décalée, léger mouvement dans chaque case.
- À la main : déposer une vignette sur une autre dans le storyboard pour les réunir ; dans l'inspecteur, choisir la disposition, changer l'ordre, retirer une photo, ajouter la suivante ou tout séparer.

**Replacer une photo ou une vidéo**
- Storyboard : vignettes numérotées à glisser-déposer (appui long sur écran tactile).
- Dans l'inspecteur : flèches plus tôt / plus tard, numéro de position, date de prise de vue modifiable et « Replacer selon la date ».
- Sur la page Médias, clic sur l'heure d'une vignette pour corriger sa date ; « Trier par date » remet tout le montage dans l'ordre chronologique. Raccourci : Alt + ← / →.

**Édition**
- Timeline : réordonner par glisser, rogner la durée ou le point d'entrée d'une vidéo depuis les bords, couper à la tête de lecture, cartons-titres.
- Par plan : durée, 12 transitions, mouvement Ken Burns, cadrage (remplir / fond flou / entier), titre (6 styles animés), vitesse et volume des vidéos.
- Étalonnage (8 looks), halo, vignettage, grain, bandes cinéma 2,39:1, formats 16:9, 9:16, 1:1, 4:5, 21:9.
- Musique originale générée sur l'appareil (3 ambiances) ou morceau importé (tempo détecté), atténuation automatique pendant les vidéos.
- Annuler / rétablir, raccourcis (Espace, ← →, Maj+← →, Suppr, Ctrl+Z).

**Export**
- Rendu image par image (non temps réel) via WebCodecs : MP4 (H.264, sinon HEVC / VP9 / AV1) ou WebM (VP9 / AV1), son AAC ou Opus.
- 720p, 1080p, 1440p, 4K ; 24 à 60 i/s ; trois niveaux de qualité ; plusieurs formats en une seule file (paysage, story 9:16, carré, portrait 4:5, scope).
- Image fixe 4K en PNG. Sur téléphone, « Partager » permet d'enregistrer la vidéo dans Photos.

## Technique

Vite · TypeScript · Preact + Signals · WebGL2 (compositeur maison : shaders de transitions, étalonnage, flou par mipmaps) · Canvas 2D pour le titrage · Web Audio · [Mediabunny](https://mediabunny.dev) (démultiplexage, décodage, encodage MP4/WebM) · vite-plugin-pwa. Polices embarquées (Inter, Playfair Display, Cormorant Garamond, Montserrat, Bebas Neue, Great Vibes).

Chargement initial ≈ 50 Ko gzip ; le moteur vidéo n'est chargé qu'à l'import d'une vidéo ou à l'export.

```
src/
  media/    import, EXIF, dates vidéo, doublons, démo
  story/    chapitres, montage automatique, calcul de la timeline
  render/   compositeur WebGL2, shaders, titrage, décodage d'images
  audio/    musique générée, tempo, mixage, enveloppe
  export/   exporteur WebCodecs
  ui/       interface (médias, montage, export) et lecteur temps réel
```

## Commandes

```bash
npm install
npm run dev          # développement
npm run build        # PWA dans dist/
npm run build:single # fichier HTML unique autonome dans dist-single/
```

## Navigateurs

Chrome / Edge récents recommandés (sélection de dossier native, encodeurs matériels). Safari 17+ et Firefox 130+ pour WebCodecs. Les photos HEIC ne sont lisibles que dans Safari ; ailleurs, les exporter en JPEG (l'iPhone convertit automatiquement en JPEG lors d'un import depuis la photothèque).
