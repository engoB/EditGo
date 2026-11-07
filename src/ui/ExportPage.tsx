import { useEffect, useRef, useState } from 'preact/hooks';
import { mediaMap, musicBuffer, playhead, project, timeline, toast, musicBusy } from '../state/store';
import { prepareMusic } from '../state/actions';
import { grantPendingAccess, pendingAccess } from '../state/persist';
import { EXPORT_PRESETS, dimsFor, ASPECTS } from '../presets';
import type { AspectId } from '../types';
import type { Container, ExportDest, ExportJob, QualityLevel } from '../export/exporter';
const loadExporter = () => lazy(() => import('../export/exporter'));
import { lazy } from '../lazy';
import { Icon } from './icons';
import { Segmented, Toggle } from './controls';
import { downloadBlob, saveFile, fmtBytes, fmtDuration } from '../util';
import { canUseOpfsWorker, opfsWorkerStream } from '../export/opfsWriter';

interface Done {
  savedTo?: string;
  name: string;
  blob: Blob;
  url: string;
  codec: string;
  seconds: number;
  label: string;
}

const BITRATE_EST: Record<QualityLevel, number> = { standard: 0.07, high: 0.12, max: 0.2 }; // bits par pixel par image (approx.)

export function ExportPage() {
  const p = project.value;
  const { total, placed } = timeline.value;
  const [res, setRes] = useState(1080);
  const [extra, setExtra] = useState<string[]>([]);
  const [container, setContainer] = useState<Container>('mp4');
  const [fps, setFps] = useState(30);
  const [quality, setQuality] = useState<QualityLevel>('high');
  const [audio, setAudio] = useState(true);
  const isMobile = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const canShareFiles = typeof navigator.canShare === 'function';
  const canPickDir = !isMobile && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  const [toFolder, setToFolder] = useState(true);
  const [codecs, setCodecs] = useState<{ mp4: string | null; webm: string | null } | null>(null);
  const [run, setRun] = useState<{ job: number; jobs: number; label: string; frac: number; stage: string; eta: string } | null>(null);
  const [done, setDone] = useState<Done[]>([]);
  const abort = useRef<AbortController | null>(null);
  const prev = useRef<HTMLCanvasElement>(null);
  const webcodecs = typeof VideoEncoder !== 'undefined';

  useEffect(() => {
    if (webcodecs) void loadExporter().then((m) => m.probeCodecs(1920, 1080)).then(setCodecs).catch(() => setCodecs({ mp4: null, webm: null }));
  }, []);
  useEffect(() => () => done.forEach((d) => URL.revokeObjectURL(d.url)), []);

  const main = dimsFor(p.aspect, res);
  const jobs: ExportJob[] = [
    { label: `${ASPECTS[p.aspect].label} · ${res === 2160 ? '4K' : res + 'p'}`, width: main.w, height: main.h, fps, container, quality, audio },
    ...extra.map((id) => {
      const pr = EXPORT_PRESETS.find((x) => x.id === id)!;
      const { w, h } = dimsFor(pr.aspect === 'project' ? p.aspect : pr.aspect, pr.short);
      return { label: pr.label, width: w, height: h, fps, container, quality, audio };
    }),
  ];
  // médias du montage dont le fichier d'origine n'est pas accessible (export en basse définition sinon)
  const usedIds = new Set(p.clips.flatMap((c) => (c.type === 'media' || c.background === 'blur' ? [c.mediaId, ...(c.extra ?? [])] : [])).filter(Boolean) as string[]);
  const unavailable = [...usedIds].map((id) => mediaMap.value.get(id)).filter((m) => m && !m.file && !m.demo).length;
  const estBytes = jobs.reduce((s, j) => s + (j.width * j.height * j.fps * BITRATE_EST[quality] * total) / 8 + (audio ? (total * 256000) / 8 : 0), 0);

  const start = async () => {
    if (!placed.length) return toast('Le montage est vide.', 'warn');
    // 1. destination, avant toute autre attente (le navigateur l'exige juste après le clic)
    let dir: FileSystemDirectoryHandle | null = null;
    if (toFolder && canPickDir) {
      try {
        dir = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({
          mode: 'readwrite',
          id: 'editgo-export',
          startIn: 'videos',
        });
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return;
        dir = null;
      }
    }
    if (audio && p.music.kind !== 'none' && !musicBuffer.value) await prepareMusic();
    const ac = new AbortController();
    abort.current = ac;
    // écran maintenu allumé pendant l'export (sinon le téléphone suspend la page)
    let lock: WakeLockSentinel | null = null;
    const keepAwake = async () => {
      try {
        if (document.visibilityState === 'visible') lock = (await navigator.wakeLock?.request('screen')) ?? null;
      } catch {
        lock = null;
      }
    };
    let wasHidden = false;
    const onVis = () => {
      if (document.visibilityState === 'visible') void keepAwake();
      else wasHidden = true;
    };
    await keepAwake();
    document.addEventListener('visibilitychange', onVis);
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const t0 = performance.now();
      setRun({ job: i + 1, jobs: jobs.length, label: job.label, frac: 0, stage: 'Préparation', eta: '' });
      try {
        const { runExport, fileNameFor } = await loadExporter();
        const name = fileNameFor(p, job);
        // 2. le fichier est écrit sur le disque au fil de l'eau (aucune limite de mémoire vive)
        let dest: ExportDest = { kind: 'buffer' };
        try {
          if (dir) {
            const fh = await dir.getFileHandle(name, { create: true });
            dest = { kind: 'stream', writable: await fh.createWritable(), getFile: () => fh.getFile(), where: `${dir.name}/${name}` };
          } else {
            // espace disque du navigateur, puis téléchargement du fichier (lu depuis le disque)
            const root = await navigator.storage.getDirectory();
            const ex = await root.getDirectoryHandle('exports', { create: true });
            if (i === 0) {
              const old: string[] = [];
              // @ts-expect-error itération asynchrone des entrées
              for await (const [n] of ex.entries()) old.push(n);
              for (const n of old) await ex.removeEntry(n).catch(() => null);
            }
            const fh = await ex.getFileHandle(name, { create: true });
            if ('createWritable' in fh) dest = { kind: 'stream', writable: await fh.createWritable(), getFile: () => fh.getFile(), where: '' };
            else if (canUseOpfsWorker()) {
              // Safari / iPhone : écriture sur disque depuis un worker
              const ds = await opfsWorkerStream(name);
              dest = { kind: 'stream', writable: ds.writable, getFile: ds.getFile, where: '' };
            }
          }
        } catch {
          dest = { kind: 'buffer' };
        }
        const res = await runExport({
          dest,
          project: p,
          media: mediaMap.value,
          job,
          music: musicBuffer.value,
          signal: ac.signal,
          onProgress: (frac, stage, canvas) => {
            const el = (performance.now() - t0) / 1000;
            const eta = frac > 0.06 ? Math.max(0, (el / frac) * (1 - frac)) : 0;
            setRun({ job: i + 1, jobs: jobs.length, label: job.label, frac, stage, eta: eta ? `≈ ${fmtDuration(eta)} restantes` : '' });
            if (canvas && prev.current) {
              const c = prev.current;
              const s = Math.min(1, 480 / canvas.width);
              c.width = Math.round(canvas.width * s);
              c.height = Math.round(canvas.height * s);
              c.getContext('2d')!.drawImage(canvas, 0, 0, c.width, c.height);
            }
          },
        });
        const url = URL.createObjectURL(res.blob);
        const savedTo = res.savedTo || undefined;
        setDone((d) => [{ name: res.fileName, blob: res.blob, url, codec: res.codec, seconds: res.seconds, label: job.label, savedTo }, ...d]);
        if (savedTo) toast(`Film enregistré : ${savedTo}`, 'ok', 9000);
        else if (isMobile) {
          // sur téléphone, l'enregistrement doit être déclenché par un toucher
          toast(`Film prêt : touchez « ${canShareFiles ? 'Enregistrer la vidéo' : 'Télécharger'} » ci-dessous.`, 'ok', 9000);
        } else {
          saveFile(res.blob, res.fileName);
          toast(`Export terminé : ${res.fileName}`, 'ok', 5000);
        }
        for (const w of res.warnings) toast(w, 'warn', 9000);
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') toast('Export annulé', 'warn');
        else toast('Échec de l’export : ' + ((e as Error).message || e), 'error', 8000);
        break;
      }
    }
    document.removeEventListener('visibilitychange', onVis);
    void (lock as WakeLockSentinel | null)?.release().catch(() => null);
    if (wasHidden) toast('L’export a été ralenti pendant que l’app était en arrière-plan : gardez-la affichée pendant l’export.', 'warn', 8000);
    setRun(null);
    abort.current = null;
  };

  const still = async () => {
    const { w, h } = dimsFor(p.aspect, 2160);
    try {
      const { exportStill } = await loadExporter();
      const b = await exportStill({ project: p, media: mediaMap.value, t: playhead.value, width: w, height: h });
      await downloadBlob(b, `image-${w}x${h}.png`);
    } catch (e) {
      toast('Capture impossible : ' + (e as Error).message, 'error');
    }
  };

  const share = async (d: Done) => {
    const file = new File([d.blob], d.name, { type: d.blob.type });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: p.title });
      } catch {
        /* annulé */
      }
    } else saveFile(d.blob, d.name);
  };

  return (
    <div class="export-page">
      <section class="panel export-main">
        <h2 class="page-title">
          Exporter <small>{ASPECTS[p.aspect].label}</small>
        </h2>
        {unavailable > 0 && (
          <div class="alert alert-warn">
            <Icon name="info" />
            <div>
              <b>{unavailable} média(s) inaccessible(s)</b> : ils seraient exportés en basse définition.
              {pendingAccess.value.length > 0 && (
                <div style={{ marginTop: '8px' }}>
                  <button class="btn btn-primary btn-sm" onClick={() => void grantPendingAccess()}>
                    Autoriser l’accès aux dossiers
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {!webcodecs && (
          <div class="alert">
            <Icon name="info" /> Export impossible dans ce navigateur : utilisez Chrome, Edge ou Safari récent.
          </div>
        )}
        <h4 class="side-title">Qualité</h4>
        <div class="res-pick">
          {[
            { v: 720, label: '720p', sub: 'Léger' },
            { v: 1080, label: 'Full HD', sub: '1080p' },
            { v: 2160, label: '4K', sub: '2160p' },
          ].map((o) => {
            const d = dimsFor(p.aspect, o.v);
            return (
              <button class={'res' + (res === o.v ? ' on' : '')} onClick={() => setRes(o.v)}>
                <b>{o.label}</b>
                <small>
                  {d.w} × {d.h}
                </small>
              </button>
            );
          })}
        </div>
        <details class="adv">
          <summary class="side-title">Autres formats en plus{extra.length ? ` · ${extra.length}` : ''}</summary>
          <div class="preset-grid">
            {EXPORT_PRESETS.filter((pr) => pr.aspect !== 'project' && pr.aspect !== p.aspect).map((pr) => {
              const { w, h } = dimsFor(pr.aspect as AspectId, pr.short);
              const on = extra.includes(pr.id);
              const a = ASPECTS[pr.aspect as AspectId];
              return (
                <button class={'preset' + (on ? ' on' : '')} onClick={() => setExtra(on ? extra.filter((x) => x !== pr.id) : [...extra, pr.id])}>
                  <span class="preset-frame">
                    <i style={{ aspectRatio: `${a.w} / ${a.h}` }} />
                  </span>
                  <span class="preset-txt">
                    <b>{pr.label}</b>
                    <small>
                      {w} × {h}
                    </small>
                  </span>
                  <span class="preset-check">{on && <Icon name="check" size={14} />}</span>
                </button>
              );
            })}
          </div>
        </details>
        <details class="adv">
          <summary class="side-title">Réglages avancés</summary>
          <div class="export-opts">
            <div>
              <h4 class="side-title">Fichier</h4>
              <Segmented<Container>
                value={container}
                onChange={setContainer}
                options={[
                  { value: 'mp4', label: `MP4${codecs?.mp4 ? ' · ' + codecs.mp4 : ''}` },
                  { value: 'webm', label: `WebM${codecs?.webm ? ' · ' + codecs.webm : ''}` },
                ]}
              />
            </div>
            <div>
              <h4 class="side-title">Images / seconde</h4>
              <Segmented<number> value={fps} onChange={setFps} options={[24, 25, 30, 50, 60].map((v) => ({ value: v, label: String(v) }))} />
            </div>
            <div>
              <h4 class="side-title">Compression</h4>
              <Segmented<QualityLevel>
                value={quality}
                onChange={setQuality}
                options={[
                  { value: 'standard', label: 'Légère' },
                  { value: 'high', label: 'Haute' },
                  { value: 'max', label: 'Maximale' },
                ]}
              />
            </div>
            <div>
              <Toggle label="Son" checked={audio} onChange={setAudio} />
            </div>
            {canPickDir && (
              <div>
                <Toggle label="Enregistrer dans un dossier" hint="Conseillé pour les films longs" checked={toFolder} onChange={setToFolder} />
              </div>
            )}
            <div>
              <button class="btn btn-quiet btn-sm" disabled={!placed.length} onClick={still}>
                <Icon name="camera" size={15} /> Image fixe 4K
              </button>
            </div>
          </div>
        </details>
      </section>

      <aside class="panel export-side">
        <div class="summary">
          <div>
            <span>Durée</span>
            <b>{fmtDuration(total)}</b>
          </div>
          <div>
            <span>Taille estimée</span>
            <b>≈ {fmtBytes(estBytes)}</b>
          </div>
        </div>
        {run ? (
          <div class="run-card">
            <canvas ref={prev} class="run-prev" />
            <div class="run-head">
              <b>
                {run.label} ({run.job}/{run.jobs})
              </b>
              <span>{Math.round(run.frac * 100)} %</span>
            </div>
            <div class="progress-line big">
              <i style={{ width: `${run.frac * 100}%` }} />
            </div>
            <small>
              {run.stage} {run.eta && '· ' + run.eta}
            </small>
            <button class="btn btn-danger btn-block" onClick={() => abort.current?.abort()}>
              <Icon name="x" size={16} /> Annuler
            </button>
          </div>
        ) : (
          <>
            <button class="btn btn-primary btn-lg btn-block" disabled={!jobs.length || !placed.length || !webcodecs || musicBusy.value} onClick={start}>
              <Icon name="download" /> Exporter {jobs.length > 1 ? `(${jobs.length} fichiers)` : ''}
            </button>
          </>
        )}
        {isMobile && !run && <p class="side-note mobile-tip">Gardez l’app ouverte pendant l’export.</p>}
        {done.length > 0 && (
          <div class="done-list">
            <h4 class="side-title">Fichiers exportés</h4>
            {done.map((d) => (
              <div class="done">
                <video src={d.url} muted playsInline preload="metadata" />
                <div class="done-txt">
                  <b>{d.name}</b>
                  {d.savedTo && <small class="done-where">Enregistré dans {d.savedTo}</small>}
                  <small>
                    {fmtBytes(d.blob.size)} · {d.codec} · rendu en {fmtDuration(d.seconds)}
                  </small>
                </div>
                <div class="done-act">
                  {canShareFiles && (
                    <button class="btn btn-primary btn-sm" onClick={() => share(d)}>
                      <Icon name="share" size={15} /> {isMobile ? 'Enregistrer la vidéo' : 'Partager'}
                    </button>
                  )}
                  <button class={'btn btn-sm ' + (canShareFiles ? 'btn-ghost' : 'btn-primary')} onClick={() => saveFile(d.blob, d.name)}>
                    <Icon name="download" size={15} /> Télécharger
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
