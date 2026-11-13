// Vue « Vidéos » du montage : seulement les plans vidéo, chacun avec sa découpe début / fin.
import { effect, signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { mediaMap, playhead, playing, removeClip, selectedClip, timeline } from '../state/store';
import { setVideoBounds } from '../state/actions';
import type { Placed } from '../story/timeline';
import { TrimBar } from './TrimBar';
import { Icon } from './icons';

/** Lecture d'un extrait : arrêt automatique à la fin du plan. */
const stopAt = signal<number | null>(null);
effect(() => {
  const t = playhead.value;
  const s = stopAt.peek();
  if (s === null) return;
  if (!playing.peek()) {
    stopAt.value = null;
    return;
  }
  if (t >= s) {
    playing.value = false;
    stopAt.value = null;
    playhead.value = s;
  }
});

const mmss = (v: number) => {
  const m = Math.floor(v / 60);
  return `${m}:${(v - m * 60).toFixed(1).padStart(4, '0')}`;
};

function videoClips(): Placed[] {
  const media = mediaMap.value;
  return timeline.value.placed.filter((p) => p.clip.type === 'media' && !p.clip.extra?.length && p.clip.mediaId && media.get(p.clip.mediaId)?.kind === 'video');
}

export const videoCount = () => videoClips().length;

function focus(p: Placed) {
  selectedClip.value = p.clip.id;
  playing.value = false;
  playhead.value = p.start + 0.01;
}

function playCut(p: Placed) {
  selectedClip.value = p.clip.id;
  playing.value = false;
  playhead.value = p.start + 0.01;
  stopAt.value = p.end - 0.06;
  playing.value = true;
}

export function VideoCuts() {
  const vids = videoClips();
  const media = mediaMap.value;
  const sel = selectedClip.value;
  useEffect(() => {
    if (sel) document.querySelector(`.vc[data-clip="${sel}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [sel]);
  if (!vids.length) return <div class="vc-empty">Aucune vidéo dans le montage</div>;
  return (
    <div class="vcuts">
      {vids.map((p, i) => {
        const m = media.get(p.clip.mediaId!)!;
        const c = p.clip;
        const open = c.id === sel;
        const D = Math.max(0.01, m.duration);
        const a = c.trimIn,
          b = Math.min(D, c.trimIn + c.duration * c.speed);
        return (
          <div class={'vc' + (open ? ' open' : '')} data-clip={c.id}>
            <button class="vc-head" onClick={() => (open ? (selectedClip.value = null) : focus(p))} aria-expanded={open}>
              {m.thumb ? <img src={m.thumb} alt="" /> : <i class="vc-ph" />}
              <span class="vc-txt">
                <b>
                  {i + 1}. {m.name}
                </b>
                <small>
                  {mmss(a)} → {mmss(b)} · <em>{(b - a).toFixed(1)} s</em> sur {D.toFixed(0)} s
                </small>
                <span class="vc-range">
                  <i style={{ left: `${(a / D) * 100}%`, width: `${((b - a) / D) * 100}%` }} />
                </span>
              </span>
              <span class="vc-chev">
                <Icon name={open ? 'x' : 'scissors'} size={16} />
              </span>
            </button>
            {open && (
              <div class="vc-body">
                <TrimBar c={c} m={m} compact />
                <div class="vc-actions">
                  <button class="btn btn-primary btn-sm" onClick={() => playCut(p)}>
                    <Icon name="play" size={14} /> Lire l’extrait
                  </button>
                  <button class="btn btn-ghost btn-sm" disabled={b - a >= D - 0.05} onClick={() => setVideoBounds(c.id, 0, D)}>
                    Toute la vidéo
                  </button>
                  <button class="btn btn-ghost btn-sm" disabled={i === vids.length - 1} onClick={() => focus(vids[i + 1])}>
                    Suivante <Icon name="stepFwd" size={14} />
                  </button>
                  <button class="ibtn vc-del" title="Retirer cette vidéo du film" onClick={() => removeClip(c.id)}>
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
