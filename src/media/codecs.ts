// Décodeurs complémentaires chargés à la demande.
import { lazy } from '../lazy';
let ac3: Promise<void> | null = null;

/** Charge le décodeur Dolby AC-3 / E-AC-3 (son des caméscopes AVCHD) si la piste l'exige. */
export async function ensureDecoder(codec: string | null | undefined) {
  if (codec !== 'ac3' && codec !== 'eac3') return;
  ac3 ??= lazy(() => import('@mediabunny/ac3')).then((m) => m.registerAc3Decoder());
  await ac3;
}

/** Formats que la balise <video> des navigateurs ne lit pas : décodage image par image (WebCodecs). */
export const NEEDS_DECODE = /\.(mts|m2ts|mod|tod|avi|vob|mpg|mpeg)$/i;
