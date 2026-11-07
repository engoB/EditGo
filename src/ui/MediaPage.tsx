import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { importOpts, importing, media, movedIds, project } from '../state/store';
import { addDroppedHandles, addFolderSource, addPickedFolders, autoCreate, forceInclude, importFiles, loadDemo, recomputeDuplicates, toggleExcluded, setMediaDate } from '../state/actions';
import { SourcesPanel } from './Sources';
import { CreatePanel, formatSummary } from './CreatePanel';
import { MediaViewer } from './MediaViewer';
import { RecentProjects } from './Projects';
import { buildStory, usable } from '../story/auto';
import { layout } from '../story/timeline';
import { filesFromDataTransfer } from '../media/analyze';
import { dropHandles } from '../media/sources';
import { DATE_SOURCE_LABEL } from '../media/dates';
import { chapters } from '../story/auto';
import { Icon } from './icons';
import { Segmented, Slider, Toggle } from './controls';
import type { MediaItem } from '../types';
import { fmtDuration, formatDayShort, formatTime } from '../util';

type Filter = 'all' | 'photo' | 'video' | 'dups' | 'excluded';
let dupTimer = 0;

type Group = { label: string; note?: string; items: MediaItem[] };
let groupCache: { items: MediaItem[]; filter: Filter; gap: number; value: ReturnType<typeof computeGroups> } | null = null;

/** Groupes par moment (mis en cache : recalculés seulement si la médiathèque ou le filtre change). */
function groupMedia(items: MediaItem[], filter: Filter, gap: number) {
  if (groupCache && groupCache.items === items && groupCache.filter === filter && groupCache.gap === gap) return groupCache.value;
  const value = computeGroups(items, filter, gap);
  groupCache = { items, filter, gap, value };
  return value;
}

function computeGroups(items: MediaItem[], filter: Filter, gap: number) {
  const visible = items.filter((m) =>
    filter === 'all' ? true : filter === 'photo' ? m.kind === 'photo' : filter === 'video' ? m.kind === 'video' : filter === 'dups' ? m.duplicateOf || m.similarTo : m.excluded || m.error,
  );
  const chs = chapters(items, gap);
  const groups: Group[] = chs.map((c) => ({ label: c.label, note: c.event, items: [] }));
  const other: MediaItem[] = [];
  // les chapitres sont triés : recherche dichotomique du moment de chaque média
  for (const m of visible) {
    let lo = 0,
      hi = chs.length - 1,
      best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chs[mid].start - 1 <= m.date) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0 && chs.length) best = 0;
    if (best >= 0 && best + 1 < chs.length && m.date > chs[best].end && chs[best + 1].start - m.date < m.date - chs[best].end) best++;
    if (best >= 0) groups[best].items.push(m);
    else other.push(m);
  }
  if (other.length) groups.push({ label: 'Autres', items: other });
  return { visible, chs, groups, flat: groups.flatMap((g) => g.items) };
}

