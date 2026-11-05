import { useEffect } from 'preact/hooks';
import { canRedo, canUndo, historyRev, media, page, playhead, playing, project, redo, removeClip, selectedClip, timeline, undo, updateProject, type Page } from '../state/store';
import { autoCreate, nudgeClip, setVideoBounds } from '../state/actions';
import { ProjectsPanel, SaveIndicator, projectsOpen } from './Projects';
import { AccessBanner } from './Sources';
import { MediaPage } from './MediaPage';
import { EditPage } from './EditPage';
import { ExportPage } from './ExportPage';
import { Icon } from './icons';
import { Toasts } from './controls';

const PAGES: { id: Page; label: string; icon: string }[] = [
  { id: 'media', label: 'Médias', icon: 'image' },
  { id: 'edit', label: 'Montage', icon: 'film' },
  { id: 'export', label: 'Export', icon: 'download' },
];

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (page.value !== 'edit') return;
      const total = timeline.value.total;
      if (e.code === 'Space') {
        e.preventDefault();
        playing.value = !playing.value;
      } else if (e.altKey && selectedClip.value && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        nudgeClip(selectedClip.value, e.key === 'ArrowLeft' ? -1 : 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        playing.value = false;
        const d = (e.shiftKey ? 1 : 1 / 30) * (e.key === 'ArrowLeft' ? -1 : 1);
        playhead.value = Math.max(0, Math.min(total, playhead.value + d));
      } else if (e.key === 'Home') {
        playhead.value = 0;
      } else if (e.key === 'End') {
        playhead.value = total;
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedClip.value) {
        e.preventDefault();
        removeClip(selectedClip.value);
      } else if ((e.key === 'i' || e.key === 'o') && !mod && selectedClip.value) {
        // points d'entrée / de sortie du plan vidéo sélectionné à l'image affichée
        const p = timeline.value.placed.find((x) => x.clip.id === selectedClip.value);
        if (p && playhead.value >= p.start && playhead.value <= p.end) {
          const src = p.clip.trimIn + (playhead.value - p.start) * p.clip.speed;
          setVideoBounds(p.clip.id, e.key === 'i' ? src : null, e.key === 'o' ? src : null);
        }
      } else if (e.key === 'Escape') {
        selectedClip.value = null;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  useShortcuts();
  void historyRev.value;
  const hasClips = project.value.clips.length > 0;
  const hasMedia = media.value.length > 0;
  return (
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <span class="logo">
            <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
              <defs>
                <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#ffd38a" />
                  <stop offset="1" stop-color="#ff7a59" />
                </linearGradient>
              </defs>
              <rect x="2" y="2" width="28" height="28" rx="8" fill="#16161c" stroke="url(#lg)" stroke-width="1.5" />
              <path d="M9 21.5c3.5-7 6-9.5 7-9.5s3.5 2.5 7 9.5" fill="none" stroke="url(#lg)" stroke-width="2" stroke-linecap="round" />
              <circle cx="21.5" cy="10.5" r="2.4" fill="url(#lg)" />
            </svg>
          </span>
          <span class="brand-name">
            Edit<em>Go</em>
          </span>
        </div>
        {hasMedia && (
          <input
            class="project-title"
            value={project.value.title}
            placeholder="Projet sans titre"
            onInput={(e) => updateProject({ title: (e.target as HTMLInputElement).value }, false)}
            aria-label="Titre du projet"
          />
        )}
        <nav class="pages">
          {PAGES.map((p) => (
            <button
              class={page.value === p.id ? 'on' : ''}
              disabled={p.id !== 'media' && !hasClips && !hasMedia}
              onClick={() => {
                playing.value = false;
                page.value = p.id;
              }}
            >
              <Icon name={p.icon} size={16} />
              <span>{p.label}</span>
            </button>
          ))}
        </nav>
        <div class="top-actions">
          <SaveIndicator />
          <button class="ibtn" title="Projets enregistrés" onClick={() => (projectsOpen.value = true)}>
            <Icon name="folder" size={16} />
            <span class="hide-sm">Projets</span>
          </button>
          <button class="ibtn" title="Annuler (Ctrl+Z)" disabled={!canUndo()} onClick={undo}>
            <Icon name="undo" size={16} />
          </button>
          <button class="ibtn" title="Rétablir (Ctrl+Maj+Z)" disabled={!canRedo()} onClick={redo}>
            <Icon name="redo" size={16} />
          </button>
          {hasMedia && page.value !== 'export' && (
            <button class="btn btn-ghost btn-sm hide-sm" onClick={() => void autoCreate()}>
              <Icon name="sparkles" size={15} /> Auto
            </button>
          )}
          {hasClips && page.value !== 'export' && (
            <button class="btn btn-primary btn-sm" onClick={() => ((playing.value = false), (page.value = 'export'))}>
              <Icon name="download" size={15} /> <span class="hide-sm">Exporter</span>
            </button>
          )}
        </div>
      </header>
      <AccessBanner />
      <main class="main">
        {page.value === 'media' && <MediaPage />}
        {page.value === 'edit' && <EditPage />}
        {page.value === 'export' && <ExportPage />}
      </main>
      <ProjectsPanel />
      <Toasts />
    </div>
  );
}
