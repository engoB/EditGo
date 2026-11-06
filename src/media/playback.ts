// Choix du lecteur vidéo : balise <video> ou décodage image par image (WebCodecs).
// Sur iPhone / iPad (et Safari en général), la balise <video> alimentée par un fichier local
// reste souvent figée sur la première image ou noire : on y préfère le décodeur WebCodecs,
// celui-là même qui sert à l'export. Repli sur <video> si le décodage échoue.
import type { MediaItem } from '../types';

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
/** Moteur WebKit (Safari, et tous les navigateurs sur iPhone / iPad). */
export const isWebKit = /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Android/.test(ua);
export const preferDecoder = isWebKit && typeof VideoDecoder === 'function';

const failed = new Set<string>();

/** Vrai si la vidéo doit être lue par le décodeur image par image. */
export function useDecoder(m: MediaItem): boolean {
  return !!m.decode || (preferDecoder && !failed.has(m.id));
}

/** Le décodeur n'a pas su lire cette vidéo : retour à la balise <video> (si elle en est capable). */
export function decoderFailed(m: MediaItem) {
  if (!m.decode) failed.add(m.id);
  console.warn('[editgo] décodeur indisponible, repli <video> :', m.name);
}

/** Appareil à mémoire limitée (téléphone, tablette) : caches réduits. */
export const lowMemory =
  /iPhone|iPad|iPod|Android/.test(ua) ||
  (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1) ||
  ((typeof navigator !== 'undefined' && (navigator as Navigator & { deviceMemory?: number }).deviceMemory) || 8) <= 4;
