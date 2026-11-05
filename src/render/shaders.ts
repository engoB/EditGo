// Shaders GLSL ES 3.0 du compositeur.

export const VERT = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const COMMON = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}
`;

/** Rendu d'un plan : cadrage (cover / fond flou / contain), Ken Burns. */
export const CLIP_FRAG = /* glsl */ `${COMMON}
uniform sampler2D uTex;
uniform int uMode;        // 0 cover, 1 fond flou + image entière, 2 contain noir, 3 flou seul, 4 noir, 5 dégradé
uniform vec2 uWin;        // taille de la fenêtre visible (UV source)
uniform vec2 uCenter;     // centre de la fenêtre (UV source)
uniform vec2 uBgWin;
uniform vec2 uBgCenter;
uniform float uBlurLod;
uniform float uDim;
uniform vec2 uRes;
uniform float uRadius;   // coins arrondis (px) — cases de mosaïque
uniform float uAlpha;

float roundMask() {
  if (uRadius <= 0.0) return 1.0;
  vec2 q = abs(vUv * uRes - uRes * 0.5) - (uRes * 0.5 - uRadius);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
  return clamp(0.5 - d, 0.0, 1.0);
}

vec3 blurAt(vec2 uv) {
  vec3 c = vec3(0.0);
  vec2 px = 3.0 / uRes;
  c += textureLod(uTex, uv, uBlurLod).rgb * 0.36;
  c += textureLod(uTex, uv + vec2(px.x, px.y) * 4.0, uBlurLod).rgb * 0.16;
  c += textureLod(uTex, uv + vec2(-px.x, px.y) * 4.0, uBlurLod).rgb * 0.16;
  c += textureLod(uTex, uv + vec2(px.x, -px.y) * 4.0, uBlurLod).rgb * 0.16;
  c += textureLod(uTex, uv + vec2(-px.x, -px.y) * 4.0, uBlurLod).rgb * 0.16;
  return c;
}

void main() {
  vec2 p = vUv - 0.5;
  if (uMode == 4) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  if (uMode == 5) {
    float g = 0.06 + 0.05 * (1.0 - length(p * vec2(1.0, 1.4)));
    outColor = vec4(vec3(g * 0.9, g * 0.85, g), 1.0);
    return;
  }
  vec2 uvBg = clamp(vec2(p.x, -p.y) * uBgWin + uBgCenter, 0.0, 1.0);
  if (uMode == 3) {
    outColor = vec4(blurAt(uvBg) * uDim, 1.0);
    return;
  }
  vec2 uv = vec2(p.x, -p.y) * uWin + uCenter;
  if (uMode == 0) {
    outColor = vec4(texture(uTex, clamp(uv, 0.0, 1.0)).rgb, roundMask() * uAlpha);
    return;
  }
  vec3 bg = uMode == 1 ? blurAt(uvBg) * 0.62 : vec3(0.0);
  vec2 d = min(uv, 1.0 - uv);
  vec2 aa = fwidth(uv) * 1.2;
  float inside = smoothstep(0.0, aa.x, d.x) * smoothstep(0.0, aa.y, d.y);
  vec3 fg = texture(uTex, clamp(uv, 0.0, 1.0)).rgb;
  // ombre portée douce autour de l'image
  float sh = 0.0;
  if (uMode == 1) {
    vec2 dd = max(-d, 0.0) / uWin;
    sh = exp(-length(dd) * 18.0) * 0.55 * (1.0 - inside);
  }
  outColor = vec4(mix(bg * (1.0 - sh), fg, inside), 1.0);
}`;

/** Transitions entre deux plans. */
export const TRANS_FRAG = /* glsl */ `${COMMON}
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uMix;
uniform int uType;
uniform vec2 uRes;
uniform float uSeed;

float ease(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0; }
float bell(float t) { return sin(3.14159265 * clamp(t, 0.0, 1.0)); }

vec3 A(vec2 uv) { return texture(uA, uv).rgb; }
vec3 B(vec2 uv) { return texture(uB, uv).rgb; }

