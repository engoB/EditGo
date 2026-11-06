import { useEffect, useRef, useState } from 'preact/hooks';
import { mediaMap, musicBuffer, playhead, project, timeline, toast, musicBusy } from '../state/store';
import { prepareMusic } from '../state/actions';
import { grantPendingAccess, pendingAccess } from '../state/persist';
import { EXPORT_PRESETS, dimsFor, ASPECTS } from '../presets';
import type { Container, ExportDest, ExportJob, QualityLevel } from '../export/exporter';
const loadExporter = () => import('../export/exporter');
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
  const [sel, setSel] = useState<string[]>(['proj-1080']);
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

  const jobs: ExportJob[] = sel.map((id) => {
    const pr = EXPORT_PRESETS.find((x) => x.id === id)!;
    const aspect = pr.aspect === 'project' ? p.aspect : pr.aspect;
    const { w, h } = dimsFor(aspect, pr.short);
    return { label: pr.label, width: w, height: h, fps, container, quality, audio };
  });
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
          <Icon name="download" /> Exporter le film
        </h2>
        {unavailable > 0 && (
          <div class="alert alert-warn">
            <Icon name="info" />
            <div>
              <b>{unavailable} média(s) du montage ne sont pas accessibles</b> (fichiers déplacés, ou accès aux dossiers à réautoriser). Ils seraient exportés en basse définition à partir de leur vignette.
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
            <Icon name="info" /> Ce navigateur ne propose pas l’encodage vidéo matériel (WebCodecs). Utilisez une version récente de Chrome, Edge, Safari (17+) ou Firefox (130+).
          </div>
        )}
        <h4 class="side-title">Formats (sélection multiple)</h4>
        <div class="preset-grid">
          {EXPORT_PRESETS.map((pr) => {
            const aspect = pr.aspect === 'project' ? p.aspect : pr.aspect;
            const { w, h } = dimsFor(aspect, pr.short);
            const on = sel.includes(pr.id);
            const a = ASPECTS[aspect];
            return (
              <button class={'preset' + (on ? ' on' : '')} onClick={() => setSel(on ? sel.filter((x) => x !== pr.id) : [...sel, pr.id])}>
                <span class="preset-frame">
                  <i style={{ aspectRatio: `${a.w} / ${a.h}` }} />
                </span>
                <span class="preset-txt">
                  <b>{pr.label}</b>
                  <small>
                    {w} × {h} · {pr.hint}
                  </small>
                </span>
                <span class="preset-check">{on && <Icon name="check" size={14} />}</span>
              </button>
            );
          })}
        </div>
        <div class="export-opts">
          <div>
            <h4 class="side-title">Conteneur</h4>
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
            <Segmented<number>
              value={fps}
              onChange={setFps}
              options={[24, 25, 30, 50, 60].map((v) => ({ value: v, label: String(v) }))}
            />
          </div>
          <div>
            <h4 class="side-title">Qualité</h4>
            <Segmented<QualityLevel>
              value={quality}
              onChange={setQuality}
              options={[
                { value: 'standard', label: 'Standard' },
                { value: 'high', label: 'Haute' },
                { value: 'max', label: 'Maximale' },
              ]}
            />
          </div>
          <div>
            <Toggle label="Inclure le son" hint="Musique + son des vidéos" checked={audio} onChange={setAudio} />
          </div>
          {canPickDir && (
            <div>
              <Toggle
                label="Enregistrer directement dans un dossier"
                hint="Recommandé, indispensable pour les films longs : le fichier est écrit au fur et à mesure"
                checked={toFolder}
                onChange={setToFolder}
              />
            </div>
          )}
        </div>
      </section>

      <aside class="panel export-side">
        <div class="summary">
          <div>
            <span>Durée</span>
            <b>{fmtDuration(total)}</b>
          </div>
          <div>
            <span>Plans</span>
            <b>{placed.length}</b>
          </div>
          <div>
            <span>Fichiers</span>
            <b>{jobs.length}</b>
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
              <Icon name="film" /> Lancer l’export {jobs.length > 1 ? `(${jobs.length} fichiers)` : ''}
            </button>
            <button class="btn btn-ghost btn-block" disabled={!placed.length} onClick={still}>
              <Icon name="camera" size={16} /> Image fixe 4K (tête de lecture)
            </button>
          </>
        )}
        {isMobile && !run && (
          <p class="side-note mobile-tip">
            <Icon name="info" size={13} /> Sur téléphone : gardez l’app affichée pendant l’export (l’écran reste allumé). À la fin, touchez « Enregistrer la vidéo » pour la mettre dans Photos.
          </p>
        )}
        <p class="side-note">
          Le rendu est calculé image par image sur votre appareil (aucun envoi en ligne). Gardez cet onglet ouvert pendant l’export.
          {canPickDir && toFolder ? ' Au lancement, choisissez le dossier où écrire le film.' : ' Le fichier sera proposé au téléchargement à la fin.'}
        </p>
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
