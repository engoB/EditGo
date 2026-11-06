import { render } from 'preact';
import './fonts.css';
import './styles.css';
import { App } from './ui/App';
import { loadTitleFonts } from './render/titles';
import { startAutosave } from './state/persist';
import { updateReady } from './state/store';

render(<App />, document.getElementById('app')!);
void loadTitleFonts();
startAutosave();

// Service worker : application utilisable hors ligne après la première visite.
if (!__SINGLE__ && 'serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    const hadController = !!navigator.serviceWorker.controller;
    // une nouvelle version vient d'être installée pendant que cette page tournait : on le signale
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) updateReady.value = true;
    });
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((reg) => {
        // vérifie les mises à jour à l'ouverture, au retour sur l'onglet et toutes les 30 min
        const check = () => void reg.update().catch(() => null);
        document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
        setInterval(check, 30 * 60 * 1000);
      })
      .catch(() => null);
  });
}

// Accès de diagnostic (console) : état de l'application.
import * as store from './state/store';
(window as unknown as { __souvenirs: typeof store }).__souvenirs = store;
