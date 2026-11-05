import { useEffect, useRef, useState } from 'preact/hooks';
import {
  mediaMap,
  media,
  mobilePanel,
  musicBusy,
  playhead,
  playing,
  project,
  selectedClip,
  timeline,
  updateClip,
  updateProject,
  removeClip,
  toast,
} from '../state/store';
import { applyTheme, prepareMusic, rebuildStory, setMusicFile } from '../state/actions';
import { Player } from './player';
import { Timeline } from './Timeline';
import { Icon } from './icons';
import { Section, Segmented, Select, Slider, Toggle } from './controls';
import { ASPECTS, LOOKS, THEMES, TITLE_STYLES, TRANSITIONS } from '../presets';
import { MOODS } from '../audio/music';
import { newClip, usable } from '../story/auto';
import type { AspectId, Clip, FitMode, LookId, MotionId, MusicMood, ThemeId, TitleStyleId, TransitionId } from '../types';
import { saveFile, fmtDuration, formatTime, timecode, uid } from '../util';

let playerRef: Player | null = null;
export const getPlayer = () => playerRef;

function Viewer() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState('');
  const [safe, setSafe] = useState(false);
  useEffect(() => {
    let p: Player;
    try {
      p = new Player(canvas.current!);
    } catch (e) {
      setErr((e as Error).message);
      return;
    }
    playerRef = p;
    const ro = new ResizeObserver(([e]) => p.setBox(e.contentRect.width, e.contentRect.height));
    ro.observe(wrap.current!);
    return () => {
      ro.disconnect();
      p.dispose();
      playerRef = null;
      playing.value = false;
    };
  }, []);
  const { total } = timeline.value;
  const fps = 30;
  const step = (d: number) => {
    playing.value = false;
    playhead.value = Math.max(0, Math.min(total, playhead.value + d));
  };
  const snapshot = async () => {
    const b = await playerRef?.snapshot();
    if (b) saveFile(b, `image-${timecode(playhead.value).replace(/:/g, '-')}.png`);
  };
  const fullscreen = () => {
    const el = wrap.current?.parentElement;
    if (!document.fullscreenElement) void el?.requestFullscreen?.();
    else void document.exitFullscreen();
  };
  return (
    <div class="viewer panel">
      <div class="viewer-head">
        <span class="vh-title">{project.value.title || 'Sans titre'}</span>
        <span class="vh-meta">
          {ASPECTS[project.value.aspect].label} · {THEMES[project.value.theme].label}
        </span>
        <div class="vh-right">
          <button class={'ibtn' + (safe ? ' on' : '')} title="Zones de sécurité" onClick={() => setSafe(!safe)}>
            <Icon name="grid" size={15} />
          </button>
          <button class="ibtn" title="Capture PNG de l’image affichée" onClick={snapshot}>
            <Icon name="camera" size={15} />
          </button>
          <button class="ibtn" title="Plein écran" onClick={fullscreen}>
            <Icon name="maximize" size={15} />
          </button>
        </div>
      </div>
      <div class="stage" ref={wrap} onDblClick={fullscreen}>
        <div class="stage-canvas">
          <canvas ref={canvas} />
          {safe && <div class="safe-area" />}
        </div>
        {err && <div class="stage-err">{err}</div>}
        {!project.value.clips.length && (
          <div class="stage-empty">
            <Icon name="film" size={34} />
            <p>Le montage est vide.</p>
            <small>Ajoutez des médias depuis la colonne de gauche ou lancez la création automatique.</small>
          </div>
        )}
      </div>
      <div class="transport">
        <span class="tc">{timecode(playhead.value, fps)}</span>
        <div class="transport-btns">
          <button class="ibtn" title="Début (Origine)" onClick={() => step(-1e9)}>
            <Icon name="skipBack" size={15} />
          </button>
          <button class="ibtn" title="Image précédente (←)" onClick={() => step(-1 / fps)}>
            <Icon name="stepBack" size={17} />
          </button>
          <button class="play-btn" title="Lecture / pause (Espace)" onClick={() => (playing.value = !playing.value)}>
            <Icon name={playing.value ? 'pause' : 'play'} size={20} />
          </button>
          <button class="ibtn" title="Image suivante (→)" onClick={() => step(1 / fps)}>
            <Icon name="stepFwd" size={17} />
          </button>
          <button class="ibtn" title="Fin" onClick={() => step(1e9)}>
            <Icon name="skipFwd" size={15} />
          </button>
        </div>
        <span class="tc tc-dim">{timecode(total, fps)}</span>
      </div>
    </div>
  );
}

