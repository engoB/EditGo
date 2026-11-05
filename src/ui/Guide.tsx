// Guide intégré : les étapes, où trouver chaque fonction, raccourcis clavier.
import { signal } from '@preact/signals';
import { page } from '../state/store';
import { Icon } from './icons';

export const guideOpen = signal(false);

const STEPS = [
  { n: 1, title: 'Médias', text: 'Ajoutez vos dossiers (« + Dossier »). EditGo date chaque fichier, écarte doublons et captures, et regroupe par jour.', go: 'media' as const },
  { n: 2, title: 'Créer le film', text: 'Dans la colonne de droite des Médias : ambiance, construction (tous les médias ou meilleurs moments), puis « Créer le film ».', go: 'media' as const },
  { n: 3, title: 'Ajuster', text: 'Onglet Montage : durée du film, ordre des plans, découpe des vidéos, titres, musique. Tout est annulable (Ctrl+Z).', go: 'edit' as const },
  { n: 4, title: 'Exporter', text: 'Onglet Export : choisissez les formats, lancez. Le film est écrit directement dans le dossier choisi.', go: 'export' as const },
];

const WHERE: [string, string][] = [
  ['Corriger la date d’une photo ou vidéo', 'Médias → cliquer la vignette → « Dates trouvées » / « Décaler tout le dossier »'],
  ['Agrandir les vignettes, voir une photo en grand', 'Médias → curseur en haut à droite · clic sur une vignette'],
  ['Exclure ou garder un média', 'Médias → survol de la vignette → Exclure / Inclure / Garder aussi'],
  ['Changer la durée totale du film', 'Montage → − / + dans la barre de la timeline, ou onglet Style → Durée du film'],
  ['Déplacer un plan', 'Montage → Storyboard : glisser la vignette · ou Alt + ← / →'],
  ['Réunir 2 à 4 photos sur une image', 'Storyboard : déposer une vignette sur une autre · réglage dans Style'],
  ['Choisir l’entrée et la fin d’une vidéo', 'Montage → cliquer le plan → onglet Plan → barre de découpe (touches I et O)'],
  ['Remettre le montage à zéro', 'Montage → « Réinitialiser » (recréer ou vider)'],
  ['Remettre le montage dans l’ordre des dates', 'Montage → « Trier par date »'],
  ['Voir tout le montage', 'Montage → « Tout voir » (touche Z)'],
  ['Changer l’ambiance, les couleurs, le format', 'Montage → onglet Style'],
  ['Musique', 'Montage → onglet Musique (composée sur l’appareil ou votre morceau)'],
  ['Retrouver un projet', 'Bouton « Projets » en haut (enregistrement automatique)'],
];

const KEYS: [string, string][] = [
  ['Espace', 'Lecture / pause'],
  ['← →', 'Image précédente / suivante (Maj : 1 seconde)'],
  ['Alt + ← →', 'Déplacer le plan sélectionné'],
  ['I / O', 'Entrée / sortie de la vidéo à l’image affichée'],
  ['Z', 'Voir tout le montage'],
  ['Suppr', 'Supprimer le plan sélectionné'],
  ['Ctrl + Z / Ctrl + Maj + Z', 'Annuler / rétablir'],
];

export function Guide() {
  if (!guideOpen.value) return null;
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && (guideOpen.value = false)}>
      <div class="drawer guide" role="dialog" aria-label="Guide">
        <div class="drawer-head">
          <h3>
            <Icon name="info" /> Guide
          </h3>
          <button class="ibtn" onClick={() => (guideOpen.value = false)} aria-label="Fermer">
            <Icon name="x" />
          </button>
        </div>
        <div class="drawer-body guide-body">
          <h4 class="side-title">En 4 étapes</h4>
          <div class="guide-steps">
            {STEPS.map((s) => (
              <button
                class="guide-step"
                onClick={() => {
                  page.value = s.go;
                  guideOpen.value = false;
                }}
              >
                <i>{s.n}</i>
                <span>
                  <b>{s.title}</b>
                  <small>{s.text}</small>
                </span>
              </button>
            ))}
          </div>
          <h4 class="side-title">Où trouver…</h4>
          <dl class="guide-where">
            {WHERE.map(([a, b]) => (
              <>
                <dt>{a}</dt>
                <dd>{b}</dd>
              </>
            ))}
          </dl>
          <h4 class="side-title">Raccourcis clavier (onglet Montage)</h4>
          <dl class="guide-keys">
            {KEYS.map(([k, v]) => (
              <>
                <dt>
                  <kbd>{k}</kbd>
                </dt>
                <dd>{v}</dd>
              </>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
