// Barre de découpe d'un plan vidéo : point d'entrée et point de sortie.
import type { Clip, MediaItem } from '../types';
import { playhead, playing, timeline, updateClip } from '../state/store';
import { rememberCut, setVideoBounds } from '../state/actions';
import { RangeBar } from './RangeBar';
import { Icon } from './icons';

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};

export function TrimBar({ c, m, compact }: { c: Clip; m: MediaItem; compact?: boolean }) {
  const D = Math.max(0.01, m.duration);
  const inT = c.trimIn;
  const outT = Math.min(D, c.trimIn + c.duration * c.speed);
  const placed = timeline.value.placed.find((p) => p.clip.id === c.id);
  const show = (where: 'in' | 'out') => {
    const cur = timeline.value.placed.find((p) => p.clip.id === c.id);
    if (!cur) return;
    playing.value = false;
    playhead.value = where === 'in' ? cur.start + 0.01 : Math.max(cur.start, cur.end - 1 / 30);
  };
  // temps source de l'image affichée, si la tête de lecture est sur ce plan
  const atPlayhead = placed && playhead.value >= placed.start && playhead.value <= placed.end ? c.trimIn + (playhead.value - placed.start) * c.speed : null;
  const set = (a: number, b: number, history: boolean) =>
    updateClip(c.id, { trimIn: Math.round(a * 100) / 100, duration: Math.round(((b - a) / c.speed) * 100) / 100 }, history);

  return (
    <div class="trimbox">
      <div class="trim-head">
        <span>
          Début <b>{fmt(inT)}</b>
        </span>
        <span>
          Fin <b>{fmt(outT)}</b>
        </span>
        <span>
          Extrait <b>{(outT - inT).toFixed(1)} s</b> / {D.toFixed(1)} s
        </span>
      </div>
      <RangeBar
        m={m}
        a={inT}
        b={outT}
        at={atPlayhead}
        onLive={(a, b, edge) => {
          set(a, b, false);
          show(edge === 'out' ? 'out' : 'in');
        }}
        onCommit={(a, b, edge) => {
          set(a, b, false);
          rememberCut(c.id);
          requestAnimationFrame(() => show(edge === 'out' ? 'out' : 'in'));
        }}
        onSeek={(t) => {
          if (!placed) return;
          playing.value = false;
          playhead.value = placed.start + (t - inT) / c.speed;
        }}
      />
      <div class="trim-fields">
        <label>
          Début (s)
          <input id="trim-in" class="input" type="number" min={0} max={D} step={0.1} value={inT.toFixed(2)} onChange={(e) => setVideoBounds(c.id, Number((e.target as HTMLInputElement).value), null)} />
        </label>
        <label>
          Fin (s)
          <input id="trim-out" class="input" type="number" min={0} max={D} step={0.1} value={outT.toFixed(2)} onChange={(e) => setVideoBounds(c.id, null, Number((e.target as HTMLInputElement).value))} />
        </label>
      </div>
      <div class="trim-btns">
        <button class="btn btn-ghost btn-sm" disabled={atPlayhead === null} onClick={() => atPlayhead !== null && setVideoBounds(c.id, atPlayhead, null)} title="Raccourci : I">
          <Icon name="stepBack" size={13} /> Début ici
        </button>
        <button class="btn btn-ghost btn-sm" disabled={atPlayhead === null} onClick={() => atPlayhead !== null && setVideoBounds(c.id, null, atPlayhead)} title="Raccourci : O">
          Fin ici <Icon name="stepFwd" size={13} />
        </button>
        {!compact && (
          <button class="btn btn-quiet btn-sm" onClick={() => setVideoBounds(c.id, 0, D)} title="Utiliser toute la vidéo">
            Tout
          </button>
        )}
      </div>
      {!compact && <p class="side-note">Glissez les poignées ou touchez la bande : avant l’extrait = début, après = fin.</p>}
    </div>
  );
}
