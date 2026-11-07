import { useState } from 'preact/hooks';
import { importing, media, sources } from '../state/store';
import { removeSource, rereadDates, rescanAll, rescanSource } from '../state/actions';
import { grantPendingAccess, handlesUnsafe, pendingAccess } from '../state/persist';
import { Icon } from './icons';

const since = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'à l’instant';
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
};

/** Dossiers donnés à l'application : liste, actualisation, retrait. */
export function SourcesPanel({ onAddFolder, onAddFiles }: { onAddFolder: () => void; onAddFiles: () => void }) {
  const list = sources.value;
  const [confirm, setConfirm] = useState<string | null>(null);
  const loose = media.value.filter((m) => !m.sourceId && !m.demo).length;
  const busy = !!importing.value;
  return (
    <div class="sources">
      <div class="sources-head">
        <h4 class="side-title">Sources</h4>
        {media.value.some((m) => m.file && !m.demo) && (
          <button class="ibtn" title="Relire les dates inscrites dans les fichiers" disabled={busy} onClick={() => void rereadDates(false)}>
            <Icon name="calendar" size={14} />
          </button>
        )}
        {list.some((s) => s.handle) && (
          <button class="ibtn" title="Relire tous les dossiers (nouveaux fichiers, fichiers déplacés)" disabled={busy} onClick={() => void rescanAll(true)}>
            <Icon name="refresh" size={14} />
          </button>
        )}
      </div>
      {list.map((s) => (
        <div class={'src-row' + (pendingAccess.value.some((p) => p.id === s.id) ? ' locked' : '')}>
          <Icon name="folder" size={15} />
          <div class="src-txt">
            <b title={s.name}>{s.name}</b>
            <small>
              {s.count} médias · {s.handle ? `lu ${since(s.scannedAt)}` : 'sans accès mémorisé'}
            </small>
          </div>
          {confirm === s.id ? (
            <div class="src-confirm">
              <button class="btn btn-danger btn-sm" onClick={() => (removeSource(s.id), setConfirm(null))}>
                Retirer
              </button>
              <button class="ibtn" onClick={() => setConfirm(null)} aria-label="Annuler">
                <Icon name="x" size={13} />
              </button>
            </div>
          ) : (
            <>
              {s.handle && (
                <button class="ibtn" title="Actualiser ce dossier" disabled={busy} onClick={() => void rescanSource(s.id, true)}>
                  <Icon name="refresh" size={13} />
                </button>
              )}
              <button class="ibtn" title="Retirer ce dossier et ses médias" onClick={() => setConfirm(s.id)}>
                <Icon name="trash" size={13} />
              </button>
            </>
          )}
        </div>
      ))}
      {loose > 0 && (
        <div class="src-row src-loose">
          <Icon name="image" size={15} />
          <div class="src-txt">
            <b>Fichiers importés</b>
            <small>{loose} médias hors dossier</small>
          </div>
        </div>
      )}
      <div class="side-actions">
        <button class="btn btn-ghost" disabled={busy} onClick={onAddFolder}>
          <Icon name="folder" size={15} /> Dossier
        </button>
        <button class="btn btn-ghost" disabled={busy} onClick={onAddFiles}>
          <Icon name="plus" size={15} /> Fichiers
        </button>
      </div>
      {handlesUnsafe.value && list.some((s) => !s.handle) && <p class="side-note">Ajoutez à nouveau vos dossiers pour les relire.</p>}
    </div>
  );
}

/** Bandeau : réautoriser l'accès aux dossiers mémorisés après réouverture d'un projet. */
export function AccessBanner() {
  const list = pendingAccess.value;
  if (!list.length) return null;
  return (
    <div class="access-banner">
      <Icon name="folder" size={16} />
      <span>
        Autoriser l’accès à {list.length > 1 ? `vos ${list.length} dossiers` : `« ${list[0].name} »`} pour y trouver les nouvelles photos.
      </span>
      <button class="btn btn-primary btn-sm" onClick={() => void grantPendingAccess()}>
        Autoriser l’accès
      </button>
      <button class="ibtn" onClick={() => (pendingAccess.value = [])} aria-label="Plus tard">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
