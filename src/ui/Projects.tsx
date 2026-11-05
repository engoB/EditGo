import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import {
  currentProjectId,
  deleteProject,
  exportProjectFile,
  importProjectFile,
  listProjects,
  newProject,
  openProject,
  projectsRev,
  renameProject,
  saveCurrent,
  saveProgress,
  saveState,
  storageEstimate,
  type ProjectMeta,
} from '../state/persist';
import { media, toast } from '../state/store';
import { Icon } from './icons';
import { fmtBytes, fmtDuration, saveFile } from '../util';

export const projectsOpen = signal(false);

function useProjects() {
  const [list, setList] = useState<ProjectMeta[] | null>(null);
  const rev = projectsRev.value;
  useEffect(() => {
    let alive = true;
    void listProjects().then((l) => alive && setList(l));
    return () => {
      alive = false;
    };
  }, [rev]);
  return list;
}

function Cover({ blob }: { blob: Blob | null }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img src={url} alt="" /> : <span class="pj-cover-ph"><Icon name="film" size={20} /></span>;
}

async function open(id: string) {
  try {
    const missing = await openProject(id);
    projectsOpen.value = false;
    if (missing) toast(`${missing} fichier(s) introuvable(s) : réimportez-les (même dossier) pour les réassocier.`, 'warn', 7000);
    else toast('Projet ouvert', 'ok', 1800);
  } catch (e) {
    toast('Ouverture impossible : ' + (e as Error).message, 'error');
  }
}

const fmtDate = (t: number) => new Date(t).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** Projets récents (écran d'accueil). */
export function RecentProjects() {
  const list = useProjects();
  if (!list?.length) return null;
  return (
    <div class="recent">
      <h4 class="side-title">Reprendre un projet</h4>
      <div class="recent-grid">
        {list.slice(0, 6).map((p) => (
          <button class="recent-card" onClick={() => open(p.id)}>
            <span class="pj-cover">
              <Cover blob={p.cover} />
            </span>
            <span class="recent-txt">
              <b>{p.name}</b>
              <small>
                {p.clipCount ? fmtDuration(p.duration) + ' · ' : ''}
                {p.mediaCount} médias · {fmtDate(p.updated)}
              </small>
            </span>
          </button>
        ))}
      </div>
      {list.length > 6 && (
        <button class="btn btn-link" onClick={() => (projectsOpen.value = true)}>
          Voir les {list.length} projets
        </button>
      )}
    </div>
  );
}

function Row({ p }: { p: ProjectMeta }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [confirmDel, setConfirmDel] = useState(false);
  const current = currentProjectId.value === p.id;
  return (
    <div class={'pj-row' + (current ? ' current' : '')}>
      <button class="pj-cover" onClick={() => open(p.id)} title="Ouvrir">
        <Cover blob={p.cover} />
      </button>
      <div class="pj-txt">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void renameProject(p.id, name.trim() || p.name);
              setEditing(false);
            }}
          >
            <input id={'pj-name-' + p.id} class="input" value={name} autoFocus onInput={(e) => setName((e.target as HTMLInputElement).value)} onBlur={() => setEditing(false)} />
          </form>
        ) : (
          <b onDblClick={() => setEditing(true)}>
            {p.name} {current && <span class="pj-cur">ouvert</span>}
          </b>
        )}
        <small>
          {p.clipCount ? `${fmtDuration(p.duration)} · ${p.clipCount} plans · ` : ''}
          {p.mediaCount} médias · modifié le {fmtDate(p.updated)}
        </small>
      </div>
      <div class="pj-act">
        {confirmDel ? (
          <>
            <button class="btn btn-danger btn-sm" onClick={() => void deleteProject(p.id).then(() => toast('Projet supprimé', 'ok', 1800))}>
              Supprimer
            </button>
            <button class="btn btn-quiet btn-sm" onClick={() => setConfirmDel(false)}>
              Annuler
            </button>
          </>
        ) : (
          <>
            <button class="btn btn-ghost btn-sm" onClick={() => open(p.id)} disabled={current}>
              Ouvrir
            </button>
            <button class="ibtn" title="Renommer" onClick={() => setEditing(true)}>
              <Icon name="type" size={15} />
            </button>
            <button class="ibtn" title="Supprimer" onClick={() => setConfirmDel(true)}>
              <Icon name="trash" size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Panneau des projets enregistrés. */
export function ProjectsPanel() {
  const list = useProjects();
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void storageEstimate().then(setEst);
  }, [projectsRev.value]);
  if (!projectsOpen.value) return null;
  const exportJson = async () => {
    await saveCurrent();
    const { blob, name } = await exportProjectFile();
    saveFile(blob, name);
  };
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && (projectsOpen.value = false)}>
      <div class="drawer" role="dialog" aria-label="Projets">
        <div class="drawer-head">
          <h3>
            <Icon name="folder" /> Projets
          </h3>
          <button class="ibtn" onClick={() => (projectsOpen.value = false)} aria-label="Fermer">
            <Icon name="x" />
          </button>
        </div>
        <div class="drawer-actions">
          <button
            class="btn btn-primary btn-sm"
            onClick={() => {
              newProject();
              projectsOpen.value = false;
            }}
          >
            <Icon name="plus" size={15} /> Nouveau projet
          </button>
          <button class="btn btn-ghost btn-sm" disabled={!media.value.length} onClick={() => void exportJson()} title="Fichier .json du montage (sans les médias)">
            <Icon name="download" size={15} /> Exporter le projet
          </button>
          <button class="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={15} /> Importer un projet
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              (e.target as HTMLInputElement).value = '';
              if (!f) return;
              try {
                const missing = await importProjectFile(f);
                projectsOpen.value = false;
                toast(missing ? `Projet importé. Réimportez les ${missing} fichier(s) médias pour les réassocier.` : 'Projet importé', missing ? 'warn' : 'ok', 7000);
              } catch (err) {
                toast((err as Error).message, 'error');
              }
            }}
          />
        </div>
        <div class="drawer-body">
          {list === null ? (
            <div class="empty-note">Chargement…</div>
          ) : list.length ? (
            list.map((p) => <Row key={p.id} p={p} />)
          ) : (
            <div class="empty-note">
              <Icon name="save" />
              Aucun projet pour l’instant. Dès que vous importez des médias, le projet est enregistré automatiquement sur cet appareil.
            </div>
          )}
        </div>
        <div class="drawer-foot">
          <small>
            Enregistré dans ce navigateur, sur cet appareil (médias compris).
            {est && est.quota ? ` Espace utilisé : ${fmtBytes(est.usage)} sur ${fmtBytes(est.quota)}.` : ''}
          </small>
        </div>
      </div>
    </div>
  );
}

/** Indicateur d'enregistrement (barre du haut). */
export function SaveIndicator() {
  const st = saveState.value;
  const prog = saveProgress.value;
  if (!media.value.length) return null;
  const label = prog ? `Copie des médias ${prog.done}/${prog.total}` : st === 'saving' ? 'Enregistrement…' : st === 'saved' ? 'Enregistré' : st === 'error' ? 'Échec de l’enregistrement' : 'Modifié';
  return (
    <button class={'save-ind save-' + st} onClick={() => void saveCurrent()} title="Projet enregistré automatiquement sur cet appareil. Cliquer pour enregistrer maintenant.">
      <Icon name={st === 'error' ? 'info' : st === 'saved' ? 'check' : 'save'} size={14} />
      <span>{label}</span>
    </button>
  );
}
