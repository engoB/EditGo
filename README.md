# Souvenirs Studio

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

**Montage automatique**
- Découpage en moments (écart de temps réglable), titres de chapitres datés.
- Sélection des meilleurs plans selon la durée visée (30 s → tout).
- 6 ambiances : Cinéma, Douceur, Énergie, Argentique, Noir & blanc, Épure (étalonnage, transitions, titrage, rythme, musique).
- Coupes calées sur le tempo de la musique.

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
