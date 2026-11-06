// Visionneuse plein écran de la médiathèque : photo en grand (zoom), vidéo lisible (MTS compris),
// navigation au clavier, informations et actions.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { MediaItem } from '../types';
import { forceInclude, sameFolder, shiftFolderDates, toggleExcluded, useDateCandidate } from '../state/actions';
import { DATE_SOURCE_LABEL } from '../media/dates';
import { DecodedVideo } from './decoded';
import { extractAudio } from '../audio/mix';
import { decoderFailed, useDecoder } from '../media/playback';
import { Icon } from './icons';
import { fmtBytes, fmtDuration } from '../util';

const toLocalInput = (t: number) => {
  const d = new Date(t);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
};
const fmtDate = (t: number) => new Date(t).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** Dates trouvées dans le fichier + décalage du dossier. */
function DatesPanel({ m }: { m: MediaItem }) {
  const [shift, setShift] = useState(false);
  const [v, setV] = useState(toLocalInput(m.date));
  useEffect(() => {
    setShift(false);
    setV(toLocalInput(m.date));
  }, [m.id, m.date]);
  const folder = sameFolder(m);
  const dates = m.dates ?? [];
  return (
    <div class="mv-dates">
      <span class="mv-sub">Dates trouvées dans le fichier</span>
      {!dates.length && <p class="side-note">Aucune date inscrite dans ce fichier.</p>}
      {dates.map((d) => {
        const used = Math.abs(d.t - m.date) < 1000;
        return (
          <div class={'mv-date' + (used ? ' used' : '')}>
            <div>
              <b>{fmtDate(d.t)}</b>
              <small>{d.label}</small>
            </div>
            {used ? (
              <span class="mv-used">
                <Icon name="check" size={13} /> utilisée
              </span>
            ) : (
              <div class="mv-date-act">
                <button class="chip" onClick={() => useDateCandidate(m.id, d.key, false)}>
                  Utiliser
                </button>
                {folder.length > 1 && (
                  <button class="chip" title={`Même type de date pour les ${folder.length} médias du dossier`} onClick={() => useDateCandidate(m.id, d.key, true)}>
                    Tout le dossier
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {folder.length > 1 &&
        (shift ? (
          <div class="mv-shift">
            <span class="field-label">Date et heure exactes de ce média</span>
            <input id="mv-shift-date" class="input" type="datetime-local" value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} />
            <p class="side-note">Les {folder.length} médias du dossier seront décalés d’autant (appareil dont l’horloge était mal réglée).</p>
            <div class="mv-actions">
              <button class="btn btn-quiet btn-sm" onClick={() => setShift(false)}>
                Annuler
              </button>
              <button
                class="btn btn-primary btn-sm"
                onClick={() => {
                  shiftFolderDates(m.id, new Date(v).getTime());
                  setShift(false);
                }}
              >
                Décaler {folder.length} médias
              </button>
            </div>
          </div>
        ) : (
          <button class="btn btn-ghost btn-sm" onClick={() => setShift(true)}>
            <Icon name="clock" size={14} /> Décaler tout le dossier…
          </button>
        ))}
    </div>
  );
}

function PhotoView({ m }: { m: MediaItem }) {
  const [url, setUrl] = useState('');
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    setZoom(false);
    if (m.file) {
      const u = URL.createObjectURL(m.file);
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    }
    if (m.demo) {
      const s = Math.min(1, 2400 / Math.max(m.width, m.height));
      setUrl(m.demo.draw(Math.round(m.width * s), Math.round(m.height * s)).toDataURL('image/jpeg', 0.92));
    } else setUrl(m.thumb);
  }, [m.id]);
  return (
    <div class={'mv-photo' + (zoom ? ' zoomed' : '')} onClick={() => setZoom(!zoom)} title={zoom ? 'Ajuster à l’écran' : 'Taille réelle'}>
      {url ? <img src={url} alt={m.name} draggable={false} /> : <span class="mv-loading">Chargement…</span>}
    </div>
  );
}

/** Lecteur pour les vidéos que le navigateur ne lit pas nativement (MTS…). */
function DecodedPlayer({ m, onFail }: { m: MediaItem; onFail?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [play, setPlay] = useState(false);
  const [status, setStatus] = useState('Décodage…');
  const ref = useRef<{ dv: DecodedVideo; audio: AudioContext | null; buf: AudioBuffer | null; node: AudioBufferSourceNode | null; t0: number; c0: number; raf: number } | null>(null);
  useEffect(() => {
    const dv = new DecodedVideo(m.file!, () => setStatus(''), 1920, !m.decode);
    host.current!.appendChild(dv.canvas);
    const st = { dv, audio: null as AudioContext | null, buf: null as AudioBuffer | null, node: null as AudioBufferSourceNode | null, t0: 0, c0: 0, raf: 0 };
    ref.current = st;
    dv.seek(0);
    const check = setInterval(() => {
      if (!dv.failed) return;
      if (onFail) onFail();
      else setStatus('Cette vidéo ne peut pas être décodée par ce navigateur.');
    }, 500);
    // son (vidéos de moins de 15 min)
    if (m.hasAudio && m.duration < 900) void extractAudio(m.file!, 0, m.duration).then((b) => (st.buf = b));
    return () => {
      clearInterval(check);
      cancelAnimationFrame(st.raf);
      try {
        st.node?.stop();
      } catch {
        /* rien */
      }
      void st.audio?.close();
      dv.dispose();
      dv.canvas.remove();
    };
  }, [m.id]);
  const start = (from: number) => {
    const st = ref.current!;
    st.t0 = from;
    st.c0 = performance.now();
    if (st.buf) {
      st.audio ??= new AudioContext();
      void st.audio.resume();
      st.node = st.audio.createBufferSource();
      st.node.buffer = st.buf;
      st.node.connect(st.audio.destination);
      st.node.start(0, from);
    }
    const tick = () => {
      const now = st.t0 + (performance.now() - st.c0) / 1000;
      if (now >= m.duration) {
        stop();
        setT(m.duration);
        return;
      }
      st.dv.update(now);
      setT(now);
      st.raf = requestAnimationFrame(tick);
    };
    st.raf = requestAnimationFrame(tick);
    setPlay(true);
  };
  const stop = () => {
    const st = ref.current!;
    cancelAnimationFrame(st.raf);
    try {
      st.node?.stop();
    } catch {
      /* rien */
    }
    st.node = null;
    st.dv.stop();
    setPlay(false);
  };
  const seek = (v: number) => {
    const was = play;
    if (was) stop();
    setT(v);
    ref.current!.dv.seek(v);
    if (was) start(v);
  };
  return (
    <div class="mv-video">
      <div class="mv-canvas" ref={host} onClick={() => (play ? stop() : start(t >= m.duration - 0.05 ? 0 : t))} />
      {status && <span class="mv-loading">{status}</span>}
      <div class="mv-ctrl">
        <button class="play-btn" onClick={() => (play ? stop() : start(t >= m.duration - 0.05 ? 0 : t))} aria-label={play ? 'Pause' : 'Lecture'}>
          <Icon name={play ? 'pause' : 'play'} size={18} />
        </button>
        <input type="range" min={0} max={m.duration} step={0.01} value={t} style={{ '--p': `${(t / Math.max(0.01, m.duration)) * 100}%` }} onInput={(e) => seek(Number((e.target as HTMLInputElement).value))} />
        <span class="tc">
          {fmtClock(t)} / {fmtClock(m.duration)}
        </span>
      </div>
    </div>
  );
}

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function VideoView({ m }: { m: MediaItem }) {
  const [url, setUrl] = useState('');
  const [fallback, setFallback] = useState(useDecoder(m));
  useEffect(() => {
    setFallback(useDecoder(m));
    if (!m.file) return;
    const u = URL.createObjectURL(m.file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [m.id]);
  if (!m.file) return <div class="mv-photo">{m.thumb && <img src={m.thumb} alt="" />}</div>;
  if (fallback)
    return (
      <DecodedPlayer
        key={m.id}
        m={m}
        onFail={
          m.decode
            ? undefined
            : () => {
                decoderFailed(m);
                setFallback(false);
              }
        }
      />
    );
  return (
    <div class="mv-video">
      <video
        src={url}
        controls
        autoPlay
        playsInline
        onError={() => {
          m.decode = true;
          setFallback(true);
        }}
      />
    </div>
  );
}

export function MediaViewer({ list, index, onIndex, onClose, onDate }: { list: MediaItem[]; index: number; onIndex: (i: number) => void; onClose: () => void; onDate: (m: MediaItem) => void }) {
  const m = list[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && index < list.length - 1) onIndex(index + 1);
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, list.length]);
  if (!m) return null;
  const status = m.duplicateOf ? 'Doublon (ignoré)' : m.similarTo ? (m.kind === 'video' ? 'Vidéo Live Photo (ignorée)' : 'Quasi-doublon (ignoré)') : m.skipReason ? `${m.skipReason} (écartée)` : m.excluded ? 'Exclu' : m.error ? m.error : 'Retenu pour le film';
  return (
    <div class="mv" role="dialog" aria-label="Visionneuse">
      <div class="mv-stage">
        {m.kind === 'photo' ? <PhotoView m={m} /> : <VideoView m={m} />}
        <button class="mv-nav mv-prev" disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Précédent">
          <Icon name="stepBack" size={26} />
        </button>
        <button class="mv-nav mv-next" disabled={index >= list.length - 1} onClick={() => onIndex(index + 1)} aria-label="Suivant">
          <Icon name="stepFwd" size={26} />
        </button>
        <span class="mv-count">
          {index + 1} / {list.length}
        </span>
      </div>
      <aside class="mv-info">
        <div class="mv-head">
          <b title={m.name}>{m.name}</b>
          <button class="ibtn" onClick={onClose} aria-label="Fermer (Échap)">
            <Icon name="x" size={18} />
          </button>
        </div>
        <dl>
          <dt>Date</dt>
          <dd>
            {new Date(m.date).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' })}
            <small>{DATE_SOURCE_LABEL[m.dateSource]}</small>
          </dd>
          <dt>Statut</dt>
          <dd>{status}</dd>
          <dt>{m.kind === 'video' ? 'Vidéo' : 'Photo'}</dt>
          <dd>
            {m.width} × {m.height}
            {m.kind === 'video' ? ` · ${fmtDuration(m.duration)}${m.hasAudio ? ' · avec son' : ' · sans son'}` : ''}
            {m.size ? ` · ${fmtBytes(m.size)}` : ''}
          </dd>
          {m.camera && (
            <>
              <dt>Appareil</dt>
              <dd>{m.camera}</dd>
            </>
          )}
          <dt>Emplacement</dt>
          <dd class="mv-path">{m.path}</dd>
          <dt>Qualité estimée</dt>
          <dd>
            <span class="score big" style={{ '--s': m.score }} /> {Math.round(m.score * 100)} %
          </dd>
        </dl>
        <DatesPanel m={m} />
        <div class="mv-actions">
          <button class="btn btn-ghost btn-sm" onClick={() => onDate(m)}>
            <Icon name="calendar" size={14} /> Corriger la date
          </button>
          {m.duplicateOf || m.similarTo ? (
            <button class="btn btn-ghost btn-sm" onClick={() => forceInclude(m.id)}>
              <Icon name="plus" size={14} /> Garder aussi
            </button>
          ) : (
            !m.error && (
              <button class="btn btn-ghost btn-sm" onClick={() => toggleExcluded(m.id)}>
                <Icon name={m.excluded ? 'eye' : 'eyeOff'} size={14} /> {m.excluded ? 'Inclure' : 'Exclure'}
              </button>
            )
          )}
        </div>
        <p class="side-note">← → pour naviguer · clic sur la photo pour la taille réelle · Échap pour fermer</p>
      </aside>
    </div>
  );
}
