// Les navigateurs mobiles (Chrome Android notamment) cessent d'actualiser l'image d'une vidéo
// qui n'est pas dans la page : seule la première image reste. On garde donc les vidéos de travail
// dans un conteneur minuscule et quasi invisible, mais bien présent à l'écran.
let host: HTMLDivElement | null = null;

export function attachVideo(v: HTMLVideoElement) {
  if (!host) {
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:0;bottom:0;width:4px;height:4px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:0';
    document.body.appendChild(host);
  }
  v.style.cssText = 'width:4px;height:4px';
  v.setAttribute('playsinline', '');
  host.appendChild(v);
}

export function detachVideo(v: HTMLVideoElement) {
  v.pause();
  v.remove();
}