function useImporters() {
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const entries = (list: FileList) =>
    Array.from(list).map((f) => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }));
  const onFiles = (list: FileList | null) => {
    if (list?.length) void importFiles(entries(list));
  };
  const onFolder = (list: FileList | null) => {
    if (list?.length) void addPickedFolders(entries(list));
  };
  const pickFolder = async () => {
    // sélecteur natif (accès mémorisé, actualisable) ; sinon sélecteur de dossier classique
    if (!(await addFolderSource())) dirRef.current?.click();
  };
  const inputs = (
    <>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/*,video/*,.heic,.heif,.mov,.mkv"
        hidden
        onChange={(e) => {
          onFiles((e.target as HTMLInputElement).files);
          (e.target as HTMLInputElement).value = '';
        }}
      />
      <input
        ref={(el) => {
          dirRef.current = el;
          // attribut posé directement : Preact traiterait webkitdirectory="" comme « faux »
          if (el && !el.hasAttribute('webkitdirectory')) {
            el.setAttribute('webkitdirectory', '');
            el.setAttribute('directory', '');
          }
        }}
        type="file"
        multiple
        hidden
        data-folder=""
        onChange={(e) => {
          onFolder((e.target as HTMLInputElement).files);
          (e.target as HTMLInputElement).value = '';
        }}
      />
    </>
  );
  return { inputs, pickFiles: () => fileRef.current?.click(), pickFolder };
}

export function useDropZone() {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (e.currentTarget === e.target) setOver(false);
      },
      onDrop: async (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        setOver(false);
        // dossiers déposés : accès mémorisable si le navigateur le permet, sinon lecture classique
        const hp = dropHandles(e.dataTransfer);
        if (hp) void addDroppedHandles(await hp);
        else void addPickedFolders(await filesFromDataTransfer(e.dataTransfer));
      },
    },
  };
}

function Welcome() {
  const { inputs, pickFiles, pickFolder } = useImporters();
  const drop = useDropZone();
  return (
    <div class={'welcome' + (drop.over ? ' drop-over' : '')} {...drop.props}>
      {inputs}
      <div class="welcome-glow" />
      <div class="welcome-inner">
        <h1>
          Vos souvenirs,
          <br />
          <em>en film.</em>
        </h1>
        <p class="lead short">
          <Icon name="shield" size={14} /> Hors ligne : vos fichiers restent sur l’appareil.
        </p>
        <div class="welcome-actions">
          <button class="btn btn-primary btn-lg" onClick={pickFolder}>
            <Icon name="folder" /> Choisir un dossier
          </button>
          <button class="btn btn-ghost btn-lg" onClick={pickFiles}>
            <Icon name="upload" /> Choisir des photos et vidéos
          </button>
          <button class="btn btn-link" onClick={loadDemo}>
            <Icon name="sparkles" size={16} /> Essayer avec la démo
          </button>
        </div>
        <RecentProjects />
      </div>
    </div>
  );
}

function Tile({ m, master, onDate, onOpen }: { m: MediaItem; master?: MediaItem; onDate: () => void; onOpen: () => void }) {
  const dup = !!m.duplicateOf;
  const sim = !!m.similarTo;
  const off = dup || sim || m.excluded || !!m.error || !!m.missing;
  return (
    <div data-id={m.id} class={'tile' + (off ? ' off' : '') + (movedIds.value.includes(m.id) ? ' moved' : '')} title={`${m.path}\n${new Date(m.date).toLocaleString('fr-FR')}`} onClick={onOpen}>
      {m.thumb ? <img src={m.thumb} loading="lazy" alt="" draggable={false} /> : <div class="tile-ph" />}
      <div class="tile-badges">
        {m.kind === 'video' && (
          <span class="badge">
            <Icon name="video" size={11} /> {fmtDuration(m.duration)}
          </span>
        )}
        {dup && <span class="badge badge-warn">Doublon</span>}
        {sim && <span class="badge badge-info">{m.kind === 'video' ? 'Live Photo' : 'Similaire'}</span>}
        {m.error && <span class="badge badge-err">Illisible</span>}
        {m.missing && <span class="badge badge-err">Absent · à réimporter</span>}
        {m.skipReason && <span class="badge badge-warn">{m.skipReason}</span>}
        {m.dateSource === 'manual' && <span class="badge badge-dim">Date corrigée</span>}
        {!m.error && (m.dateSource === 'sequence' || m.dateSource === 'folder' || m.dateSource === 'file') && (
          <span class={'badge ' + (m.dateSource === 'file' ? 'badge-warn' : 'badge-dim')} title={'Date ' + DATE_SOURCE_LABEL[m.dateSource]}>
            ≈ date
          </span>
        )}
      </div>
      <div class="tile-foot">
        <button
          class="tile-date"
          onClick={(e) => {
            e.stopPropagation();
            onDate();
          }} title="Corriger la date et l’heure (change sa place dans la chronologie)">
          <Icon name="calendar" size={11} /> {formatTime(m.date)}
        </button>
        <span class="score" style={{ '--s': m.score }} title={`Qualité estimée ${(m.score * 100).toFixed(0)} %`} />
      </div>
      <div class="tile-actions">
        {dup || sim ? (
          <button
            class="chip"
            onClick={(e) => {
              e.stopPropagation();
              forceInclude(m.id);
            }}
            title={master ? `Identique à ${master.name}` : ''}
          >
            <Icon name="plus" size={12} /> Garder aussi
          </button>
        ) : (
          !m.error && (
            <button
              class="chip"
              onClick={(e) => {
                e.stopPropagation();
                toggleExcluded(m.id);
              }}
            >
              <Icon name={m.excluded ? 'eye' : 'eyeOff'} size={12} /> {m.excluded ? 'Inclure' : 'Exclure'}
            </button>
          )
        )}
      </div>
      {m.error && <div class="tile-err">{m.error}</div>}
    </div>
  );
}

export function MediaPage() {
  const items = media.value;
  const [filter, setFilter] = useState<Filter>('all');
  const [dateEdit, setDateEdit] = useState<MediaItem | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [tile, setTile] = useState(() => {
    try {
      return Number(localStorage.getItem('editgo-tile')) || 150;
    } catch {
      return 150;
    }
  });
  const [whole, setWhole] = useState(false);
  // téléphone : panneaux repliés (sources et options) et feuille « Créer le film »
  const [sideOpen, setSideOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  // après une correction de date : on montre où le média a été replacé
  useEffect(() => {
    const ids = movedIds.value;
    if (!ids.length) return;
    const el = document.querySelector(`.tile[data-id="${ids[0]}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = setTimeout(() => (movedIds.value = []), 3500);
    return () => clearTimeout(t);
  }, [movedIds.value]);
  const setTileSize = (v: number) => {
    setTile(v);
    try {
      localStorage.setItem('editgo-tile', String(v));
    } catch {
      /* préférence non mémorisée */
    }
  };
  const { inputs, pickFiles, pickFolder } = useImporters();
  const drop = useDropZone();
  const opts = importOpts.value;
  const byId = useMemo(() => new Map(items.map((m) => [m.id, m])), [items]);

  // durée du film si l'on garde tout (estimation rapide sur le montage automatique)
  const natural = useMemo(() => {
    const p = project.value;
    const st = buildStory(items.filter(usable), { ...p, buildMode: 'all', title: 'x', subtitle: 'x' }, opts.chapterGapHours);
    return layout(st.clips ?? []).total;
  }, [items, project.value.theme, project.value.collage, project.value.aspect, project.value.photoDuration, project.value.music.beatSync, project.value.music.bpm, opts.chapterGapHours]);

  if (!items.length && !importing.value) return <Welcome />;

  const stats = {
    photos: items.filter((m) => m.kind === 'photo').length,
    videos: items.filter((m) => m.kind === 'video').length,
    dups: items.filter((m) => m.duplicateOf).length,
    sim: items.filter((m) => m.similarTo).length,
    excluded: items.filter((m) => m.excluded || m.error).length,
    skipped: items.filter((m) => m.skipReason && m.excluded).length,
  };
  const usableItems = items.filter(usable);
  const first = items[0]?.date,
    last = items[items.length - 1]?.date;

  const { visible, chs, groups, flat } = groupMedia(items, filter, opts.chapterGapHours);

  return (
    <div class={'media-page' + (drop.over ? ' drop-over' : '')} {...drop.props}>
      {inputs}
      <div class="m-summary panel">
        <div class="ms-stats">
          <b>{stats.photos}</b> photos · <b>{stats.videos}</b> vidéos
          {stats.dups + stats.sim + stats.skipped > 0 && (
            <>
              {' '}
              · <b>{stats.dups + stats.sim + stats.skipped}</b> écartés
            </>
          )}
          {first && (
            <small>
              {formatDayShort(first)} → {formatDayShort(last!)} · {chs.length} moments
            </small>
          )}
        </div>
        <button class="ibtn" title="Ajouter un dossier" onClick={pickFolder}>
          <Icon name="folder" size={17} />
        </button>
        <button class="ibtn" title="Ajouter des fichiers" onClick={pickFiles}>
          <Icon name="plus" size={18} />
        </button>
        <button class={'ibtn' + (sideOpen ? ' on' : '')} title="Sources et options de tri" onClick={() => setSideOpen(!sideOpen)}>
          <Icon name="sliders" size={17} />
        </button>
        {importing.value && (
          <div class="progress-line ms-progress">
            <i style={{ width: `${(importing.value.done / Math.max(1, importing.value.total)) * 100}%` }} />
          </div>
        )}
      </div>
      <aside class={'media-side panel' + (sideOpen ? ' open' : '')}>
        <div class="side-block">
          <SourcesPanel onAddFolder={pickFolder} onAddFiles={pickFiles} />
          {importing.value && (
            <div class="progress-card">
              <div class="progress-line">
                <i style={{ width: `${(importing.value.done / Math.max(1, importing.value.total)) * 100}%` }} />
              </div>
              <small>
                Analyse {importing.value.done} / {importing.value.total} · {importing.value.label}
              </small>
            </div>
          )}
        </div>
        <div class="side-block stats">
          <div>
            <b>{stats.photos}</b>
            <span>photos</span>
          </div>
          <div>
            <b>{stats.videos}</b>
            <span>vidéos</span>
          </div>
          <div>
            <b>{stats.dups + stats.sim + stats.skipped}</b>
            <span>écartés</span>
          </div>
          <div>
            <b>{chs.length}</b>
            <span>moments</span>
          </div>
        </div>
        {first && (
          <div class="side-block period">
            <Icon name="clock" size={14} /> {formatDayShort(first)} → {formatDayShort(last!)}
          </div>
        )}
        <div class="side-block">
          <details class="adv">
          <summary class="side-title">Options de tri avancées</summary>
          <h4 class="side-title">Détection des doublons</h4>
          <p class="side-note">Les copies strictes (contenu identique) sont toujours ignorées.</p>
          <Toggle
            label="Regrouper les quasi-doublons"
            hint="Rafales, copies recompressées (WhatsApp…)"
            checked={opts.nearDuplicates}
            onChange={(v) => {
              importOpts.value = { ...opts, nearDuplicates: v };
              recomputeDuplicates();
            }}
          />
          {opts.nearDuplicates && (
            <Slider
              label="Sensibilité"
              value={opts.similarity}
              min={2}
              max={16}
              step={1}
              format={(v) => (v <= 5 ? 'Stricte' : v <= 10 ? 'Normale' : 'Large')}
              onInput={(v) => {
                importOpts.value = { ...opts, similarity: v };
                clearTimeout(dupTimer);
                dupTimer = window.setTimeout(recomputeDuplicates, 350);
              }}
            />
          )}
          <Toggle
            label="Écarter captures d’écran et miniatures"
            hint="Appliqué aux prochains imports ; « Inclure » sur une vignette pour la garder"
            checked={opts.skipJunk}
            onChange={(v) => (importOpts.value = { ...opts, skipJunk: v })}
          />
          <Slider
            label="Nouveau moment après"
            value={opts.chapterGapHours}
            min={1}
            max={24}
            step={1}
            format={(v) => `${v} h sans photo`}
            onInput={(v) => (importOpts.value = { ...opts, chapterGapHours: v })}
          />
          </details>
        </div>
      </aside>

      <section class="media-main">
        <div class="media-toolbar">
          <div class="mt-right">
            <button class={'ibtn' + (whole ? ' on' : '')} title="Afficher les images entières (sans recadrage)" onClick={() => setWhole(!whole)}>
              <Icon name="maximize" size={15} />
            </button>
            <label class="tl-zoom" title="Taille des vignettes">
              <Icon name="grid" size={14} />
              <input type="range" min={96} max={440} step={4} value={tile} style={{ '--p': `${((tile - 96) / 344) * 100}%` }} onInput={(e) => setTileSize(Number((e.target as HTMLInputElement).value))} />
              <Icon name="zoomIn" size={15} />
            </label>
          </div>
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `Tout · ${items.length}` },
              { value: 'photo', label: 'Photos' },
              { value: 'video', label: 'Vidéos' },
              { value: 'dups', label: `Doublons · ${stats.dups + stats.sim}` },
              { value: 'excluded', label: `Exclus · ${stats.excluded}` },
            ]}
          />
        </div>
        <div class={'media-scroll' + (whole ? ' whole' : '')} style={{ '--tile': tile + 'px' }}>
          {groups
            .filter((g) => g.items.length)
            .map((g) => (
              <div class="mgroup">
                <h3 class="mgroup-title">
                  {g.label}
                  <small>
                    {g.items.length} médias{g.note ? ` · ${g.note}` : ''}
                  </small>
                </h3>
                <div class="tiles">
                  {g.items.map((m) => (
                    <Tile
                      key={m.id}
                      m={m}
                      master={byId.get(m.duplicateOf || m.similarTo || '')}
                      onDate={() => setDateEdit(m)}
                      onOpen={() => setViewerId(m.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          {!visible.length && <div class="empty-note">Rien à afficher pour ce filtre.</div>}
        </div>
      </section>

      <div class="create-bar">
        <button class="btn btn-ghost" data-act="create-opts" onClick={() => setSheet(true)}>
          <Icon name="sliders" size={16} /> {formatSummary()}
        </button>
        <button class="btn btn-primary" data-act="create" disabled={!usableItems.length || !!importing.value} onClick={() => void autoCreate()}>
          <Icon name="sparkles" size={16} /> {project.value.clips.length ? 'Recréer le film' : 'Créer le film'}
        </button>
      </div>
      {sheet && <div class="sheet-back" onClick={() => setSheet(false)} />}
      <aside class={'create-side panel' + (sheet ? ' sheet-open' : '')}>
        <CreatePanel count={usableItems.length} natural={natural} onDone={() => setSheet(false)} onClose={sheet ? () => setSheet(false) : undefined} />
      </aside>
      {viewerId && flat.some((x) => x.id === viewerId) && (
        <MediaViewer
          list={flat}
          index={flat.findIndex((x) => x.id === viewerId)}
          onIndex={(i) => setViewerId(flat[i]?.id ?? null)}
          onClose={() => setViewerId(null)}
          onDate={(m) => setDateEdit(m)}
        />
      )}
      {dateEdit && <DateDialog m={dateEdit} onClose={() => setDateEdit(null)} />}
      {drop.over && (
        <div class="drop-overlay">
          <Icon name="upload" size={40} />
          Déposez pour importer
        </div>
      )}
    </div>
  );
}

const toLocalInput = (t: number) => {
  const d = new Date(t);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
};

const SOURCE_LABEL = DATE_SOURCE_LABEL;

export function DateDialog({ m, onClose }: { m: MediaItem; onClose: () => void }) {
  const [v, setV] = useState(toLocalInput(m.date));
  const apply = () => {
    const t = new Date(v).getTime();
    if (isFinite(t)) setMediaDate(m.id, t);
    onClose();
  };
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-label="Corriger la date">
        <div class="modal-head">
          {m.thumb && <img src={m.thumb} alt="" />}
          <div>
            <b>Date et heure de prise de vue</b>
            <small>
              {m.name} · {SOURCE_LABEL[m.dateSource]}
            </small>
          </div>
        </div>
        <input id="media-date" class="input" type="datetime-local" value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} />
        <p class="side-note">La date détermine la place du média dans la chronologie et dans le prochain montage automatique.</p>
        <div class="modal-actions">
          <button class="btn btn-quiet" onClick={onClose}>
            Annuler
          </button>
          <button class="btn btn-primary" onClick={apply}>
            <Icon name="check" size={16} /> Appliquer
          </button>
        </div>
      </div>
    </div>
  );
}