function Pool() {
  const items = media.value.filter(usable);
  const add = (id: string) => {
    const m = mediaMap.value.get(id)!;
    const p = project.value;
    const th = THEMES[p.theme];
    const t = playhead.value;
    const { placed } = timeline.value;
    let idx = placed.findIndex((x) => x.start > t);
    if (idx < 0) idx = placed.length;
    const c = newClip({
      mediaId: id,
      duration: m.kind === 'video' ? Math.min(m.duration, 8) : p.photoDuration,
      transition: th.transitions[0],
      transitionDuration: th.transitionDuration,
      fit: m.height > m.width * 1.05 ? 'blur' : 'cover',
      motion: m.kind === 'video' ? 'none' : 'auto',
      volume: m.hasAudio ? 0.7 : 0,
    });
    updateProject((pp) => {
      const arr = [...pp.clips];
      arr.splice(idx, 0, c);
      return { clips: arr };
    });
    selectedClip.value = c.id;
    toast('Plan ajouté au montage', 'ok', 1500);
  };
  const used = new Set(project.value.clips.map((c) => c.mediaId));
  return (
    <aside class="pool panel">
      <div class="panel-head">
        <h4>Médiathèque</h4>
        <small>{items.length}</small>
      </div>
      <div class="pool-grid">
        {items.map((m) => (
          <button class={'pool-item' + (used.has(m.id) ? ' used' : '')} onClick={() => add(m.id)} title={`Ajouter à la tête de lecture\n${m.name}`}>
            <img src={m.thumb} alt="" loading="lazy" draggable={false} />
            {m.kind === 'video' && <span class="pool-dur">{fmtDuration(m.duration)}</span>}
            <span class="pool-time">{formatTime(m.date)}</span>
            <span class="pool-add">
              <Icon name="plus" size={14} />
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

const MOTIONS: { value: MotionId; label: string }[] = [
  { value: 'auto', label: 'Automatique' },
  { value: 'none', label: 'Fixe' },
  { value: 'zoomIn', label: 'Zoom avant' },
  { value: 'zoomOut', label: 'Zoom arrière' },
  { value: 'panLeft', label: 'Travelling gauche' },
  { value: 'panRight', label: 'Travelling droite' },
  { value: 'panUp', label: 'Panoramique haut' },
  { value: 'panDown', label: 'Panoramique bas' },
];

function ClipInspector({ c }: { c: Clip }) {
  const m = c.mediaId ? mediaMap.value.get(c.mediaId) : undefined;
  const isVideo = c.type === 'media' && m?.kind === 'video';
  const idx = project.value.clips.findIndex((x) => x.id === c.id);
  const set = (patch: Partial<Clip>, h = true) => updateClip(c.id, patch, h);
  const duplicate = () => {
    updateProject((p) => {
      const arr = [...p.clips];
      arr.splice(idx + 1, 0, { ...c, id: uid() });
      return { clips: arr };
    });
  };
  return (
    <>
      <div class="clip-preview">
        {m?.thumb && c.background !== 'black' && c.background !== 'gradient' ? <img src={m.thumb} alt="" /> : <div class="clip-preview-ph"><Icon name="type" size={26} /></div>}
        <div>
          <b>{c.type === 'title' ? 'Carton-titre' : m?.kind === 'video' ? 'Vidéo' : 'Photo'} · plan {idx + 1}</b>
          <small>{m ? `${m.name} · ${new Date(m.date).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Fond ' + (c.background === 'black' ? 'noir' : 'dégradé')}</small>
        </div>
      </div>
      <Section title="Durée & rythme">
        <Slider
          label="Durée à l’écran"
          value={c.duration}
          min={0.5}
          max={isVideo ? Math.max(0.6, (m!.duration - c.trimIn) / c.speed) : 12}
          step={0.05}
          format={(v) => v.toFixed(2) + ' s'}
          onInput={(v) => set({ duration: v }, false)}
        />
        {isVideo && (
          <>
            <Slider
              label="Point d’entrée (découpe)"
              value={c.trimIn}
              min={0}
              max={Math.max(0.01, m!.duration - 0.5)}
              step={0.05}
              format={(v) => `${v.toFixed(2)} s / ${m!.duration.toFixed(1)} s`}
              onInput={(v) => set({ trimIn: v, duration: Math.min(c.duration, (m!.duration - v) / c.speed) }, false)}
            />
            <Slider label="Vitesse" value={c.speed} min={0.25} max={2} step={0.05} format={(v) => `${v.toFixed(2)}×`} onInput={(v) => set({ speed: v, duration: Math.min(c.duration, (m!.duration - c.trimIn) / v) }, false)} />
            <Slider label="Volume du son" value={c.volume} min={0} max={1} step={0.01} format={(v) => (v ? Math.round(v * 100) + ' %' : 'Muet')} onInput={(v) => set({ volume: v }, false)} />
          </>
        )}
      </Section>
      {idx > 0 && (
        <Section title="Transition d’entrée">
          <div class="trans-grid">
            {TRANSITIONS.map((t) => (
              <button class={'trans-chip' + (c.transition === t.id ? ' on' : '')} onClick={() => set({ transition: t.id as TransitionId, transitionDuration: t.id === 'cut' ? 0 : c.transitionDuration || 0.8 })}>
                <i class={'tprev tp-' + t.id} />
                {t.label}
              </button>
            ))}
          </div>
          {c.transition !== 'cut' && (
            <Slider label="Durée de la transition" value={c.transitionDuration} min={0.2} max={2.5} step={0.05} format={(v) => v.toFixed(2) + ' s'} onInput={(v) => set({ transitionDuration: v }, false)} />
          )}
        </Section>
      )}
      {(c.type === 'media' || c.background === 'blur') && (
        <Section title="Cadrage & mouvement">
          <Select label="Mouvement (Ken Burns)" value={c.motion} options={MOTIONS} onChange={(v) => set({ motion: v })} />
          {c.type === 'media' && (
            <Segmented<FitMode>
              value={c.fit}
              onChange={(v) => set({ fit: v })}
              small
              options={[
                { value: 'cover', label: 'Remplir' },
                { value: 'blur', label: 'Fond flou' },
                { value: 'contain', label: 'Entier' },
              ]}
            />
          )}
        </Section>
      )}
      <Section
        title="Titre"
        right={
          !c.title ? (
            <button class="chip" onClick={() => set({ title: { text: 'Titre', sub: '', style: THEMES[project.value.theme].title, position: 'lower' } })}>
              <Icon name="plus" size={12} /> Ajouter
            </button>
          ) : c.type === 'media' ? (
            <button class="chip" onClick={() => set({ title: null })}>
              <Icon name="x" size={12} /> Retirer
            </button>
          ) : null
        }
      >
        {c.title && (
          <>
            <input class="input" value={c.title.text} placeholder="Titre" onInput={(e) => set({ title: { ...c.title!, text: (e.target as HTMLInputElement).value } }, false)} />
            <input class="input" value={c.title.sub} placeholder="Sous-titre" onInput={(e) => set({ title: { ...c.title!, sub: (e.target as HTMLInputElement).value } }, false)} />
            <div class="title-styles">
              {(Object.keys(TITLE_STYLES) as TitleStyleId[]).map((s) => (
                <button class={'tstyle ts-' + s + (c.title!.style === s ? ' on' : '')} onClick={() => set({ title: { ...c.title!, style: s } })}>
                  <span>Aa</span>
                  <small>{TITLE_STYLES[s].label}</small>
                </button>
              ))}
            </div>
            <Segmented
              small
              value={c.title.position}
              onChange={(v) => set({ title: { ...c.title!, position: v } })}
              options={[
                { value: 'top', label: 'Haut' },
                { value: 'center', label: 'Centre' },
                { value: 'lower', label: 'Bas' },
              ]}
            />
          </>
        )}
        {c.type === 'title' && (
          <Segmented<'black' | 'blur' | 'gradient'>
            small
            value={c.background ?? 'gradient'}
            onChange={(v) => set({ background: v })}
            options={[
              { value: 'gradient', label: 'Dégradé' },
              { value: 'black', label: 'Noir' },
              ...(c.mediaId ? [{ value: 'blur' as const, label: 'Photo floutée' }] : []),
            ]}
          />
        )}
      </Section>
      <div class="insp-actions">
        <button class="btn btn-ghost btn-sm" onClick={duplicate}>
          <Icon name="copy" size={14} /> Dupliquer
        </button>
        <button class="btn btn-danger btn-sm" onClick={() => removeClip(c.id)}>
          <Icon name="trash" size={14} /> Supprimer
        </button>
      </div>
    </>
  );
}

function StyleInspector() {
  const p = project.value;
  return (
    <>
      <Section title="Ambiance">
        <div class="theme-list">
          {(Object.keys(THEMES) as ThemeId[]).map((id) => (
            <button class={'theme-row' + (p.theme === id ? ' on' : '')} onClick={() => applyTheme(id, true)}>
              <i style={{ background: LOOKS[THEMES[id].look].swatch }} />
              <span>
                <b>{THEMES[id].label}</b>
                <small>{THEMES[id].tagline}</small>
              </span>
            </button>
          ))}
        </div>
        <p class="side-note">Changer d’ambiance recompose le montage (transitions, rythme, titres, musique).</p>
      </Section>
      <Section title="Format">
        <Segmented<AspectId>
          small
          value={p.aspect}
          onChange={(v) => updateProject({ aspect: v })}
          options={(Object.keys(ASPECTS) as AspectId[]).map((a) => ({ value: a, label: a, title: ASPECTS[a].label }))}
        />
        <Toggle label="Bandes cinéma 2,39:1" checked={p.letterbox} onChange={(v) => updateProject({ letterbox: v })} hint="En format paysage" />
      </Section>
      <Section title="Étalonnage">
        <div class="look-grid">
          {(Object.keys(LOOKS) as LookId[]).map((l) => (
            <button class={'look' + (p.look === l ? ' on' : '')} onClick={() => updateProject({ look: l })}>
              <i style={{ background: LOOKS[l].swatch }} />
              <span>{LOOKS[l].label}</span>
            </button>
          ))}
        </div>
        <Slider label="Intensité" value={p.lookIntensity} min={0} max={1} format={(v) => Math.round(v * 100) + ' %'} onInput={(v) => updateProject({ lookIntensity: v }, false)} />
        <Slider label="Halo lumineux" value={p.bloom} min={0} max={1} format={(v) => Math.round(v * 100) + ' %'} onInput={(v) => updateProject({ bloom: v }, false)} />
        <Slider label="Vignettage" value={p.vignette} min={0} max={1} format={(v) => Math.round(v * 100) + ' %'} onInput={(v) => updateProject({ vignette: v }, false)} />
        <Slider label="Grain argentique" value={p.grain} min={0} max={1} format={(v) => Math.round(v * 100) + ' %'} onInput={(v) => updateProject({ grain: v }, false)} />
      </Section>
      <Section title="Rythme du montage">
        <Slider label="Durée des photos" value={p.photoDuration} min={1} max={8} step={0.1} format={(v) => v.toFixed(1) + ' s'} onInput={(v) => updateProject({ photoDuration: v }, false)} />
        <Segmented<number>
          small
          value={p.targetLength}
          onChange={(v) => updateProject({ targetLength: v })}
          options={[
            { value: 30, label: '30 s' },
            { value: 60, label: '1 min' },
            { value: 120, label: '2 min' },
            { value: 180, label: '3 min' },
            { value: 0, label: 'Tout' },
          ]}
        />
        <button class="btn btn-ghost btn-block btn-sm" onClick={rebuildStory}>
          <Icon name="wand" size={14} /> Recomposer le montage
        </button>
      </Section>
      <Section title="Titre du film">
        <input class="input" value={p.title} placeholder="Titre" onInput={(e) => updateProject({ title: (e.target as HTMLInputElement).value }, false)} />
        <input class="input" value={p.subtitle} placeholder="Sous-titre" onInput={(e) => updateProject({ subtitle: (e.target as HTMLInputElement).value }, false)} />
        <button
          class="btn btn-quiet btn-sm"
          onClick={() =>
            updateProject((pp) => ({
              clips: pp.clips.map((c, i) =>
                c.type === 'title' && c.title && (i === 0 || i === pp.clips.length - 1)
                  ? { ...c, title: { ...c.title, text: pp.title, sub: i === 0 ? pp.subtitle : c.title.sub } }
                  : c,
              ),
            }))
          }
        >
          Appliquer aux cartons d’ouverture et de fin
        </button>
      </Section>
    </>
  );
}

function MusicInspector() {
  const p = project.value;
  const m = p.music;
  const fileRef = useRef<HTMLInputElement>(null);
  const setMusic = (patch: Partial<typeof m>, h = true) => updateProject((pp) => ({ music: { ...pp.music, ...patch } }), h);
  return (
    <>
      <Section title="Bande-son">
        <Segmented
          value={m.kind}
          onChange={(v) => {
            if (v === 'file' && !m.fileName) return fileRef.current?.click();
            setMusic({ kind: v, bpm: v === 'generated' ? MOODS[m.mood].bpm : m.bpm });
            void prepareMusic(true);
          }}
          options={[
            { value: 'generated', label: 'Composée' },
            { value: 'file', label: 'Mon morceau' },
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
        {musicBusy.value && <div class="busy-line">Préparation de la musique…</div>}
      </Section>
      {m.kind === 'generated' && (
        <Section title="Composition originale (générée sur l’appareil)">
          <div class="mood-list">
            {(Object.keys(MOODS) as MusicMood[]).map((k) => (
              <button
                class={'mood' + (m.mood === k ? ' on' : '')}
                onClick={() => {
                  setMusic({ mood: k, bpm: MOODS[k].bpm });
                  void prepareMusic(true);
                }}
              >
                <Icon name="music" size={16} />
                <span>
                  <b>{MOODS[k].label}</b>
                  <small>
                    {MOODS[k].desc} · {MOODS[k].bpm} BPM
                  </small>
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}
      {m.kind === 'file' && (
        <Section title="Morceau importé">
          <div class="file-row">
            <Icon name="music" size={16} />
            <span>{m.fileName || 'Aucun fichier'}</span>
            <button class="chip" onClick={() => fileRef.current?.click()}>
              Changer
            </button>
          </div>
          <Slider label="Départ dans le morceau" value={m.offset} min={0} max={120} step={0.1} format={(v) => v.toFixed(1) + ' s'} onInput={(v) => setMusic({ offset: v }, false)} />
          <p class="side-note">Tempo détecté : {m.bpm} BPM. Le fichier reste sur votre appareil.</p>
        </Section>
      )}
      {m.kind !== 'none' && (
        <Section title="Mixage">
          <Slider label="Volume de la musique" value={m.volume} min={0} max={1} format={(v) => Math.round(v * 100) + ' %'} onInput={(v) => setMusic({ volume: v }, false)} />
          <Toggle label="Atténuer pendant les vidéos" hint="Laisse entendre le son des vidéos" checked={m.ducking} onChange={(v) => setMusic({ ducking: v })} />
          <Toggle label="Caler les coupes sur le tempo" hint={`${m.bpm} BPM — appliqué à la recomposition`} checked={m.beatSync} onChange={(v) => setMusic({ beatSync: v })} />
          {m.beatSync && (
            <button class="btn btn-ghost btn-block btn-sm" onClick={rebuildStory}>
              <Icon name="wand" size={14} /> Recomposer en rythme
            </button>
          )}
        </Section>
      )}
    </>
  );
}

function Inspector() {
  const [tab, setTab] = useState<'clip' | 'style' | 'music'>('style');
  const sel = selectedClip.value;
  const clip = sel ? project.value.clips.find((c) => c.id === sel) : undefined;
  useEffect(() => {
    if (sel) setTab('clip');
  }, [sel]);
  return (
    <aside class="inspector panel">
      <div class="insp-tabs">
        <button class={tab === 'clip' ? 'on' : ''} onClick={() => setTab('clip')}>
          <Icon name="image" size={15} /> Plan
        </button>
        <button class={tab === 'style' ? 'on' : ''} onClick={() => setTab('style')}>
          <Icon name="palette" size={15} /> Style
        </button>
        <button class={tab === 'music' ? 'on' : ''} onClick={() => setTab('music')}>
          <Icon name="music" size={15} /> Musique
        </button>
      </div>
      <div class="insp-body">
        {tab === 'clip' &&
          (clip ? (
            <ClipInspector key={clip.id} c={clip} />
          ) : (
            <div class="empty-note">
              <Icon name="info" />
              Sélectionnez un plan dans la timeline pour régler sa durée, sa transition, son cadrage, son titre ou découper une vidéo.
            </div>
          ))}
        {tab === 'style' && <StyleInspector />}
        {tab === 'music' && <MusicInspector />}
      </div>
    </aside>
  );
}

export function EditPage() {
  const mp = mobilePanel.value;
  return (
    <div class={'edit-page mp-' + mp}>
      <Pool />
      <Viewer />
      <Inspector />
      <Timeline />
      <nav class="mobile-switch">
        <button class={mp === 'media' ? 'on' : ''} onClick={() => (mobilePanel.value = 'media')}>
          <Icon name="image" size={16} /> Médias
        </button>
        <button class={mp === 'viewer' ? 'on' : ''} onClick={() => (mobilePanel.value = 'viewer')}>
          <Icon name="film" size={16} /> Timeline
        </button>
        <button class={mp === 'inspector' ? 'on' : ''} onClick={() => (mobilePanel.value = 'inspector')}>
          <Icon name="sliders" size={16} /> Réglages
        </button>
      </nav>
    </div>
  );
}
