// Modèle de données central d’EditGo.

export type MediaKind = 'photo' | 'video';
export type DateSource = 'exif' | 'video' | 'filename' | 'file' | 'demo' | 'manual';

export interface FocusPoint {
  x: number; // 0..1
  y: number; // 0..1
}

export interface MediaItem {
  id: string;
  kind: MediaKind;
  file: File | null; // null pour les médias de démonstration
  /** Source synthétique (démo) : bitmap déjà prêt. */
  demo?: { draw: (w: number, h: number) => HTMLCanvasElement };
  /** Paramètres permettant de régénérer un média de démo (sauvegarde). */
  demoSpec?: DemoSpec;
  /** Fichier absent après réouverture d'un projet (à réimporter). */
  missing?: boolean;
  name: string;
  path: string;
  size: number;
  date: number; // epoch ms (heure locale de prise de vue)
  dateSource: DateSource;
  width: number;
  height: number;
  duration: number; // s (vidéos)
  hasAudio: boolean;
  thumb: string; // object URL (vignette)
  hash: string; // empreinte exacte
  phash: string; // empreinte perceptuelle (dHash 64 bits, hex)
  sig: string; // miniature 16×16 en niveaux de gris (1 caractère par pixel)
  score: number; // qualité 0..1
  focus: FocusPoint;
  duplicateOf: string | null; // doublon strict
  similarTo: string | null; // quasi-doublon (rafale)
  excluded: boolean; // exclu manuellement
  error?: string;
}

export type TransitionId =
  | 'cut'
  | 'fade'
  | 'dipBlack'
  | 'dipWhite'
  | 'blur'
  | 'zoom'
  | 'whip'
  | 'push'
  | 'lightLeak'
  | 'filmBurn'
  | 'iris'
  | 'ink';

export type MotionId = 'auto' | 'none' | 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'panUp' | 'panDown';
export type FitMode = 'cover' | 'blur' | 'contain';
export type LookId = 'natural' | 'cinema' | 'golden' | 'film' | 'nordic' | 'mono' | 'dream' | 'vivid';
export type TitleStyleId = 'cinema' | 'elegant' | 'bold' | 'minimal' | 'script' | 'chapter';
export type AspectId = '16:9' | '9:16' | '1:1' | '4:5' | '21:9';
export type ThemeId = 'cinema' | 'douceur' | 'energie' | 'argentique' | 'noirblanc' | 'epure';
export type MusicMood = 'cinematic' | 'tender' | 'upbeat';

export interface DemoSpec {
  scene: string;
  seed: number;
  shift: number;
}

export interface TitleSpec {
  text: string;
  sub: string;
  style: TitleStyleId;
  /** 'center' plein cadre, 'lower' tiers inférieur. */
  position: 'center' | 'lower' | 'top';
}

export interface Clip {
  id: string;
  type: 'media' | 'title';
  mediaId: string | null;
  duration: number; // durée à l'écran (s)
  trimIn: number; // vidéo : point d'entrée (s)
  speed: number; // vidéo : vitesse (0.5 – 2)
  volume: number; // vidéo : 0..1
  transition: TransitionId; // transition d'entrée (depuis le plan précédent)
  transitionDuration: number;
  motion: MotionId;
  fit: FitMode;
  title: TitleSpec | null;
  /** Mosaïque : photos supplémentaires affichées avec `mediaId` (2 à 4 au total). */
  extra?: string[];
  /** Disposition imposée de la mosaïque (sinon automatique). */
  layout?: string | null;
  /** Fond des cartons-titres. */
  background?: 'black' | 'blur' | 'gradient';
  chapter?: number;
}

export interface MusicSettings {
  kind: 'none' | 'generated' | 'file';
  mood: MusicMood;
  fileName: string;
  volume: number;
  ducking: boolean;
  beatSync: boolean;
  bpm: number; // détecté ou généré
  offset: number; // décalage de départ dans le morceau (s)
}

export interface Project {
  title: string;
  subtitle: string;
  aspect: AspectId;
  theme: ThemeId;
  look: LookId;
  lookIntensity: number;
  grain: number;
  vignette: number;
  bloom: number;
  letterbox: boolean;
  photoDuration: number;
  /** 'all' : tous les médias, durée naturelle ; 'best' : meilleurs moments sur une durée cible. */
  buildMode: 'all' | 'best';
  /** Regroupement automatique de 2 à 4 photos par image. */
  collage: 'off' | 'auto' | 'more';
  targetLength: number; // s (mode 'best')
  music: MusicSettings;
  clips: Clip[];
}

export interface ImportOptions {
  nearDuplicates: boolean; // regrouper les rafales / quasi-doublons
  similarity: number; // distance de Hamming max (0..16)
  chapterGapHours: number;
}