vec3 dirBlur(sampler2D s, vec2 uv, vec2 dir) {
  vec3 c = vec3(0.0);
  for (int i = -6; i <= 6; i++) {
    float t = float(i) / 6.0;
    c += texture(s, clamp(uv + dir * t, 0.0, 1.0)).rgb;
  }
  return c / 13.0;
}
vec3 radialBlur(sampler2D s, vec2 uv, float scale, float amount) {
  vec2 c = vec2(0.5);
  vec3 col = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    float k = scale * (1.0 - amount * float(i) / 10.0);
    col += texture(s, clamp(c + (uv - c) / k, 0.0, 1.0)).rgb;
  }
  return col / 10.0;
}

void main() {
  vec2 uv = vUv;
  float t = clamp(uMix, 0.0, 1.0);
  float e = ease(t);
  vec3 col;
  if (uType == 1) {               // fondu enchaîné (courbe douce)
    col = mix(A(uv), B(uv), smoothstep(0.0, 1.0, t));
  } else if (uType == 2) {        // fondu au noir
    float a = smoothstep(0.0, 0.5, t), b = smoothstep(0.5, 1.0, t);
    col = A(uv) * (1.0 - a) * (t < 0.5 ? 1.0 : 0.0) + B(uv) * b * (t >= 0.5 ? 1.0 : 0.0);
  } else if (uType == 3) {        // flash blanc
    float f = pow(bell(t), 2.5);
    col = mix(A(uv), B(uv), smoothstep(0.35, 0.65, t));
    col = col + vec3(1.0, 0.98, 0.95) * f * 1.2;
    col = col / (1.0 + f * 0.25);
  } else if (uType == 4) {        // flou dissolvant
    float lod = bell(t) * 5.5;
    col = mix(textureLod(uA, uv, lod).rgb, textureLod(uB, uv, lod).rgb, smoothstep(0.25, 0.75, t));
  } else if (uType == 5) {        // zoom cinétique
    float amt = bell(t) * 0.35;
    vec3 a = radialBlur(uA, uv, 1.0 + e * 1.6, amt);
    vec3 b = radialBlur(uB, uv, 0.45 + e * 0.55, amt);
    col = mix(a, b, smoothstep(0.42, 0.58, t));
  } else if (uType == 6) {        // filé horizontal
    float off = e;
    float sp = bell(t) * 0.18;
    vec2 ua = uv + vec2(off, 0.0);
    vec2 ub = uv + vec2(off - 1.0, 0.0);
    col = ua.x <= 1.0 ? dirBlur(uA, ua, vec2(sp, 0.0)) : dirBlur(uB, ub, vec2(sp, 0.0));
  } else if (uType == 7) {        // poussée
    vec2 ua = uv + vec2(e, 0.0);
    vec2 ub = uv + vec2(e - 1.0, 0.0);
    col = ua.x <= 1.0 ? A(ua) * (1.0 - 0.35 * e) : B(ub);
  } else if (uType == 8) {        // fuite de lumière
    col = mix(A(uv), B(uv), smoothstep(0.2, 0.8, t));
    float f = bell(t);
    vec2 q = uv * vec2(uRes.x / uRes.y, 1.0);
    float l1 = exp(-pow(length(q - vec2(-0.3 + t * 2.0, 0.35 + 0.2 * sin(uSeed))), 2.0) * 2.2);
    float l2 = exp(-pow(length(q - vec2(1.8 - t * 1.6, 0.8)), 2.0) * 3.5);
    vec3 leak = vec3(1.0, 0.55, 0.22) * l1 + vec3(1.0, 0.25, 0.35) * l2 * 0.8;
    col = 1.0 - (1.0 - col) * (1.0 - leak * f * 1.25);
  } else if (uType == 9) {        // brûlure de pellicule
    float n = fbm(uv * 3.0 + uSeed);
    float edge = t * 1.4 - 0.2;
    float m = smoothstep(edge - 0.08, edge + 0.08, n);
    vec3 burn = vec3(1.0, 0.45, 0.1) * (1.0 - abs(n - edge) * 8.0);
    col = mix(B(uv), A(uv), m);
    col += max(burn, 0.0) * bell(t) * 1.6;
    col += vec3(1.0, 0.8, 0.6) * pow(bell(t), 3.0) * 0.6;
  } else if (uType == 10) {       // iris
    vec2 q = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    float r = e * 1.25;
    float m = smoothstep(r, r - 0.04, length(q));
    col = mix(A(uv) * (1.0 - 0.3 * e), B(uv), m);
  } else if (uType == 11) {       // encre
    float n = fbm(uv * vec2(uRes.x / uRes.y, 1.0) * 2.5 + uSeed);
    float m = smoothstep(n - 0.06, n + 0.06, t * 1.25 - 0.1);
    col = mix(A(uv), B(uv), m);
  } else {
    col = t < 0.5 ? A(uv) : B(uv);
  }
  outColor = vec4(col, 1.0);
}`;

/** Post-traitement : étalonnage, halo, vignettage, grain, bandes cinéma, fondus globaux. */
export const POST_FRAG = /* glsl */ `${COMMON}
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uTime;
uniform float uExposure, uContrast, uSaturation, uTemp, uTint, uFadeBlack, uSplit, uMono, uIntensity;
uniform vec3 uLift, uGain;
uniform float uBloom, uVignette, uGrain, uLetterbox, uGlobalFade;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec3 src = texture(uSrc, vUv).rgb;
  vec3 c = src * pow(2.0, uExposure);
  c.r *= 1.0 + uTemp * 0.08; c.b *= 1.0 - uTemp * 0.10; c.g *= 1.0 + uTint * 0.05;
  c = c * uGain + uLift * (1.0 - c);
  // contraste « film » : courbe en S autour du gris moyen
  c = (c - 0.5) * uContrast + 0.5;
  vec3 s = clamp(c, 0.0, 1.0);
  vec3 sc = s * s * (3.0 - 2.0 * s);
  c = mix(c, sc, clamp((uContrast - 1.0) * 1.5, 0.0, 0.5));
  float l = luma(c);
  c = mix(vec3(l), c, uSaturation);
  // virage partiel : ombres sarcelle, hautes lumières orangées
  vec3 shadowT = vec3(0.0, 0.32, 0.38), highT = vec3(1.0, 0.62, 0.32);
  c = mix(c, c + (shadowT - 0.25) * 0.22, uSplit * (1.0 - smoothstep(0.0, 0.55, l)));
  c = mix(c, c * mix(vec3(1.0), highT * 1.25, 0.18), uSplit * smoothstep(0.45, 1.0, l));
  c = mix(c, vec3(luma(c)), uMono);
  c = c * (1.0 - uFadeBlack) + uFadeBlack * 0.9;
  c = mix(src, c, uIntensity);
  // halo lumineux (bloom) à partir des mipmaps
  if (uBloom > 0.001) {
    vec3 b1 = textureLod(uSrc, vUv, 3.0).rgb, b2 = textureLod(uSrc, vUv, 5.0).rgb;
    vec3 bl = max(b1 - 0.55, 0.0) * 0.8 + max(b2 - 0.45, 0.0) * 1.2;
    c = 1.0 - (1.0 - c) * (1.0 - bl * uBloom);
    c = mix(c, c * 0.85 + b2 * 0.2, uBloom * 0.25);
  }
  // vignettage
  vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float v = smoothstep(0.35, 1.15, length(q) * 1.15);
  c *= 1.0 - v * uVignette * 0.75;
  // grain argentique, plus visible dans les tons moyens
  if (uGrain > 0.001) {
    float g = hash12(vUv * uRes + fract(uTime * 13.17) * 917.0) - 0.5;
    float g2 = hash12(floor(vUv * uRes / 2.0) + fract(uTime * 7.31) * 331.0) - 0.5;
    float lm = luma(c);
    c += (g * 0.6 + g2 * 0.4) * uGrain * 0.11 * (1.0 - abs(lm - 0.5) * 1.2);
  }
  // bandes cinéma 2.39:1
  if (uLetterbox > 0.0) {
    float target = 1.0 / 2.39;
    float cur = uRes.y / uRes.x;
    float bar = max(0.0, (1.0 - target / cur) * 0.5) * uLetterbox;
    if (vUv.y < bar || vUv.y > 1.0 - bar) c = vec3(0.0);
  }
  c *= uGlobalFade;
  // tramage anti-bandes
  c += (hash12(vUv * uRes + 0.5) - 0.5) / 255.0;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export const OVERLAY_FRAG = /* glsl */ `${COMMON}
uniform sampler2D uTex;
void main() {
  outColor = texture(uTex, vec2(vUv.x, 1.0 - vUv.y));
}`;
