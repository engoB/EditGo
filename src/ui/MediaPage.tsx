import { useMemo, useRef, useState } from 'preact/hooks';
import { importOpts, importing, media, project, updateProject } from '../state/store';
import { addDroppedHandles, addFolderSource, addPickedFolders, autoCreate, forceInclude, importFiles, loadDemo, recomputeDuplicates, toggleExcluded, applyTheme, setMediaDate } from '../state/actions';
import { SourcesPanel } from './Sources';
import { newProject } from '../state/persist';
import { RecentProjects } from './Projects';
import { buildStory, usable } from '../story/auto';
import { layout } from '../story/timeline';
import { filesFromDataTransfer } from '../media/analyze';
import { dropHandles } from '../media/sources';
import { DATE_SOURCE_LABEL } from '../media/dates';
import { chapters } from '../story/auto';
import { Icon } from './icons';
import { Segmented, Slider, Toggle } from './controls';
import { THEMES, LOOKS } from '../presets';
import type { MediaItem, ThemeId } from '../types';
import { fmtDuration, formatDayShort, formatTime } from '../util';

type Filter = 'all' | 'photo' | 'video' | 'dups' | 'excluded';

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
        ref={dirRef}
        type="file"
        multiple
        hidden
        // @ts-expect-error attributs non standard
        webkitdirectory=""
        directory=""
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
        <span class="eyebrow">
          <Icon name="shield" size={14} /> 100 % hors ligne · vos fichiers ne quittent jamais l’appareil
        </span>
        <h1>
          Vos souvenirs,
          <br />
          <em>montés comme au cinéma.</em>
        </h1>
        <p class="lead">
          Donnez-lui un ou plusieurs dossiers (téléphone, PC, Google Drive synchronisé, export Google Photos). EditGo trie tout seul : il date chaque fichier, écarte doublons et captures d’écran,
          choisit les meilleurs moments et compose un film étalonné, titré et mis en musique — exportable jusqu’en 4K.
        </p>
        <div class="welcome-actions">
          <button class="btn btn-primary btn-lg" onClick={pickFolder}>
            <Icon name="folder" /> Ajouter des dossiers
          </button>
          <button class="btn btn-ghost btn-lg" onClick={pickFiles}>
            <Icon name="upload" /> Importer des fichiers
          </button>
          <button class="btn btn-link" onClick={loadDemo}>
            <Icon name="sparkles" size={16} /> Essayer avec la démo
          </button>
        </div>
        <div class="drop-hint">ou glissez-déposez ici autant de dossiers que vous voulez</div>
        <RecentProjects />
        <ul class="features">
          <li>
            <Icon name="clock" />
            <b>Tri automatique</b>
            <span>EXIF, vidéo, Google Takeout, noms de fichiers et de dossiers, numérotation</span>
          </li>
          <li>
            <Icon name="layers" />
            <b>Doublons écartés</b>
            <span>Copies strictes, rafales et Live Photos</span>
          </li>
          <li>
            <Icon name="palette" />
            <b>Rendu premium</b>
            <span>Étalonnage, transitions GPU, titrage animé</span>
          </li>
          <li>
            <Icon name="hd" />
            <b>Exports multiples</b>
            <span>MP4 / WebM, 720p → 4K, 16:9, 9:16, 1:1, 4:5</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

function Tile({ m, master, onDate }: { m: MediaItem; master?: MediaItem; onDate: () => void }) {
  const dup = !!m.duplicateOf;
  const sim = !!m.similarTo;
  const off = dup || sim || m.excluded || !!m.error || !!m.missing;
  return (
    <div class={'tile' + (off ? ' off' : '')} title={`${m.path}\n${new Date(m.date).toLocaleString('fr-FR')}`}>
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
        <button class="tile-date" onClick={onDate} title="Corriger la date et l’heure (change sa place dans la chronologie)">
          <Icon name="calendar" size={11} /> {formatTime(m.date)}
        </button>
        <span class="score" style={{ '--s': m.score }} title={`Qualité estimée ${(m.score * 100).toFixed(0)} %`} />
      </div>
      <div class="tile-actions">
        {dup || sim ? (
          <button class="chip" onClick={() => forceInclude(m.id)} title={master ? `Identique à ${master.name}` : ''}>
            <Icon name="plus" size={12} /> Garder aussi
          </button>
        ) : (
          !m.error && (
            <button class="chip" onClick={() => toggleExcluded(m.id)}>
              <Icon name={m.excluded ? 'eye' : 'eyeOff'} size={12} /> {m.excluded ? 'Inclure' : 'Exclure'}
            </button>
          )
        )}
      </div>
      {m.error && <div class="tile-err">{m.error}</div>}
    </div>
  );
}

function ThemePicker() {
  const p = project.value;
  return (
    <div class="theme-grid">
      {(Object.keys(THEMES) as ThemeId[]).map((id) => {
        const th = THEMES[id];
        return (
          <button class={'theme-card' + (p.theme === id ? ' on' : '')} onClick={() => applyTheme(id, false)}>
            <span class="theme-swatch" style={{ background: LOOKS[th.look].swatch }}>
              <span class={'theme-sample ts-' + th.title}>Aa</span>
            </span>
            <b>{th.label}</b>
            <small>{th.tagline}</small>
          </button>
        );
      })}
    </div>
  );
}

