import { render } from 'preact';
import './fonts.css';
import './styles.css';
import { App } from './ui/App';
import { loadTitleFonts } from './render/titles';

render(<App />, document.getElementById('app')!);
void loadTitleFonts();

// Service worker : application utilisable hors ligne après la première visite.
if (!__SINGLE__ && 'serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => null);
  });
}

// Accès de diagnostic (console) : état de l'application.
import * as store from './state/store';
(window as unknown as { __souvenirs: typeof store }).__souvenirs = store;
