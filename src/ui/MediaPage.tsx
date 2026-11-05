import { useMemo, useRef, useState } from 'preact/hooks';
import { importOpts, importing, media, project, updateProject } from '../state/store';
import { autoCreate, clearMedia, forceInclude, importFiles, loadDemo, recomputeDuplicates, toggleExcluded, applyTheme } from '../state/actions';
import { filesFromDataTransfer, filesFromDirectoryHandle } from '../media/analyze';
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
  const onFiles = (list: FileList | null) => {
    if (!list) return;
    void importFiles(Array.from(list).map((f) => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name })));
  };
  const pickFolder = async () => {
    try {
      const res = await filesFromDirectoryHandle();
      if (res) return void importFiles(res);
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return;
    }
    dirRef.current?.click();
  };
  const inputs = (
    <>
      <input ref={fileRef} type="file" multiple accept="image/*,video/*,.heic,.heif,.mov,.mkv" hidden onChange={(e) => onFiles((e.target as HTMLInputElement).files)} />
      <input
        ref={dirRef}
        type="file"
        multiple
        hidden
        // @ts-expect-error attributs non standard
        webkitdirectory=""
        directory=""
        onChange={(e) => onFiles((e.target as HTMLInputElement).files)}
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
        void importFiles(await filesFromDataTransfer(e.dataTransfer));
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
          Déposez un dossier de photos et de vidéos (téléphone, PC, Google Drive synchronisé). Souvenirs Studio retrouve la chronologie, écarte les doublons,
          choisit les meilleurs moments et compose un film étalonné, titré et mis en musique — exportable jusqu’en 4K.
        </p>
        <div class="welcome-actions">
          <button class="btn btn-primary btn-lg" onClick={pickFiles}>
            <Icon name="upload" /> Importer photos & vidéos
          </button>
          <button class="btn btn-ghost btn-lg" onClick={pickFolder}>
            <Icon name="folder" /> Choisir un dossier
          </button>
          <button class="btn btn-link" onClick={loadDemo}>
            <Icon name="sparkles" size={16} /> Essayer avec la démo
          </button>
        </div>
        <div class="drop-hint">ou glissez-déposez vos fichiers et dossiers ici</div>
        <ul class="features">
          <li>
            <Icon name="clock" />
            <b>Chronologie</b>
            <span>Dates EXIF, métadonnées vidéo, noms de fichiers</span>
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

function Tile({ m, master }: { m: MediaItem; master?: MediaItem }) {
  const dup = !!m.duplicateOf;
  const sim = !!m.similarTo;
  const off = dup || sim || m.excluded || !!m.error;
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
        {!m.error && m.dateSource !== 'exif' && m.dateSource !== 'video' && m.dateSource !== 'demo' && (
          <span class="badge badge-dim" title={m.dateSource === 'filename' ? 'Date lue dans le nom du fichier' : 'Date de modification du fichier'}>
            ≈ date
          </span>
        )}
      </div>
      <div class="tile-foot">
        <span>{formatTime(m.date)}</span>
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
  const [confirmClear, setConfirmClear] = useState(false);
  const { inputs, pickFiles, pickFolder } = useImporters();
  const drop = useDropZone();
  const opts = importOpts.value;
  const byId = useMemo(() => new Map(items.map((m) => [m.id, m])), [items]);

  if (!items.length && !importing.value) return <Welcome />;

  const stats = {
    photos: items.filter((m) => m.kind === 'photo').length,
    videos: items.filter((m) => m.kind === 'video').length,
    dups: items.filter((m) => m.duplicateOf).length,
    sim: items.filter((m) => m.similarTo).length,
    excluded: items.filter((m) => m.excluded || m.error).length,
  };
  const usableItems = items.filter((m) => !m.duplicateOf && !m.similarTo && !m.excluded && !m.error);
  const first = items[0]?.date,
    last = items[items.length - 1]?.date;

  const visible = items.filter((m) =>
    filter === 'all' ? true : filter === 'photo' ? m.kind === 'photo' : filter === 'video' ? m.kind === 'video' : filter === 'dups' ? m.duplicateOf || m.similarTo : m.excluded || m.error,
  );
  // regroupement par chapitre (sur l'ensemble utilisable) puis rattachement des médias écartés
  const chs = chapters(items, opts.chapterGapHours);
  const groups: { label: string; items: MediaItem[] }[] = chs.map((c) => ({ label: c.label, items: [] }));
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
          <div class="side-actions">
            <button class="btn btn-ghost" onClick={pickFiles}>
              <Icon name="upload" size={16} /> Fichiers
            </button>
            <button class="btn btn-ghost" onClick={pickFolder}>
              <Icon name="folder" size={16} /> Dossier
            </button>
          </div>
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
            <b>{stats.dups + stats.sim}</b>
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
          {confirmClear ? (
            <div class="confirm-row">
              <span>Retirer tous les médias et le montage ?</span>
              <button class="btn btn-danger btn-sm" onClick={() => (clearMedia(), setConfirmClear(false))}>
                Retirer
              </button>
              <button class="btn btn-quiet btn-sm" onClick={() => setConfirmClear(false)}>
                Annuler
              </button>
            </div>
          ) : (
            <button class="btn btn-quiet btn-sm" onClick={() => setConfirmClear(true)}>
              <Icon name="trash" size={14} /> Tout retirer
            </button>
          )}
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
                    <Tile key={m.id} m={m} master={byId.get(m.duplicateOf || m.similarTo || '')} />
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
        <h4 class="side-title">Durée du film</h4>
        <Segmented<number>
          value={project.value.targetLength}
          onChange={(v) => updateProject({ targetLength: v })}
          options={[
            { value: 30, label: '30 s' },
            { value: 60, label: '1 min' },
            { value: 120, label: '2 min' },
            { value: 180, label: '3 min' },
            { value: 0, label: 'Tout' },
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
      {drop.over && (
        <div class="drop-overlay">
          <Icon name="upload" size={40} />
          Déposez pour importer
        </div>
      )}
    </div>
  );
}