export function MediaPage() {
  const items = media.value;
  const [filter, setFilter] = useState<Filter>('all');
  const [dateEdit, setDateEdit] = useState<MediaItem | null>(null);
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

  const visible = items.filter((m) =>
    filter === 'all' ? true : filter === 'photo' ? m.kind === 'photo' : filter === 'video' ? m.kind === 'video' : filter === 'dups' ? m.duplicateOf || m.similarTo : m.excluded || m.error,
  );
  // regroupement par chapitre (sur l'ensemble utilisable) puis rattachement des médias écartés
  const chs = chapters(items, opts.chapterGapHours);
  const groups: { label: string; items: MediaItem[] }[] = chs.map((c) => ({ label: c.event ? `${c.event} · ${c.label}` : c.label, items: [] }));
  const other: MediaItem[] = [];
  for (const m of visible) {
    const ci = chs.findIndex((c) => m.date >= c.start - 1 && m.date <= c.end + 1);
    if (ci >= 0) groups[ci].items.push(m);
    else {
      // rattache au chapitre le plus proche
      let best = -1,
        bd = Infinity;
      chs.forEach((c, i) => {
        const d = Math.min(Math.abs(m.date - c.start), Math.abs(m.date - c.end));
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      if (best >= 0) groups[best].items.push(m);
      else other.push(m);
    }
  }
  if (other.length) groups.push({ label: 'Autres', items: other });

  return (
    <div class={'media-page' + (drop.over ? ' drop-over' : '')} {...drop.props}>
      {inputs}
      <aside class="media-side panel">
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
                recomputeDuplicates();
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
        </div>
        <div class="side-block grow" />
        <div class="side-block">
          <p class="side-note">Le projet est enregistré automatiquement sur cet appareil.</p>
          <button class="btn btn-quiet btn-sm" onClick={newProject}>
            <Icon name="plus" size={14} /> Nouveau projet
          </button>
        </div>
      </aside>

      <section class="media-main">
        <div class="media-toolbar">
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
        <div class="media-scroll">
          {groups
            .filter((g) => g.items.length)
            .map((g) => (
              <div class="mgroup">
                <h3 class="mgroup-title">
                  {g.label}
                  <small>{g.items.length} médias</small>
                </h3>
                <div class="tiles">
                  {g.items.map((m) => (
                    <Tile key={m.id} m={m} master={byId.get(m.duplicateOf || m.similarTo || '')} onDate={() => setDateEdit(m)} />
                  ))}
                </div>
              </div>
            ))}
          {!visible.length && <div class="empty-note">Rien à afficher pour ce filtre.</div>}
        </div>
      </section>

      <aside class="create-side panel">
        <h3 class="create-title">
          <Icon name="wand" /> Créer le film
        </h3>
        <p class="side-note">
          {usableItems.length} médias retenus. Choisissez une ambiance et une durée, le montage est automatique — tout reste modifiable ensuite.
        </p>
        <h4 class="side-title">Ambiance</h4>
        <ThemePicker />
        <h4 class="side-title">Construction</h4>
        <div class="build-modes">
          <button class={'build-mode' + (project.value.buildMode === 'all' ? ' on' : '')} onClick={() => updateProject({ buildMode: 'all' })}>
            <b>Tous les médias</b>
            <small>Chaque photo et chaque vidéo en entier · durée naturelle ≈ {fmtDuration(natural)}</small>
          </button>
          <button class={'build-mode' + (project.value.buildMode === 'best' ? ' on' : '')} onClick={() => updateProject({ buildMode: 'best' })}>
            <b>Meilleurs moments</b>
            <small>Sélection des plus belles images pour une durée choisie</small>
          </button>
        </div>
        {project.value.buildMode === 'best' ? (
          <Segmented<number>
            value={project.value.targetLength}
            onChange={(v) => updateProject({ targetLength: v })}
            options={[
              { value: 30, label: '30 s' },
              { value: 60, label: '1 min' },
              { value: 120, label: '2 min' },
              { value: 180, label: '3 min' },
              { value: 300, label: '5 min' },
            ]}
          />
        ) : (
          <p class="side-note">Après création, allongez ou raccourcissez le film entier depuis le montage (onglet Style ou boutons − / + de la timeline).</p>
        )}
        <h4 class="side-title">Plusieurs photos par image</h4>
        <Segmented<'off' | 'auto' | 'more'>
          value={project.value.collage ?? 'auto'}
          onChange={(v) => updateProject({ collage: v })}
          options={[
            { value: 'off', label: 'Jamais' },
            { value: 'auto', label: 'Automatique' },
            { value: 'more', label: 'Souvent' },
          ]}
        />
        <label class="field">
          <span class="field-label">Titre (facultatif)</span>
          <input class="input" placeholder="Titre automatique selon les dates" value={project.value.title} onInput={(e) => updateProject({ title: (e.target as HTMLInputElement).value }, false)} />
        </label>
        <button class="btn btn-primary btn-lg btn-block" disabled={!usableItems.length || !!importing.value} onClick={() => void autoCreate()}>
          <Icon name="sparkles" /> {project.value.clips.length ? 'Recréer le film' : 'Créer le film'}
        </button>
      </aside>
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
