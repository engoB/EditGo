// Médiathèque, filtre « Vidéos » : chaque vidéo avec son extrait (début / fin), réglable avant même
// de créer le film. Aperçu intégré, lecture de l'extrait seul.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { MediaItem } from '../types';
import { setMediaCut, toggleExcluded } from '../state/actions';
import { cutOf } from '../media/cut';
import { DecodedVideo } from './decoded';
import { extractAudio } from '../audio/mix';
import { RangeBar, type Edge } from './RangeBar';
import { Icon } from './icons';
import { formatDayShort, formatTime } from '../util';

const mmss = (v: number) => {
  const m = Math.floor(v / 60);
  return `${m}:${(v - m * 60).toFixed(1).padStart(4, '0')}`;
};

/** Aperçu d'une vidéo : image à un instant donné, ou lecture d'un intervalle (avec le son). */
function useCutPreview(m: MediaItem, host: { current: HTMLDivElement | null }) {
  const dv = useRef<DecodedVideo | null>(null);
  const run = useRef<{ raf: number; ctx: AudioContext | null; node: AudioBufferSourceNode | null } | null>(null);
  const [t, setT] = useState<number | null>(null);
  const [playingCut, setPlaying] = useState(false);
  useEffect(() => {
    if (!m.file) return;
    const d = new DecodedVideo(m.file, () => null, 960, !m.decode);
    dv.current = d;
    host.current?.appendChild(d.canvas);
    d.seek(cutOf(m).a);
    return () => {
      stop();
      d.dispose();
      d.canvas.remove();
      dv.current = null;
    };
  }, [m.id]);
  const stop = () => {
    const r = run.current;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    try {
      r.node?.stop();
    } catch {
      /* déjà arrêté */
    }
    void r.ctx?.close();
    run.current = null;
    dv.current?.stop();
    setPlaying(false);
  };
  const seek = (x: number) => {
    stop();
    setT(x);
    dv.current?.seek(x);
  };
  const play = (a: number, b: number) => {
    stop();
    const d = dv.current;
    if (!d) return;
    // contexte audio créé pendant le toucher (exigence iPhone), le son arrive dès qu'il est extrait
    const ctx = m.hasAudio ? new AudioContext() : null;
    const r = { raf: 0, ctx, node: null as AudioBufferSourceNode | null };
    run.current = r;
    setPlaying(true);
    const c0 = performance.now();
    if (ctx)
      void extractAudio(m.file!, a, b).then((buf) => {
        if (run.current !== r || !buf) return;
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.connect(ctx.destination);
        const off = (performance.now() - c0) / 1000;
        if (off < buf.duration) node.start(0, off);
        r.node = node;
      });
    const tick = () => {
      const now = a + (performance.now() - c0) / 1000;
      if (now >= b) {
        stop();
        seek(b - 0.05);
        return;
      }
      d.update(now);
      setT(now);
      r.raf = requestAnimationFrame(tick);
    };
    r.raf = requestAnimationFrame(tick);
  };
  return { t, seek, play, stop, playing: playingCut, failed: () => !!dv.current?.failed };
}

function CutEditor({ m, onNext }: { m: MediaItem; onNext?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const pv = useCutPreview(m, host);
  const { a, b } = cutOf(m);
  const D = m.duration;
  const edgeTime = (na: number, nb: number, edge: Edge) => (edge === 'out' ? nb - 0.05 : na);
  return (
    <div class="mc-body">
      <div class="mc-preview" ref={host} onClick={() => (pv.playing ? pv.stop() : pv.play(a, b))}>
        {!m.file && <span class="mc-msg">Fichier inaccessible</span>}
        {!pv.playing && m.file && (
          <span class="mc-play">
            <Icon name="play" size={22} />
          </span>
        )}
      </div>
      <div class="mc-side">
        <div class="trim-head">
          <span>
            Début <b>{mmss(a)}</b>
          </span>
          <span>
            Fin <b>{mmss(b)}</b>
          </span>
          <span>
            <b>{(b - a).toFixed(1)} s</b> / {D.toFixed(0)} s
          </span>
        </div>
        <RangeBar
          m={m}
          a={a}
          b={b}
          at={pv.t}
          onLive={(na, nb, edge) => {
            setMediaCut(m.id, na, nb, false);
            pv.seek(edgeTime(na, nb, edge));
          }}
          onCommit={(na, nb, edge) => {
            setMediaCut(m.id, na, nb, false);
            pv.seek(edgeTime(na, nb, edge));
          }}
          onSeek={(x) => pv.seek(x)}
        />
        <div class="vc-actions">
          <button class="btn btn-primary btn-sm" disabled={!m.file} onClick={() => (pv.playing ? pv.stop() : pv.play(a, b))}>
            <Icon name={pv.playing ? 'pause' : 'play'} size={14} /> {pv.playing ? 'Pause' : 'Lire l’extrait'}
          </button>
          <button class="btn btn-ghost btn-sm" disabled={pv.t == null || pv.t >= b - 0.2} onClick={() => pv.t != null && setMediaCut(m.id, pv.t, b)}>
            Début ici
          </button>
          <button class="btn btn-ghost btn-sm" disabled={pv.t == null || pv.t <= a + 0.2} onClick={() => pv.t != null && setMediaCut(m.id, a, pv.t)}>
            Fin ici
          </button>
          <button class="btn btn-quiet btn-sm" disabled={!m.cutIn && m.cutOut == null} onClick={() => setMediaCut(m.id, 0, D)}>
            Toute la vidéo
          </button>
          {onNext && (
            <button class="btn btn-ghost btn-sm" onClick={onNext}>
              Suivante <Icon name="stepFwd" size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function MediaCuts({ items }: { items: MediaItem[] }) {
  const vids = items.filter((m) => m.kind === 'video');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (open) document.querySelector(`.mc[data-id="${open}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open]);
  if (!vids.length) return <div class="empty-note">Aucune vidéo.</div>;
  return (
    <div class="mcuts">
      {vids.map((m, i) => {
        const { a, b, set } = cutOf(m);
        const D = Math.max(0.01, m.duration);
        const isOpen = open === m.id;
        const off = m.excluded || !!m.duplicateOf;
        return (
          <div class={'vc mc' + (isOpen ? ' open' : '') + (off ? ' off' : '')} data-id={m.id}>
            <button class="vc-head" onClick={() => setOpen(isOpen ? null : m.id)} aria-expanded={isOpen}>
              {m.thumb ? <img src={m.thumb} alt="" /> : <i class="vc-ph" />}
              <span class="vc-txt">
                <b>{m.name}</b>
                <small>
                  {formatDayShort(m.date)} · {formatTime(m.date)} · {set ? <em>{(b - a).toFixed(1)} s</em> : 'entière'} sur {D.toFixed(0)} s{off ? ' · écartée' : ''}
                </small>
                <span class="vc-range">
                  <i style={{ left: `${(a / D) * 100}%`, width: `${((b - a) / D) * 100}%` }} />
                </span>
              </span>
              <span class="vc-chev">
                <Icon name={isOpen ? 'x' : 'scissors'} size={16} />
              </span>
            </button>
            {isOpen && (
              <>
                <CutEditor m={m} onNext={i < vids.length - 1 ? () => setOpen(vids[i + 1].id) : undefined} />
                <div class="mc-foot">
                  <button class="btn btn-quiet btn-sm" onClick={() => toggleExcluded(m.id)}>
                    <Icon name={m.excluded ? 'eye' : 'eyeOff'} size={14} /> {m.excluded ? 'Inclure dans le film' : 'Ne pas utiliser'}
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
