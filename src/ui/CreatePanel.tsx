// Création du film : les choix dans l'ordre logique (format → ambiance → durée → musique), puis « Créer ».
import { useRef } from 'preact/hooks';
import { importing, project, updateProject } from '../state/store';
import { applyTheme, autoCreate, setMusicFile } from '../state/actions';
import { ASPECTS, LOOKS, THEMES } from '../presets';
import { MOODS } from '../audio/music';
import type { AspectId, MusicMood, ThemeId } from '../types';
import { Icon } from './icons';
import { Segmented } from './controls';
import { fmtDuration } from '../util';

const FORMATS: { id: AspectId; label: string }[] = [
  { id: '16:9', label: 'Paysage' },
  { id: '9:16', label: 'Portrait' },
  { id: '1:1', label: 'Carré' },
  { id: '4:5', label: '4:5' },
];

const LENGTHS = [60, 120, 180, 300, 600];

export function formatSummary() {
  const p = project.value;
  return `${ASPECTS[p.aspect].w}:${ASPECTS[p.aspect].h} · ${THEMES[p.theme].label}`;
}

export function CreatePanel({ count, natural, onDone, onClose }: { count: number; natural: number; onDone?: () => void; onClose?: () => void }) {
  const p = project.value;
  const m = p.music;
  const fileRef = useRef<HTMLInputElement>(null);
  const setMusic = (patch: Partial<typeof m>) => updateProject((pp) => ({ music: { ...pp.music, ...patch } }));
  // durées proposées : seulement celles plus courtes que le film complet
  const lengths = LENGTHS.filter((v) => v < natural - 5);
  const lengthValue = p.buildMode === 'all' || !lengths.includes(p.targetLength) ? 0 : p.targetLength;
  return (
    <>
      <h3 class="create-title">
        Votre film <small>{count} médias</small>
        {onClose && (
          <button class="ibtn sheet-close" aria-label="Fermer" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        )}
      </h3>

      <h4 class="cstep">
        <i>1</i> Format
      </h4>
      <div class="format-pick">
        {FORMATS.map((f) => {
          const a = ASPECTS[f.id];
          return (
            <button class={'fmt' + (p.aspect === f.id ? ' on' : '')} onClick={() => updateProject({ aspect: f.id })}>
              <span class="fmt-frame">
                <i style={{ aspectRatio: `${a.w} / ${a.h}` }} />
              </span>
              <b>{f.label}</b>
              <small>
                {a.w}:{a.h}
              </small>
            </button>
          );
        })}
      </div>

      <h4 class="cstep">
        <i>2</i> Ambiance
      </h4>
      <div class="theme-grid compact">
        {(Object.keys(THEMES) as ThemeId[]).map((id) => {
          const th = THEMES[id];
          return (
            <button class={'theme-card' + (p.theme === id ? ' on' : '')} title={th.tagline} onClick={() => applyTheme(id, false)}>
              <span class="theme-swatch" style={{ background: LOOKS[th.look].swatch }}>
                <span class={'theme-sample ts-' + th.title}>Aa</span>
              </span>
              <b>{th.label}</b>
            </button>
          );
        })}
      </div>

      <h4 class="cstep">
        <i>3</i> Durée
      </h4>
      <Segmented<number>
        value={lengthValue}
        onChange={(v) => updateProject(v ? { buildMode: 'best', targetLength: v } : { buildMode: 'all' })}
        options={[{ value: 0, label: `Tout · ${fmtDuration(natural)}` }, ...lengths.map((v) => ({ value: v, label: `${v / 60} min` }))]}
      />

      <h4 class="cstep">
        <i>4</i> Musique
      </h4>
      <Segmented<'generated' | 'file' | 'none'>
        value={m.kind}
        onChange={(v) => {
          if (v === 'file') return fileRef.current?.click();
          setMusic({ kind: v, bpm: v === 'generated' ? MOODS[m.mood].bpm : m.bpm });
        }}
        options={[
          { value: 'generated', label: 'Composée' },
          { value: 'file', label: m.kind === 'file' && m.fileName ? 'Mon morceau ✓' : 'Mon morceau' },
          { value: 'none', label: 'Aucune' },
        ]}
      />
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac"
        hidden
        onChange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (f) void setMusicFile(f);
        }}
      />
      {m.kind === 'generated' && (
        <div class="mood-chips">
          {(Object.keys(MOODS) as MusicMood[]).map((k) => (
            <button class={'chip' + (m.mood === k ? ' on' : '')} onClick={() => setMusic({ mood: k, bpm: MOODS[k].bpm })}>
              {MOODS[k].label}
            </button>
          ))}
        </div>
      )}
      {m.kind === 'file' && m.fileName && (
        <button class="file-chip" onClick={() => fileRef.current?.click()}>
          <Icon name="music" size={14} /> {m.fileName}
        </button>
      )}

      <details class="adv more-opts">
        <summary class="side-title">Plus d’options</summary>
        <label class="field">
          <span class="field-label">Titre</span>
          <input class="input" placeholder="Automatique (dates)" value={p.title} onInput={(e) => updateProject({ title: (e.target as HTMLInputElement).value }, false)} />
        </label>
        <span class="field-label">Plusieurs photos par image</span>
        <Segmented<'off' | 'auto' | 'more'>
          value={p.collage ?? 'auto'}
          onChange={(v) => updateProject({ collage: v })}
          options={[
            { value: 'off', label: 'Jamais' },
            { value: 'auto', label: 'Auto' },
            { value: 'more', label: 'Souvent' },
          ]}
        />
      </details>

      <button
        class="btn btn-primary btn-lg btn-block create-go"
        data-act="create-go"
        disabled={!count || !!importing.value}
        onClick={() => {
          onDone?.();
          void autoCreate();
        }}
      >
        <Icon name="sparkles" /> {p.clips.length ? 'Recréer le film' : 'Créer le film'}
      </button>
    </>
  );
}
