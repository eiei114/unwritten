// UNWRITTEN (open world): a 3D world that does not exist until Kimi K3.1 Pro
// (on Cerebras, through an OpenClaw agent) writes it. The world is a grid of
// 40 m regions; Kimi designs each region (terrain, landmarks, characters, lore,
// a quest, music) as you approach, and the engine builds it from that design.
// Every region is saved server-side, so the world keeps growing across visits.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createAudio, describe, soundSpec } from './audio.js';

const $ = (id) => document.getElementById(id);
const audio = createAudio();
const canvas = $('world');
const minimap = $('minimap');
const mm = minimap.getContext('2d');
const ui = {
  regions: $('regions'),
  shards: $('shards'),
  quests: $('quests'),
  met: $('met'),
  speed: $('speed'),
  tps: $('tps'),
  tok: $('tok'),
  sec: $('sec'),
  speedNote: $('speed-note'),
  region: $('region'),
  toast: $('toast'),
  title: $('title'),
  titleStatus: $('title-status'),
  startHint: $('start-hint'),
  log: $('log'),
  logMeta: $('log-meta'),
  compass: $('compass'),
  compassArrow: $('compass-arrow'),
  compassText: $('compass-text'),
};

const params = new URLSearchParams(location.search);
const AUTOPILOT = params.get('autopilot') === '1';
const HOLD = params.get('hold') === '1';
// FILM hides the title card and frames the first region closely, for recording.
const FILM = params.get('film') === '1';
let released = !HOLD;
// Film helpers: a cutaway camera onto the region Kimi is writing, and event times for editing.
let filmCam = null;
const filmEvents = [];
const R = 40; // region size in meters
const GRID = 64; // terrain segments per region side
const MAX_INFLIGHT = new URLSearchParams(location.search).get('film') === '1' ? 3 : 2;
const WATER = 0.35;
const WALK = 6.5;
const SPRINT = 11;
const JUMP = 9.5;
const GRAVITY = 26;
const HUMAN_TOKENS_PER_SECOND = 1.2;
const RATIO_KEY = 'danmaku-ogiri:tokens-per-delta';
const WORLD_KEY = 'unwritten:open-world-id';
const LOG_LIMIT = 260;
const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const PALETTES = {
  red: ['#ff8a72', '#a8483e', '#3a1420'],
  orange: ['#ffb866', '#a8662a', '#3a1e10'],
  yellow: ['#ffe27a', '#a88a2e', '#2e2810'],
  green: ['#8fe38a', '#3f8a4a', '#10301e'],
  teal: ['#6ae8d4', '#258a7e', '#0a2e30'],
  blue: ['#86bcff', '#3566aa', '#0f1e44'],
  purple: ['#c8a4ff', '#62449e', '#1e1238'],
  pink: ['#ffa6de', '#a0447e', '#36122c'],
  white: ['#f4f5fa', '#868aa8', '#22243a'],
};
const TERRAINS = new Set(['hills', 'plateaus', 'islands', 'canyon', 'dunes', 'crater', 'terraces', 'spires']);
const LANDMARKS = new Set(['tower', 'ruin', 'arch', 'statue', 'crystal', 'tree', 'house', 'obelisk', 'dome']);
const SIDES = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeOutBack = (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;
const fmt = (value) => Math.round(value).toLocaleString('en-US');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const key = (rx, rz) => `${rx},${rz}`;
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

function hash(str) {
  let h = 2166136261;
  for (const c of String(str)) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function seeded(seed) {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}
function makeNoise(seed) {
  const r = seeded(seed);
  const table = Float32Array.from({ length: 256 }, () => r());
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const s = (t) => t * t * (3 - 2 * t);
  const v = (i, j) => table[perm[(perm[i & 255] + (j & 255)) & 511]];
  return (x, z) => {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const u = s(x - xi);
    const w = s(z - zi);
    const a = v(xi, zi);
    const b = v(xi + 1, zi);
    const c = v(xi, zi + 1);
    const d = v(xi + 1, zi + 1);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
}
function fbm(noise, x, z) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < 4; o++) {
    sum += amp * noise(x * freq, z * freq);
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum / 0.9375;
}

let tokensPerDelta = (() => {
  try {
    const v = Number(localStorage.getItem(RATIO_KEY));
    return v > 0.5 && v < 6 ? v : 1.9;
  } catch {
    return 1.9;
  }
})();
function saveRatio(value) {
  tokensPerDelta = value;
  try {
    localStorage.setItem(RATIO_KEY, String(value));
  } catch {
    // optional
  }
}
function worldId() {
  let id = '';
  try {
    id = params.get('fresh') === '1' ? '' : localStorage.getItem(WORLD_KEY) ?? '';
  } catch {
    id = '';
  }
  if (!id) {
    id = `ow-${(crypto.randomUUID?.() ?? String(Math.random()).slice(2)).replace(/[^a-z0-9-]/gi, '').slice(0, 30)}`;
    try {
      localStorage.setItem(WORLD_KEY, id);
    } catch {
      // optional
    }
  }
  return id;
}

// ---------- renderer, sky, light ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog('#2a2f55', 55, 190);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 900);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Only genuinely emissive things (lanterns, crystals, shards, beams) should glow.
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.4, 0.93);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const skyUniforms = {
  top: { value: new THREE.Color('#0b0f24') },
  horizon: { value: new THREE.Color('#2a2f55') },
  bottom: { value: new THREE.Color('#07080f') },
  sunDir: { value: new THREE.Vector3(-0.45, 0.55, 0.35).normalize() },
  sunColor: { value: new THREE.Color('#ffe2b0') },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(600, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: skyUniforms,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 col = h > 0.0 ? mix(horizon, top, pow(smoothstep(0.0, 1.0, h), 0.55)) : mix(horizon, bottom, smoothstep(0.0, -0.25, h));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        col += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 14.0) * 0.28);
        gl_FragColor = vec4(col, 1.0);
      }`,
  }),
);
sky.renderOrder = -1;
scene.add(sky);

const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a2836, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -46;
sun.shadow.camera.right = 46;
sun.shadow.camera.top = 46;
sun.shadow.camera.bottom = -46;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 220;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

const voidGrid = new THREE.GridHelper(2400, 300, 0x3a3f66, 0x1a1d33);
voidGrid.position.y = -10;
voidGrid.material.transparent = true;
voidGrid.material.opacity = 0.55;
scene.add(voidGrid);

// Drifting low-poly clouds.
const clouds = new THREE.Group();
const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.15, flatShading: true, transparent: true, opacity: 0.92 });
for (let i = 0; i < 26; i++) {
  const c = new THREE.Group();
  for (let k = 0; k < 5; k++) {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(3, 6), 0), cloudMat);
    m.position.set(rand(-7, 7), rand(-1, 1.5), rand(-3, 3));
    m.scale.y = 0.55;
    c.add(m);
  }
  c.position.set(rand(-260, 260), rand(48, 70), rand(-260, 260));
  c.userData.speed = rand(0.6, 1.6);
  clouds.add(c);
}
scene.add(clouds);

// ---------- textures and sprites ----------
const textureCache = new Map();
function emojiTexture(emoji) {
  if (textureCache.has(emoji)) return textureCache.get(emoji);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = `100px ${EMOJI_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(emoji, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(emoji, t);
  return t;
}
function emojiSprite(emoji, size) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTexture(emoji), transparent: true }));
  s.scale.set(size, size, 1);
  return s;
}
function textSprite(text, { scale = 0.9, bg = 'rgba(8,10,18,0.78)', fg = '#ffffff', border = 'rgba(255,255,255,0.25)', font = '700 58px "Space Grotesk", sans-serif', width = 1024 } = {}) {
  const height = 150;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  g.font = font;
  const w = Math.min(width - 16, g.measureText(text).width + 64);
  if (bg) {
    g.fillStyle = bg;
    g.strokeStyle = border;
    g.lineWidth = 6;
    g.beginPath();
    g.roundRect((width - w) / 2, 12, w, height - 24, 26);
    g.fill();
    g.stroke();
  }
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, width / 2, height / 2 + 3, width - 60);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set((width / height) * scale, scale, 1);
  return s;
}

// ---------- particles ----------
const PARTICLES = 1600;
const partGeo = new THREE.BufferGeometry();
const partPos = new Float32Array(PARTICLES * 3).fill(-9999);
const partCol = new Float32Array(PARTICLES * 3);
partGeo.setAttribute('position', new THREE.BufferAttribute(partPos, 3));
partGeo.setAttribute('color', new THREE.BufferAttribute(partCol, 3));
const partPoints = new THREE.Points(partGeo, new THREE.PointsMaterial({ size: 0.22, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
partPoints.frustumCulled = false;
scene.add(partPoints);
const parts = Array.from({ length: PARTICLES }, () => ({ life: 0, vx: 0, vy: 0, vz: 0, drag: 0.96, grav: 9 }));
let partCursor = 0;
const tmpColor = new THREE.Color();
function emit(x, y, z, color, count, { speed = 5, up = 2, life = 0.9, grav = 9, spread = 0.2 } = {}) {
  tmpColor.set(color);
  for (let i = 0; i < count; i++) {
    const k = partCursor++ % PARTICLES;
    const p = parts[k];
    const a = Math.random() * Math.PI * 2;
    const s = rand(speed * 0.3, speed);
    p.life = rand(life * 0.5, life);
    p.vx = Math.cos(a) * s;
    p.vz = Math.sin(a) * s;
    p.vy = rand(0, up) + s * 0.2;
    p.grav = grav;
    partPos[k * 3] = x + rand(-spread, spread);
    partPos[k * 3 + 1] = y;
    partPos[k * 3 + 2] = z + rand(-spread, spread);
    partCol[k * 3] = tmpColor.r;
    partCol[k * 3 + 1] = tmpColor.g;
    partCol[k * 3 + 2] = tmpColor.b;
  }
}
function updateParticles(dt) {
  for (let k = 0; k < PARTICLES; k++) {
    const p = parts[k];
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) {
      partPos[k * 3 + 1] = -9999;
      continue;
    }
    p.vy -= p.grav * dt;
    p.vx *= p.drag;
    p.vz *= p.drag;
    partPos[k * 3] += p.vx * dt;
    partPos[k * 3 + 1] += p.vy * dt;
    partPos[k * 3 + 2] += p.vz * dt;
  }
  partGeo.attributes.position.needsUpdate = true;
  partGeo.attributes.color.needsUpdate = true;
}

// Ambient motes drifting around the explorer, tinted by the region.
const MOTES = 260;
const moteGeo = new THREE.BufferGeometry();
const motePos = new Float32Array(MOTES * 3);
for (let i = 0; i < MOTES; i++) motePos.set([rand(-28, 28), rand(0, 12), rand(-28, 28)], i * 3);
moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
const moteMat = new THREE.PointsMaterial({ size: 0.14, color: '#ffe9b0', transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false });
const motes = new THREE.Points(moteGeo, moteMat);
motes.frustumCulled = false;
scene.add(motes);

// ---------- world state ----------
const world = { id: worldId(), regions: new Map(), colliders: [], lines: 0, loaded: false };
const gen = { inflight: [], retryAt: 0, backoff: 8000, lastSpeed: null, part: 0 };
const stats = { shards: 0, quests: 0, met: 0 };
const animating = [];
let shake = 0;

function regionAt(x, z) {
  return world.regions.get(key(Math.floor(x / R), Math.floor(z / R)));
}
function getRegion(rx, rz) {
  const k = key(rx, rz);
  if (!world.regions.has(k)) world.regions.set(k, { key: k, rx, rz, status: 'missing', items: [] });
  return world.regions.get(k);
}

function heightFunction(region) {
  const n1 = makeNoise(region.seed);
  const n2 = makeNoise(region.seed + 17);
  const h = clamp(region.hill / 10, 0.1, 1);
  return (u, v) => {
    const x = region.rx * R + u;
    const z = region.rz * R + v;
    const f = fbm(n1, x / 14, z / 14);
    let y;
    switch (region.terrain) {
      case 'plateaus': {
        const raw = f * h * 9;
        const step = Math.floor(raw / 2) * 2;
        y = step + smoothstep(0.75, 1, (raw - step) / 2) * 2;
        break;
      }
      case 'islands':
        y = Math.max(-1.6, (f - 0.42) * h * 15);
        break;
      case 'canyon': {
        const d = Math.abs(v - 20 - (n2(x / 20, 0.5) - 0.5) * 14);
        y = h * 11 * smoothstep(2.5, 11, d) + f * 1.4;
        break;
      }
      case 'dunes':
        y = h * 3.4 * (0.5 + 0.5 * Math.sin(u / 3.2 + f * 5)) + f * 1.2;
        break;
      case 'crater': {
        const d = Math.hypot(u - 20, v - 20);
        y = h * 9 * Math.exp(-((d - 13) ** 2) / 18) - (d < 11 ? h * 2.6 * (1 - d / 11) : 0) + f * 1.2;
        break;
      }
      case 'terraces': {
        const raw = (f * h * 12) / 1.5;
        const step = Math.floor(raw);
        y = (step + smoothstep(0.82, 1, raw - step)) * 1.5;
        break;
      }
      case 'spires': {
        const sp = fbm(n2, x / 5, z / 5);
        y = f * h * 2.5 + (sp > 0.64 ? ((sp - 0.64) / 0.36) * h * 15 : 0);
        break;
      }
      default:
        y = f * h * 7.5;
    }
    const edge = Math.min(u, R - u, v, R - v);
    return y * smoothstep(0, 7, edge);
  };
}

function terrainAt(region, u, v) {
  const gx = clamp((u / R) * GRID, 0, GRID - 0.0001);
  const gz = clamp((v / R) * GRID, 0, GRID - 0.0001);
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const H = region.heights;
  const W = GRID + 1;
  const a = H[iz * W + ix];
  const b = H[iz * W + ix + 1];
  const c = H[(iz + 1) * W + ix];
  const d = H[(iz + 1) * W + ix + 1];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
function groundAt(x, z) {
  const region = regionAt(x, z);
  if (!region || region.status !== 'ready') return null;
  const y = terrainAt(region, x - region.rx * R, z - region.rz * R);
  return region.water ? Math.max(y, WATER - 0.45) : y;
}
function slopeAt(region, u, v) {
  const e = 0.6;
  const dx = terrainAt(region, u + e, v) - terrainAt(region, u - e, v);
  const dz = terrainAt(region, u, v + e) - terrainAt(region, u, v - e);
  return Math.hypot(dx, dz) / (2 * e);
}

// Shared geometry for scattered props.
const grassGeo = new THREE.ConeGeometry(0.04, 0.42, 3).translate(0, 0.2, 0);
const flowerGeo = new THREE.IcosahedronGeometry(0.13, 0).translate(0, 0.32, 0);
const rockGeo = new THREE.DodecahedronGeometry(0.5, 0);
const bushGeo = new THREE.IcosahedronGeometry(0.7, 0).translate(0, 0.45, 0);
const grassMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
const flowerMat = new THREE.MeshStandardMaterial({ roughness: 0.5, emissive: '#ffffff', emissiveIntensity: 0.12 });
const rockMat = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true });
const bushMat = new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true });

function buildRegion(region, now) {
  const pal = PALETTES[region.color];
  region.seed = hash(`${world.id}:${region.rx},${region.rz}:${region.name}`);
  region.water = region.terrain === 'islands' || region.terrain === 'crater';
  const fn = heightFunction(region);
  const W = GRID + 1;
  region.heights = new Float32Array(W * W);
  const geo = new THREE.PlaneGeometry(R, R, GRID, GRID).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = fn(((i % W) * R) / GRID, (Math.floor(i / W) * R) / GRID);
    region.heights[i] = y;
    pos.setY(i, y);
  }
  geo.computeVertexNormals();
  // Paint by slope and height: grass on the flats, rock on steep faces, sand by the water.
  const colors = new Float32Array(pos.count * 3);
  const grass = new THREE.Color(pal[0]).lerp(new THREE.Color(pal[1]), 0.35);
  const grassDark = new THREE.Color(pal[1]);
  const rock = new THREE.Color('#8b8e9e').lerp(new THREE.Color(pal[1]), 0.25);
  const sand = new THREE.Color('#e9dcb0').lerp(new THREE.Color(pal[0]), 0.15);
  const peak = new THREE.Color(pal[0]).lerp(new THREE.Color('#ffffff'), 0.35);
  const tint = makeNoise(region.seed + 5);
  const shade = new THREE.Color();
  const normals = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const y = region.heights[i];
    const ix = i % W;
    const iz = Math.floor(i / W);
    const steep = 1 - normals.getY(i);
    const n = tint(ix / 6, iz / 6);
    shade.copy(grassDark).lerp(grass, clamp(0.35 + n * 0.8, 0, 1));
    if (y > 6) shade.lerp(peak, smoothstep(6, 11, y));
    shade.lerp(rock, smoothstep(0.18, 0.42, steep));
    if (region.water && y < WATER + 0.5) shade.lerp(sand, smoothstep(WATER + 0.5, WATER - 0.2, y));
    colors.set([shade.r, shade.g, shade.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, emissive: new THREE.Color(pal[0]), emissiveIntensity: 0 });
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  region.group = new THREE.Group();
  region.group.position.set(region.rx * R + R / 2, 0, region.rz * R + R / 2);
  region.group.add(mesh);
  region.mesh = mesh;
  if (region.water) {
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(R, R, 20, 20).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(pal[0]).lerp(new THREE.Color('#2a7bd8'), 0.55), transparent: true, opacity: 0.62, roughness: 0.08, metalness: 0.35 }),
    );
    water.position.y = WATER;
    water.receiveShadow = true;
    region.group.add(water);
    region.waterMesh = water;
  }
  region.props = scatterProps(region, pal);
  region.group.add(region.props);
  region.props.visible = now <= 0;
  const landmark = emojiSprite(region.emoji, 30);
  landmark.material.opacity = 0.22;
  landmark.material.fog = false;
  landmark.material.depthWrite = false;
  landmark.position.set(0, 42, -14);
  region.group.add(landmark);
  scene.add(region.group);
  region.status = 'ready';
  hideBlueprint(region);
  if (now > 0) {
    startRise(region, now);
    filmEvents.push({ type: 'ready', at: region.key, name: region.name, t: Date.now() });
  }
  for (const item of region.items.splice(0)) spawnItem(region, item, now);
  refreshWalls();
}

function scatterProps(region, pal) {
  const group = new THREE.Group();
  const r = seeded(region.seed + 99);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  const place = (geo, mat, count, opts) => {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    let n = 0;
    for (let tries = 0; tries < count * 3 && n < count; tries++) {
      const u = 1 + r() * (R - 2);
      const v = 1 + r() * (R - 2);
      const y = terrainAt(region, u, v);
      if (region.water && y < WATER + 0.15) continue;
      if (slopeAt(region, u, v) > opts.maxSlope) continue;
      const k = opts.size(r());
      e.set(opts.tilt ? (r() - 0.5) * 0.5 : 0, r() * Math.PI * 2, opts.tilt ? (r() - 0.5) * 0.5 : 0);
      q.setFromEuler(e);
      p.set(u - R / 2, y - (opts.sink ?? 0) * k, v - R / 2);
      s.set(k, k * (opts.squash ?? 1), k);
      m.compose(p, q, s);
      mesh.setMatrixAt(n, m);
      mesh.setColorAt(n, opts.color(c, r()));
      n++;
    }
    mesh.count = n;
    mesh.castShadow = Boolean(opts.shadow);
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  const grassA = new THREE.Color(pal[0]).lerp(new THREE.Color(pal[1]), 0.15);
  const grassB = new THREE.Color(pal[1]).lerp(new THREE.Color(pal[0]), 0.4);
  place(grassGeo, grassMat, 2600, { maxSlope: 0.6, size: (t) => 0.5 + t * 0.7, tilt: true, color: (col, t) => col.copy(grassB).lerp(grassA, t) });
  const petals = [new THREE.Color('#ffffff'), new THREE.Color('#ffd84d'), new THREE.Color(pal[0]), new THREE.Color('#ff7aa8')];
  place(flowerGeo, flowerMat, 180, { maxSlope: 0.45, size: (t) => 0.7 + t * 0.6, color: (col, t) => col.copy(petals[Math.floor(t * petals.length) % petals.length]) });
  place(rockGeo, rockMat, 46, { maxSlope: 1.4, size: (t) => 0.35 + t * 1.4, squash: 0.6, sink: 0.15, shadow: true, tilt: true, color: (col, t) => col.set('#8b8e9e').lerp(new THREE.Color(pal[1]), t * 0.4) });
  place(bushGeo, bushMat, 34, { maxSlope: 0.5, size: (t) => 0.7 + t * 0.8, squash: 0.75, shadow: true, color: (col, t) => col.copy(grassB).lerp(new THREE.Color(pal[0]), t * 0.5) });
  return group;
}

// The ground rises in a wave that starts at the edge nearest the explorer.
function startRise(region, now) {
  const pos = region.mesh.geometry.attributes.position;
  const W = GRID + 1;
  const ox = clamp(player.x - region.rx * R, 0, R);
  const oz = clamp(player.z - region.rz * R, 0, R);
  region.rise = { born: now, delays: new Float32Array(pos.count) };
  for (let i = 0; i < pos.count; i++) {
    const u = ((i % W) * R) / GRID;
    const v = (Math.floor(i / W) * R) / GRID;
    region.rise.delays[i] = (Math.hypot(u - ox, v - oz) / (R * 1.42)) * 1100;
    pos.setY(i, -6);
  }
  pos.needsUpdate = true;
  region.mesh.material.emissiveIntensity = 0.9;
  if (region.waterMesh) region.waterMesh.visible = false;
}
function updateRise(region, now, frame) {
  const rise = region.rise;
  const pos = region.mesh.geometry.attributes.position;
  const elapsed = now - rise.born;
  let done = true;
  for (let i = 0; i < pos.count; i++) {
    const t = clamp((elapsed - rise.delays[i]) / 450, 0, 1);
    if (t < 1) done = false;
    pos.setY(i, -6 + (region.heights[i] + 6) * easeOutBack(t));
  }
  pos.needsUpdate = true;
  if (frame % 3 === 0 || done) region.mesh.geometry.computeVertexNormals();
  region.mesh.material.emissiveIntensity = Math.max(0, 0.9 - elapsed / 1500);
  if (elapsed > 300 && elapsed < 1400 && Math.random() < 0.6) {
    const u = rand(0, R);
    const v = rand(0, R);
    emit(region.rx * R + u, terrainAt(region, u, v) + 0.2, region.rz * R + v, PALETTES[region.color][0], 4, { speed: 3, up: 4, life: 0.8 });
  }
  if (done) {
    region.rise = null;
    region.mesh.material.emissiveIntensity = 0;
    if (region.waterMesh) region.waterMesh.visible = true;
    region.props.visible = true;
    region.props.scale.y = 0.01;
    animating.push({ kind: 'grow', obj: region.props, born: now, dur: 600 });
  }
}

// ---------- blueprints and beams while Kimi is writing ----------
function showBlueprint(region) {
  if (region.blueprint) return;
  const grid = new THREE.GridHelper(R, 20, 0xffb547, 0xffb547);
  grid.material.transparent = true;
  grid.material.opacity = 0.25;
  grid.material.depthWrite = false;
  grid.position.set(region.rx * R + R / 2, 0.05, region.rz * R + R / 2);
  scene.add(grid);
  const beams = [];
  for (let i = 0; i < 8; i++) {
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.35, 70, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: '#ffb547', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    scene.add(beam);
    beams.push({ mesh: beam, until: 0 });
  }
  const label = textSprite('', { scale: 2.4, bg: null, fg: '#ffb547', font: '700 64px "JetBrains Mono", monospace', width: 1700 });
  label.material.fog = false;
  label.position.set(region.rx * R + R / 2, 11, region.rz * R + R / 2);
  scene.add(label);
  region.blueprint = { grid, beams, label, labelText: '' };
}
function hideBlueprint(region) {
  if (!region.blueprint) return;
  scene.remove(region.blueprint.grid, region.blueprint.label, ...region.blueprint.beams.map((b) => b.mesh));
  region.blueprint = null;
}
function setBlueprintLabel(region, text) {
  const bp = region.blueprint;
  if (!bp || bp.labelText === text) return;
  bp.labelText = text;
  scene.remove(bp.label);
  bp.label = textSprite(text, { scale: 2.4, bg: null, fg: '#ffb547', font: '700 64px "JetBrains Mono", monospace', width: 1700 });
  bp.label.material.fog = false;
  bp.label.position.set(region.rx * R + R / 2, 11, region.rz * R + R / 2);
  scene.add(bp.label);
}
function updateBlueprint(region, now) {
  const bp = region.blueprint;
  const writing = region.status === 'writing';
  bp.grid.material.opacity = writing ? 0.35 + Math.sin(now / 120) * 0.2 : 0.14;
  setBlueprintLabel(region, writing ? '✍ Kimi is writing this region…' : '⏳ waiting in the Cerebras queue…');
  for (const b of bp.beams) {
    if (now > b.until) {
      b.mesh.position.set(region.rx * R + rand(3, R - 3), 35, region.rz * R + rand(3, R - 3));
      b.until = now + rand(250, 700);
    }
    b.mesh.material.opacity = writing ? 0.25 + Math.random() * 0.35 : 0;
  }
}

// ---------- region content ----------
function worldPos(region, x, z) {
  const u = clamp(Number(x) || 20, 2, 38);
  const v = clamp(Number(z) || 20, 2, 38);
  return { x: region.rx * R + u, z: region.rz * R + v, u, v };
}
function popIn(obj, now, delay = 0) {
  if (now <= 0) return;
  const base = obj.scale.clone();
  obj.scale.multiplyScalar(0.001);
  animating.push({ kind: 'pop', obj, born: now + delay, dur: 650, base });
}
// Landmarks fall out of the sky and land with a thud.
function dropIn(obj, now, delay) {
  if (now <= 0) return;
  const restY = obj.position.y;
  obj.position.y = restY + 34;
  obj.visible = false;
  animating.push({ kind: 'drop', obj, born: now + delay, dur: 650, restY });
}

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, flatShading: true, ...opts });
}
function landmarkMesh(type, size, pal) {
  const g = new THREE.Group();
  const s = clamp(size, 1, 5) * 0.6;
  const stone = mat('#cfd1dc');
  const dark = mat('#5b5e70');
  const accent = mat(pal[0]);
  const deep = mat(pal[1]);
  const glow = mat(pal[0], { emissive: pal[0], emissiveIntensity: 2.2 });
  const warm = mat('#ffcf6b', { emissive: '#ffb547', emissiveIntensity: 2.6 });
  const add = (geo, m, x, y, z, ry = 0) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };
  switch (type) {
    case 'tower': {
      const h = 9 * s;
      add(new THREE.CylinderGeometry(1.3 * s, 1.6 * s, h, 10), stone, 0, h / 2, 0);
      for (let k = 1; k <= 3; k++) add(new THREE.CylinderGeometry(1.45 * s, 1.45 * s, 0.25 * s, 10), deep, 0, (h * k) / 3.4, 0);
      for (let k = 0; k < 4; k++) add(new THREE.BoxGeometry(0.35 * s, 0.6 * s, 0.1), warm, Math.sin((k * Math.PI) / 2) * 1.35 * s, h * 0.72, Math.cos((k * Math.PI) / 2) * 1.35 * s, (k * Math.PI) / 2);
      add(new THREE.ConeGeometry(1.9 * s, 3 * s, 10), accent, 0, h + 1.5 * s, 0);
      add(new THREE.BoxGeometry(0.05, 1.2 * s, 0.05), dark, 0, h + 3.5 * s, 0);
      add(new THREE.BoxGeometry(0.8 * s, 0.45 * s, 0.03), glow, 0.4 * s, h + 3.8 * s, 0);
      break;
    }
    case 'ruin':
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const h = rand(1, 5) * s;
        add(new THREE.CylinderGeometry(0.35 * s, 0.42 * s, h, 7), stone, Math.cos(a) * 2.6 * s, h / 2, Math.sin(a) * 2.6 * s);
      }
      add(new THREE.BoxGeometry(2.6 * s, 0.5 * s, 0.9 * s), stone, 0.6 * s, 0.25 * s, 0.4 * s, 0.6);
      add(new THREE.CylinderGeometry(3.2 * s, 3.4 * s, 0.3, 14), dark, 0, 0.1, 0);
      add(new THREE.OctahedronGeometry(0.4 * s), glow, 0, 1.4 * s, 0);
      break;
    case 'arch': {
      add(new THREE.BoxGeometry(0.9 * s, 5 * s, 0.9 * s), stone, -2.2 * s, 2.5 * s, 0);
      add(new THREE.BoxGeometry(0.9 * s, 5 * s, 0.9 * s), stone, 2.2 * s, 2.5 * s, 0);
      const ring = add(new THREE.TorusGeometry(2.2 * s, 0.45 * s, 8, 18, Math.PI), accent, 0, 5 * s, 0);
      ring.rotation.z = 0;
      add(new THREE.TorusGeometry(1.7 * s, 0.08 * s, 6, 24, Math.PI), glow, 0, 5 * s, 0);
      break;
    }
    case 'statue':
      add(new THREE.BoxGeometry(2.4 * s, 1.4, 2.4 * s), stone, 0, 0.7, 0);
      add(new THREE.BoxGeometry(2.0 * s, 0.25, 2.0 * s), accent, 0, 1.5, 0);
      add(new THREE.BoxGeometry(2.5 * s, 0.12, 2.5 * s), glow, 0, 0.05, 0);
      break;
    case 'crystal':
      for (let i = 0; i < 6; i++) {
        const m = add(new THREE.OctahedronGeometry(0.8 * s), glow, rand(-1.1, 1.1) * s, (0.9 + i * 0.35) * s, rand(-1.1, 1.1) * s);
        m.scale.set(0.7, rand(2.2, 3.4), 0.7);
        m.rotation.set(rand(-0.3, 0.3), rand(0, 3), rand(-0.3, 0.3));
      }
      add(new THREE.DodecahedronGeometry(1.3 * s, 0), dark, 0, 0.2, 0);
      break;
    case 'tree': {
      add(new THREE.CylinderGeometry(0.28 * s, 0.5 * s, 4 * s, 7), mat('#6b4a2b'), 0, 2 * s, 0);
      for (let k = 0; k < 3; k++) add(new THREE.IcosahedronGeometry((2.1 - k * 0.45) * s, 0), k === 1 ? deep : accent, rand(-0.4, 0.4) * s, (3.8 + k * 1.4) * s, rand(-0.4, 0.4) * s);
      for (let k = 0; k < 5; k++) add(new THREE.SphereGeometry(0.14 * s, 8, 6), warm, rand(-1.6, 1.6) * s, rand(3.4, 6.2) * s, rand(-1.6, 1.6) * s);
      break;
    }
    case 'house': {
      add(new THREE.BoxGeometry(3.6 * s, 2.6 * s, 3.2 * s), stone, 0, 1.3 * s, 0);
      add(new THREE.ConeGeometry(3.1 * s, 2.2 * s, 4), accent, 0, 2.6 * s + 1.1 * s, 0, Math.PI / 4);
      add(new THREE.BoxGeometry(0.8 * s, 1.4 * s, 0.1), deep, 0, 0.7 * s, 1.62 * s);
      add(new THREE.BoxGeometry(0.7 * s, 0.6 * s, 0.1), warm, -1.1 * s, 1.5 * s, 1.62 * s);
      add(new THREE.BoxGeometry(0.7 * s, 0.6 * s, 0.1), warm, 1.1 * s, 1.5 * s, 1.62 * s);
      add(new THREE.BoxGeometry(0.5 * s, 1.6 * s, 0.5 * s), dark, 1.1 * s, 3.6 * s, -0.6 * s);
      break;
    }
    case 'obelisk': {
      add(new THREE.CylinderGeometry(0.35 * s, 1.0 * s, 9 * s, 4), deep, 0, 4.5 * s, 0, Math.PI / 4);
      add(new THREE.ConeGeometry(0.5 * s, 1.2 * s, 4), accent, 0, 9 * s + 0.6 * s, 0, Math.PI / 4);
      for (let k = 0; k < 3; k++) add(new THREE.TorusGeometry((0.95 - k * 0.15) * s, 0.06 * s, 6, 4), glow, 0, (2 + k * 2.2) * s, 0).rotation.x = Math.PI / 2;
      add(new THREE.BoxGeometry(2.6 * s, 0.4, 2.6 * s), stone, 0, 0.2, 0);
      break;
    }
    default: {
      add(new THREE.SphereGeometry(3 * s, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), accent, 0, 0, 0);
      add(new THREE.TorusGeometry(3 * s, 0.22 * s, 8, 28), stone, 0, 0.2, 0).rotation.x = Math.PI / 2;
      add(new THREE.CylinderGeometry(0.08 * s, 0.08 * s, 2.6 * s, 6), dark, 0, 3 * s + 1.2 * s, 0);
      add(new THREE.SphereGeometry(0.35 * s, 10, 8), glow, 0, 3 * s + 2.6 * s, 0);
    }
  }
  return g;
}

function spawnItem(region, item, now) {
  const pal = PALETTES[region.color];
  const p = worldPos(region, item.x, item.z);
  const y = terrainAt(region, p.u, p.v);
  const delay = 1100 + Math.random() * 500; // after the ground has risen
  if (item.kind === 'LANDMARK') {
    const g = landmarkMesh(item.type, item.size, pal);
    g.position.set(p.x, y - 0.15, p.z);
    g.rotation.y = rand(0, Math.PI * 2);
    if (item.type === 'statue') {
      const s = emojiSprite(region.emoji, 2.6 * clamp(item.size, 1, 5) * 0.6 + 1.5);
      s.position.set(0, 1.6 + s.scale.y / 2, 0);
      g.add(s);
    }
    const label = textSprite(item.name, { scale: 0.8 });
    label.position.set(0, 4 + item.size * 2.6, 0);
    g.add(label);
    scene.add(g);
    dropIn(g, now, delay);
    world.colliders.push({ x: p.x, z: p.z, r: 0.8 + clamp(item.size, 1, 5) * 0.55 });
  } else if (item.kind === 'NPC') {
    const s = emojiSprite(item.emoji, 1.9);
    s.position.set(p.x, y + 1.15, p.z);
    const tag = textSprite(item.name, { scale: 0.5 });
    tag.position.set(p.x, y + 2.45, p.z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.05, 6, 32), new THREE.MeshBasicMaterial({ color: '#8fe3a8', transparent: true, opacity: 0.7 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(p.x, y + 0.08, p.z);
    scene.add(s, tag, ring);
    popIn(s, now, delay);
    popIn(tag, now, delay + 100);
    region.npcs.push({ ...item, x: p.x, z: p.z, y, sprite: s, ring, met: false });
  } else if (item.kind === 'SHARD') {
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.36), new THREE.MeshStandardMaterial({ color: '#9ff8ff', emissive: '#3ad8ff', emissiveIntensity: 2.4, flatShading: true }));
    m.position.set(p.x, y + 1.1, p.z);
    m.castShadow = true;
    scene.add(m);
    popIn(m, now, delay);
    region.shards.push({ ...item, x: p.x, z: p.z, y: y + 1.1, mesh: m, taken: false });
  } else if (item.kind === 'CREATURE') {
    const s = emojiSprite(region.emoji, 1.4);
    s.position.set(p.x, y + 0.75, p.z);
    scene.add(s);
    popIn(s, now, delay);
    region.creatures.push({ x: p.x, z: p.z, home: { x: p.x, z: p.z }, sprite: s, heading: Math.random() * Math.PI * 2, turnAt: 0 });
  } else if (item.kind === 'SIGN') {
    const board = textSprite(item.text, { scale: 0.7, bg: '#f3e6c8', fg: '#2a1a0c', border: '#3a2614' });
    board.position.set(p.x, y + 2.1, p.z);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.8, 0.14), mat('#6b4a2b'));
    post.position.set(p.x, y + 0.9, p.z);
    post.castShadow = true;
    scene.add(board, post);
    popIn(board, now, delay);
  } else if (item.kind === 'QUEST') {
    const s = emojiSprite(item.emoji, 2.2);
    s.position.set(p.x, y + 1.7, p.z);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.9, 90, 14, 1, true),
      new THREE.MeshBasicMaterial({ color: '#ffd84d', transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    beam.position.set(p.x, y + 45, p.z);
    scene.add(s, beam);
    popIn(s, now, delay);
    region.quest = { ...item, x: p.x, z: p.z, y, sprite: s, beam, done: false };
  }
}

function applyLine(region, raw, now) {
  const parts = raw.trim().replace(/^[-*•\d.)\s]+(?=[A-Z]+\|)/, '').split('|').map((s) => s.trim());
  const kind = (parts[0] ?? '').toUpperCase();
  const num = (v) => Math.round(Number(v));
  if (kind === 'REGION' && parts.length >= 6) {
    if (region.status === 'ready') return null;
    region.name = parts[1].slice(0, 40) || 'Unnamed Expanse';
    region.color = PALETTES[parts[2]?.toLowerCase()] ? parts[2].toLowerCase() : 'teal';
    region.terrain = TERRAINS.has(parts[3]?.toLowerCase()) ? parts[3].toLowerCase() : 'hills';
    region.hill = clamp(num(parts[4]) || 4, 1, 10);
    region.emoji = [...(parts[5] || '✨')].slice(0, 4).join('');
    region.npcs = [];
    region.shards = [];
    region.creatures = [];
    buildRegion(region, now);
  } else if (kind === 'SOUND' && parts.length >= 7) {
    const root = parts[3] ? parts[3][0].toUpperCase() + parts[3].slice(1).toLowerCase() : '';
    region.sound = { bpm: parts[1], scale: parts[2].toLowerCase(), root, lead: parts[4].toLowerCase(), ambient: parts[5].toLowerCase(), room: parts[6].toLowerCase() };
  } else if (kind === 'MELODY' && parts.length >= 2) {
    region.melody = parts.slice(1).join(' ');
  } else if (kind === 'QUEST' && parts.length >= 5) {
    queueItem(region, { kind, text: parts[1].slice(0, 80), emoji: [...parts[2]].slice(0, 4).join(''), x: parts[3], z: parts[4] }, now);
  } else if (kind === 'LANDMARK' && parts.length >= 6) {
    const type = LANDMARKS.has(parts[1].toLowerCase()) ? parts[1].toLowerCase() : 'obelisk';
    queueItem(region, { kind, type, x: parts[2], z: parts[3], size: clamp(num(parts[4]) || 2, 1, 5), name: parts[5].slice(0, 40) }, now);
  } else if (kind === 'NPC' && parts.length >= 6) {
    queueItem(region, { kind, emoji: [...parts[1]].slice(0, 4).join(''), name: parts[2].slice(0, 30), x: parts[3], z: parts[4], line: parts.slice(5).join(' ').slice(0, 120) }, now);
  } else if (kind === 'SHARD' && parts.length >= 4) {
    queueItem(region, { kind, x: parts[1], z: parts[2], lore: parts.slice(3).join(' ').slice(0, 100) }, now);
  } else if (kind === 'CREATURE' && parts.length >= 3) {
    queueItem(region, { kind, x: parts[1], z: parts[2] }, now);
  } else if (kind === 'SIGN' && parts.length >= 4) {
    queueItem(region, { kind, x: parts[1], z: parts[2], text: parts.slice(3).join(' ').slice(0, 60) }, now);
  } else {
    return null;
  }
  world.lines++;
  return kind;
}
function queueItem(region, item, now) {
  if (region.status === 'ready') spawnItem(region, item, now);
  else region.items.push(item);
}

// ---------- walls at the edge of the written world ----------
const wallTexture = (() => {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, 'rgba(255,181,71,0)');
  grad.addColorStop(0.6, 'rgba(255,181,71,0.35)');
  grad.addColorStop(1, 'rgba(255,120,40,0.85)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const wallIdle = new THREE.MeshBasicMaterial({ map: wallTexture, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
const wallBusy = wallIdle.clone();
const walls = new Map();
function refreshWalls() {
  const wanted = new Set();
  for (const region of world.regions.values()) {
    if (region.status !== 'ready') continue;
    for (const [side, [dx, dz]] of Object.entries(SIDES)) {
      const n = world.regions.get(key(region.rx + dx, region.rz + dz));
      if (n && n.status === 'ready') continue;
      const k = `${region.key}:${side}`;
      wanted.add(k);
      if (!walls.has(k)) {
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(R, 30), wallIdle);
        wall.position.set(region.rx * R + R / 2 + dx * (R / 2), 5, region.rz * R + R / 2 + dz * (R / 2));
        if (dx !== 0) wall.rotation.y = Math.PI / 2;
        wall.userData.neighbour = key(region.rx + dx, region.rz + dz);
        scene.add(wall);
        walls.set(k, wall);
      }
    }
  }
  for (const [k, wall] of walls) {
    if (!wanted.has(k)) {
      scene.remove(wall);
      walls.delete(k);
    }
  }
}

// ---------- world log ----------
let thinkLine = null;
function log(text, cls = 'l-sys') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  ui.log.append(div);
  while (ui.log.childElementCount > LOG_LIMIT) ui.log.firstElementChild.remove();
  return div;
}
const LOG_CLASS = { REGION: 'l-region', SOUND: 'l-sound', MELODY: 'l-sound', QUEST: 'l-quest', LANDMARK: 'l-landmark', NPC: 'l-npc', SHARD: 'l-shard', CREATURE: 'l-run', SIGN: 'l-sign' };
function logThinking(text) {
  if (!thinkLine) thinkLine = log('', 'l-think');
  let next = thinkLine.textContent + text;
  if (next.length > 420) next = '…' + next.slice(next.length - 420);
  thinkLine.textContent = next;
}

// ---------- generation ----------
function regionContext(region) {
  const neighbours = {};
  for (const [side, [dx, dz]] of Object.entries(SIDES)) {
    const n = world.regions.get(key(region.rx + dx, region.rz + dz));
    if (n?.status === 'ready') neighbours[side] = n.name;
  }
  const used = [...world.regions.values()].filter((r) => r.name).map((r) => r.name);
  return { rx: region.rx, rz: region.rz, neighbours, used, chunk: ++gen.part };
}
function requestRegion(region) {
  region.status = 'requested';
  showBlueprint(region);
  const req = { region, startedAt: performance.now(), firstAt: null, meter: null, buffer: '', lines: 0 };
  gen.inflight.push(req);
  thinkLine = null;
  log(`── region (${region.rx}, ${region.rz}) requested · waiting in the Cerebras queue`, 'l-sys');
  streamRegion(req)
    .catch((err) => log(`region (${region.rx}, ${region.rz}): ${err.message}`, 'l-err'))
    .finally(() => {
      gen.inflight = gen.inflight.filter((r) => r !== req);
      if (region.status !== 'ready') {
        if (req.lines > 0) {
          applyLine(region, 'REGION|Unnamed Expanse|teal|hills|4|✨', performance.now());
        } else {
          region.status = 'missing';
          hideBlueprint(region);
          gen.retryAt = performance.now() + gen.backoff;
          log(`   nothing came back; asking again in ${Math.round(gen.backoff / 1000)}s`, 'l-sys');
          gen.backoff = Math.min(60000, gen.backoff * 1.6);
        }
      } else {
        gen.backoff = 8000;
      }
      refreshWalls();
    });
}
async function streamRegion(req) {
  const response = await fetch('/api/ogiri', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'region', context: regionContext(req.region), worldId: world.id }),
  });
  if (!response.ok) throw new Error(`server ${response.status}`);
  await readEvents(response, (event, data) => {
    const now = performance.now();
    if ((event === 'think' || event === 'delta') && req.firstAt === null) {
      req.firstAt = now;
      if (req.region.status === 'requested') req.region.status = 'writing';
      log(`── region (${req.region.rx}, ${req.region.rz}) · queue ${((now - req.startedAt) / 1000).toFixed(1)}s · Kimi is writing`, 'l-sys');
      filmEvents.push({ type: 'writing', at: req.region.key, t: Date.now() });
      if (FILM && state === 'play' && !filmCam) filmCam = { region: req.region, start: now, until: now + 14000 };
    }
    if (event === 'think') logThinking(data.text);
    else if (event === 'delta') {
      thinkLine = null;
      req.buffer += data.text;
      let i;
      while ((i = req.buffer.indexOf('\n')) >= 0) {
        acceptLine(req, req.buffer.slice(0, i));
        req.buffer = req.buffer.slice(i + 1);
      }
    } else if (event === 'meter') req.meter = data;
    else if (event === 'speed') finishSpeed(req, data);
    else if (event === 'error') log(`error: ${data.message}`, 'l-err');
  });
  if (req.buffer) acceptLine(req, req.buffer);
}
function acceptLine(req, raw) {
  const line = raw.trim();
  const kind = (line.split('|')[0] ?? '').toUpperCase();
  if (!LOG_CLASS[kind]) return;
  req.lines++;
  log(line, LOG_CLASS[kind]);
  applyLine(req.region, line, performance.now());
}
function finishSpeed(req, data) {
  const seconds = data.spanMs / 1000;
  if (!(seconds > 0)) return;
  const deltas = data.thinkDeltas + data.textDeltas;
  const exact = Boolean(data.completionTokens);
  const tokens = exact ? data.completionTokens : deltas * tokensPerDelta;
  if (exact && deltas > 0) saveRatio(data.completionTokens / deltas);
  gen.lastSpeed = { tps: tokens / seconds, tokens, seconds, approximate: !exact, region: req.region, queue: req.firstAt ? (req.firstAt - req.startedAt) / 1000 : null };
  req.meter = null;
  ui.speed.classList.remove('pulse');
  void ui.speed.offsetWidth;
  ui.speed.classList.add('pulse');
  log(`   ${exact ? '' : '≈'}${fmt(tokens)} tokens in ${seconds.toFixed(2)}s = ${exact ? '' : '≈'}${fmt(tokens / seconds)} tok/s`, 'l-sys');
}
async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}
async function loadSavedWorld() {
  try {
    const res = await fetch(`/api/world?id=${encodeURIComponent(world.id)}`);
    const data = await res.json();
    const records = (data.parts ?? []).filter((p) => p.kind === 'region');
    for (const rec of records) {
      const region = getRegion(rec.rx ?? 0, rec.rz ?? 0);
      if (region.status === 'ready') continue;
      for (const line of rec.lines ?? []) applyLine(region, line, -1);
      if (region.status !== 'ready' && rec.lines?.length) applyLine(region, 'REGION|Unnamed Expanse|teal|hills|4|✨', -1);
      gen.part = Math.max(gen.part, rec.part ?? 0);
    }
    if (records.length) log(`Loaded ${records.length} regions Kimi wrote earlier. The world continues from its edges.`, 'l-sys');
  } catch (err) {
    log(`could not load the saved world: ${err.message}`, 'l-err');
  }
  world.loaded = true;
}
function schedule(now) {
  if (!world.loaded || !released || now < gen.retryAt || gen.inflight.length >= MAX_INFLIGHT) return;
  const prx = Math.floor(player.x / R);
  const prz = Math.floor(player.z / R);
  const fx = Math.sin(player.heading);
  const fz = Math.cos(player.heading);
  const candidates = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const ring = Math.max(Math.abs(dx), Math.abs(dz));
      const ahead = dx * fx + dz * fz;
      if (ring === 2 && ahead < 0.9) continue;
      const region = getRegion(prx + dx, prz + dz);
      if (region.status !== 'missing') continue;
      const cx = (prx + dx) * R + R / 2 - player.x;
      const cz = (prz + dz) * R + R / 2 - player.z;
      candidates.push({ region, score: Math.hypot(cx, cz) - ahead * 18 });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  if (candidates.length) requestRegion(candidates[0].region);
}

// ---------- the explorer ----------
const player = { x: R / 2, y: 2, z: R / 2, vy: 0, grounded: true, heading: Math.PI, targetHeading: Math.PI, lastGroundedAt: 0, region: null, phase: 0, speed: 0, stepAt: 0 };
let camYaw = Math.PI;
let camPitch = 0.3;
let state = 'title';
const keys = new Set();
let dragging = null;
let toastTimer = 0;
let regionTimer = 0;

function buildExplorer() {
  const g = new THREE.Group();
  const coat = mat('#d8d2c4', { roughness: 0.7, flatShading: false });
  const trim = mat('#3a3f5a', { flatShading: false });
  const scarf = mat('#ff5c5c', { flatShading: false });
  const visor = mat('#5ff2ff', { emissive: '#2ac8d8', emissiveIntensity: 1.6, flatShading: false });
  const leather = mat('#8a5a36');
  const lanternMat = mat('#ffd58a', { emissive: '#ffb547', emissiveIntensity: 3.2, flatShading: false });
  const mk = (geo, m, parent, x, y, z) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const body = new THREE.Group();
  g.add(body);
  mk(new THREE.CapsuleGeometry(0.3, 0.45, 6, 12), coat, body, 0, 0.98, 0);
  mk(new THREE.CylinderGeometry(0.31, 0.33, 0.1, 14), trim, body, 0, 0.82, 0);
  mk(new THREE.SphereGeometry(0.27, 18, 14), coat, body, 0, 1.55, 0);
  mk(new THREE.BoxGeometry(0.4, 0.15, 0.12), visor, body, 0, 1.57, 0.22);
  mk(new THREE.TorusGeometry(0.24, 0.07, 8, 18), scarf, body, 0, 1.3, 0).rotation.x = Math.PI / 2;
  const tail = mk(new THREE.BoxGeometry(0.12, 0.42, 0.05), scarf, body, 0.12, 1.1, -0.27);
  mk(new THREE.BoxGeometry(0.42, 0.48, 0.22), leather, body, 0, 1.02, -0.32);
  const lantern = mk(new THREE.SphereGeometry(0.1, 12, 10), lanternMat, body, 0.2, 1.36, -0.38);
  // The lantern lights the ground around the explorer, not the explorer's own coat.
  const light = new THREE.PointLight('#ffc070', 3, 9, 1.6);
  light.position.set(0.3, 2.1, -0.9);
  body.add(light);
  const limb = (x, y, len, r) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    mk(new THREE.CapsuleGeometry(r, len, 4, 8), coat, pivot, 0, -len / 2 - r * 0.5, 0);
    body.add(pivot);
    return pivot;
  };
  const armL = limb(-0.38, 1.25, 0.36, 0.08);
  const armR = limb(0.38, 1.25, 0.36, 0.08);
  const legL = limb(-0.14, 0.62, 0.38, 0.1);
  const legR = limb(0.14, 0.62, 0.38, 0.1);
  return { g, body, armL, armR, legL, legR, tail };
}
const explorer = buildExplorer();
scene.add(explorer.g);

function showToast(who, text, ms = 4200) {
  ui.toast.innerHTML = `<span class="t-who">${escapeHtml(who)}</span>${escapeHtml(text)}`;
  ui.toast.classList.remove('hidden');
  ui.toast.style.animation = 'none';
  void ui.toast.offsetWidth;
  ui.toast.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), ms);
}
function enterRegion(region) {
  region.visited = true;
  region.spec = region.spec ?? soundSpec(region);
  audio.setZone(region.spec);
  const pal = PALETTES[region.color];
  const quest = region.quest && !region.quest.done ? `<div class="r-quest">QUEST · ${escapeHtml(region.quest.emoji)} ${escapeHtml(region.quest.text)}</div>` : '';
  ui.region.innerHTML = `<div class="r-kicker">REGION (${region.rx}, ${region.rz})</div><div class="r-name" style="color:${pal[0]}">${escapeHtml(region.emoji)} ${escapeHtml(region.name)}</div>${quest}<div class="r-sound">♪ ${escapeHtml(describe(region.spec))} · composed by Kimi</div>`;
  ui.region.classList.remove('hidden');
  ui.region.style.animation = 'none';
  void ui.region.offsetWidth;
  ui.region.style.animation = '';
  clearTimeout(regionTimer);
  regionTimer = setTimeout(() => ui.region.classList.add('hidden'), 4500);
}
function start() {
  audio.start();
  if (state !== 'title') return;
  const home = world.regions.get(key(0, 0));
  if (!home || home.status !== 'ready' || home.rise) return;
  state = 'play';
  ui.title.classList.add('hidden');
  const free = (x, z) => world.colliders.every((c) => Math.hypot(x - c.x, z - c.z) > c.r + 1.5);
  let spot = { x: R / 2, z: R / 2 };
  search: for (let ring = 0; ring < 14; ring++) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const x = R / 2 + Math.cos(a) * ring * 1.5;
      const z = R / 2 + Math.sin(a) * ring * 1.5;
      if (free(x, z)) {
        spot = { x, z };
        break search;
      }
    }
  }
  player.x = spot.x;
  player.z = spot.z;
  player.y = groundAt(player.x, player.z) ?? 2;
  emit(player.x, player.y + 1, player.z, '#5ff2ff', 60, { speed: 6, up: 5, life: 1.2 });
  audio.play('zone');
}

// ---------- input ----------
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space') {
    e.preventDefault();
    if (state === 'title') start();
    else if (!e.repeat) player.jumpAt = performance.now();
  }
  if (e.code === 'KeyM') log(audio.toggleMute() ? 'sound off (M)' : 'sound on (M)', 'l-sys');
  if (e.code.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
canvas.addEventListener('pointerdown', (e) => {
  if (state === 'title') {
    start();
    return;
  }
  audio.start();
  if (document.pointerLockElement !== canvas && canvas.requestPointerLock) {
    try {
      const p = canvas.requestPointerLock();
      if (p?.catch) p.catch(() => {});
    } catch {
      // drag fallback below
    }
  }
  dragging = { x: e.clientX, y: e.clientY };
});
window.addEventListener('pointermove', (e) => {
  if (document.pointerLockElement === canvas) {
    camYaw -= e.movementX * 0.0032;
    camPitch = clamp(camPitch + e.movementY * 0.0026, -0.15, 1.15);
  } else if (dragging) {
    camYaw -= (e.clientX - dragging.x) * 0.006;
    camPitch = clamp(camPitch + (e.clientY - dragging.y) * 0.004, -0.15, 1.15);
    dragging = { x: e.clientX, y: e.clientY };
  }
});
window.addEventListener('pointerup', () => {
  dragging = null;
});

// ---------- autopilot (for recording) ----------
const auto = { target: null, pickAt: 0, lastPos: null, checkAt: 0, dodgeUntil: 0, dodgeDir: 1, stuck: 0, blocked: new Map() };
function pickTarget() {
  let best = null;
  let bestD = Infinity;
  const now = performance.now();
  const consider = (x, z, weight = 0, kind = 'item') => {
    if ((auto.blocked.get(`${Math.round(x)},${Math.round(z)}`) ?? 0) > now) return;
    const d = Math.hypot(x - player.x, z - player.z) + weight;
    if (d < bestD && Math.hypot(x - player.x, z - player.z) > 1) {
      bestD = d;
      best = { x, z, kind };
    }
  };
  for (const region of world.regions.values()) {
    if (region.status !== 'ready' || region.rise) continue;
    if (region.quest && !region.quest.done) consider(region.quest.x, region.quest.z, -6);
    for (const s of region.shards) if (!s.taken) consider(s.x, s.z);
    for (const n of region.npcs) if (!n.met) consider(n.x, n.z, 2);
  }
  if (best && bestD < 70) return best;
  for (const region of world.regions.values()) if (region.status === 'ready' && !region.visited) consider(region.rx * R + R / 2, region.rz * R + R / 2, -10, 'region');
  if (best) return best;
  // Nothing left to do: go and watch the edge where Kimi is writing right now.
  for (const wall of walls.values()) {
    const n = world.regions.get(wall.userData.neighbour);
    const busy = n && (n.status === 'writing' || n.status === 'requested');
    const inward = new THREE.Vector3(wall.position.x, 0, wall.position.z).sub(tmpEdge.set(player.x, 0, player.z)).setLength(3.5);
    consider(wall.position.x - inward.x, wall.position.z - inward.z, busy ? -40 : 20, 'edge');
  }
  return best;
}
const tmpEdge = new THREE.Vector3();
function autopilot(now) {
  if (now >= auto.pickAt || !auto.target || Math.hypot(auto.target.x - player.x, auto.target.z - player.z) < 1.2) {
    auto.target = pickTarget();
    auto.pickAt = now + 1500;
  }
  if (now >= auto.checkAt) {
    if (auto.lastPos && Math.hypot(player.x - auto.lastPos.x, player.z - auto.lastPos.z) < 0.8) {
      auto.dodgeUntil = now + 700;
      auto.dodgeDir = Math.random() < 0.5 ? -1 : 1;
      player.jumpAt = now;
      // Give up on a target that cannot be reached and choose another.
      if (++auto.stuck >= 3 && auto.target && auto.target.kind !== 'edge') {
        auto.blocked.set(`${Math.round(auto.target.x)},${Math.round(auto.target.z)}`, now + 30000);
        auto.target = null;
        auto.stuck = 0;
      }
    } else {
      auto.stuck = 0;
    }
    auto.lastPos = { x: player.x, z: player.z };
    auto.checkAt = now + 1200;
  }
  if (!auto.target) return { fwd: 0, strafe: 0, sprint: false };
  const dist = Math.hypot(auto.target.x - player.x, auto.target.z - player.z);
  if (auto.target.kind === 'edge' && dist < 4) {
    // Wait at the edge and slowly pan to show the region being written.
    camYaw += 0.0025;
    auto.stuck = 0;
    return { fwd: 0, strafe: 0, sprint: false };
  }
  const desired = Math.atan2(auto.target.x - player.x, auto.target.z - player.z);
  camYaw += angleDiff(desired, camYaw) * 0.05;
  return { fwd: 1, strafe: now < auto.dodgeUntil ? auto.dodgeDir : 0, sprint: true };
}

// ---------- simulation ----------
let frameNo = 0;
function update(dt, now) {
  schedule(now);
  updateParticles(dt);
  for (let i = animating.length - 1; i >= 0; i--) {
    const a = animating[i];
    if (now < a.born) continue;
    const t = clamp((now - a.born) / a.dur, 0, 1);
    if (a.kind === 'pop') {
      a.obj.scale.copy(a.base).multiplyScalar(Math.max(0.001, easeOutBack(t)));
    } else if (a.kind === 'grow') {
      a.obj.scale.y = Math.max(0.01, easeOutBack(t));
    } else if (a.kind === 'drop') {
      a.obj.visible = true;
      a.obj.position.y = a.restY + 34 * (1 - t * t);
      if (t >= 1) {
        a.obj.position.y = a.restY;
        emit(a.obj.position.x, a.restY + 0.3, a.obj.position.z, '#e8dcc0', 46, { speed: 9, up: 3, life: 1.1, grav: 4, spread: 1.2 });
        const d = Math.hypot(a.obj.position.x - player.x, a.obj.position.z - player.z);
        if (d < 60) {
          audio.play('impact');
          shake = Math.max(shake, 0.35 * (1 - d / 60));
        }
      }
    }
    if (t >= 1) animating.splice(i, 1);
  }
  for (const region of world.regions.values()) {
    if (region.rise) updateRise(region, now, frameNo);
    if (region.blueprint) updateBlueprint(region, now);
    if (region.status !== 'ready') continue;
    if (region.waterMesh) region.waterMesh.position.y = WATER + Math.sin(now / 900 + region.rx) * 0.05;
    for (const s of region.shards) {
      if (s.taken) continue;
      s.mesh.rotation.y += dt * 1.6;
      s.mesh.position.y = s.y + Math.sin(now / 400 + s.x) * 0.18;
    }
    for (const n of region.npcs) n.ring.material.opacity = n.met ? 0.15 : 0.45 + Math.sin(now / 250 + n.x) * 0.25;
    if (region.quest && !region.quest.done) region.quest.beam.material.opacity = 0.24 + Math.sin(now / 300) * 0.08;
    for (const c of region.creatures) {
      if (now >= c.turnAt) {
        c.heading += rand(-1.4, 1.4);
        c.turnAt = now + rand(1200, 3200);
      }
      const nx = c.x + Math.sin(c.heading) * 1.4 * dt;
      const nz = c.z + Math.cos(c.heading) * 1.4 * dt;
      if (groundAt(nx, nz) === null || Math.hypot(nx - c.home.x, nz - c.home.z) > 7) c.heading += Math.PI;
      else {
        c.x = nx;
        c.z = nz;
      }
      const cy = groundAt(c.x, c.z) ?? 0;
      c.sprite.position.set(c.x, cy + 0.75 + Math.abs(Math.sin(now / 160 + c.home.x)) * 0.25, c.z);
      // Fade creatures that drift right in front of the camera.
      c.sprite.material.opacity = clamp((c.sprite.position.distanceTo(camera.position) - 2.5) / 3, 0.12, 1);
    }
  }
  for (const c of clouds.children) {
    c.position.x += c.userData.speed * dt;
    if (c.position.x > player.x + 300) c.position.x = player.x - 300;
  }
  // Motes follow the explorer.
  for (let i = 0; i < MOTES; i++) {
    let x = motePos[i * 3];
    let y = motePos[i * 3 + 1] + Math.sin(now / 900 + i) * 0.004;
    let z = motePos[i * 3 + 2];
    if (x - player.x > 28) x -= 56;
    if (player.x - x > 28) x += 56;
    if (z - player.z > 28) z -= 56;
    if (player.z - z > 28) z += 56;
    motePos.set([x + 0.004, y, z], i * 3);
  }
  moteGeo.attributes.position.needsUpdate = true;
  if (shake > 0) shake = Math.max(0, shake - dt * 0.8);

  if (state !== 'play') return;

  let fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  let strafe = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  let sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  if (keys.has('KeyQ')) camYaw += dt * 2;
  if (keys.has('KeyE')) camYaw -= dt * 2;
  if (AUTOPILOT && !fwd && !strafe) ({ fwd, strafe, sprint } = autopilot(now));
  const fx = Math.sin(camYaw);
  const fz = Math.cos(camYaw);
  let vx = fx * fwd - fz * strafe;
  let vz = fz * fwd + fx * strafe;
  const len = Math.hypot(vx, vz);
  const target = len > 0 ? (sprint ? SPRINT : WALK) : 0;
  player.speed += (target - player.speed) * Math.min(1, dt * (target > player.speed ? 7 : 10));
  if (len > 0) {
    vx /= len;
    vz /= len;
    player.targetHeading = Math.atan2(vx, vz);
    player.lastDir = { x: vx, z: vz };
  } else if (player.lastDir) {
    vx = player.lastDir.x;
    vz = player.lastDir.z;
  }
  player.heading += angleDiff(player.targetHeading, player.heading) * Math.min(1, dt * 12);
  const step = player.speed * dt;
  const tryMove = (nx, nz) => {
    const g = groundAt(nx, nz);
    if (g === null) return false;
    if (player.grounded && g - player.y > 1.3) return false;
    if (!player.grounded && g - player.y > 0.4) return false;
    for (const c of world.colliders) {
      const after = Math.hypot(nx - c.x, nz - c.z);
      if (after < c.r + 0.35 && after < Math.hypot(player.x - c.x, player.z - c.z)) return false;
    }
    player.x = nx;
    player.z = nz;
    return true;
  };
  if (step > 0.0001 && (vx || vz) && !tryMove(player.x + vx * step, player.z + vz * step)) {
    if (!tryMove(player.x + vx * step, player.z)) tryMove(player.x, player.z + vz * step);
  }
  if (len > 0 && groundAt(player.x + vx * 0.5, player.z + vz * 0.5) === null && now > (player.edgeToastAt ?? 0)) {
    const ahead = regionAt(player.x + vx, player.z + vz);
    const busy = ahead && (ahead.status === 'writing' || ahead.status === 'requested');
    showToast('UNWRITTEN', busy ? 'Kimi is writing what lies beyond this wall…' : 'Nothing has been written here yet.', 2400);
    player.edgeToastAt = now + 3000;
  }

  const ground = groundAt(player.x, player.z) ?? player.y;
  const canJump = player.grounded || now - player.lastGroundedAt < 110;
  if (player.jumpAt && now - player.jumpAt < 140 && canJump) {
    player.vy = JUMP;
    player.grounded = false;
    player.jumpAt = 0;
    audio.play('jump');
    emit(player.x, player.y + 0.1, player.z, '#e8dcc0', 10, { speed: 2.5, up: 1.5, life: 0.6, grav: 3 });
  }
  const wasAir = !player.grounded;
  const impact = -player.vy;
  player.vy -= GRAVITY * dt;
  player.y += player.vy * dt;
  if (player.y <= ground) {
    player.y = ground;
    player.vy = 0;
    if (wasAir && impact > 6) {
      audio.play('land');
      emit(player.x, ground + 0.1, player.z, '#e8dcc0', 16, { speed: 3.5, up: 1.2, life: 0.7, grav: 3 });
    }
    player.grounded = true;
    player.lastGroundedAt = now;
  } else if (player.y > ground + 0.25) {
    player.grounded = false;
  } else {
    player.y = ground;
    player.grounded = true;
    player.lastGroundedAt = now;
  }
  if (player.grounded && player.speed > 1) {
    player.phase += player.speed * dt * 1.55;
    if (now >= player.stepAt) {
      // One footstep per half stride: the leg swing advances player.speed * 1.55 rad/s.
      player.stepAt = now + (Math.PI / (player.speed * 1.55)) * 1000;
      audio.play('step');
      if (player.speed > 8) emit(player.x, player.y + 0.05, player.z, '#d9ccb0', 3, { speed: 1.5, up: 1, life: 0.5, grav: 2 });
    }
  }

  const region = regionAt(player.x, player.z);
  if (region && region !== player.region && region.status === 'ready') {
    player.region = region;
    enterRegion(region);
  }

  for (const r of world.regions.values()) {
    if (r.status !== 'ready' || r.rise || Math.abs(r.rx * R + R / 2 - player.x) > R * 1.5 || Math.abs(r.rz * R + R / 2 - player.z) > R * 1.5) continue;
    for (const s of r.shards) {
      if (s.taken || Math.hypot(s.x - player.x, s.z - player.z) > 1.3 || Math.abs(s.y - (player.y + 1)) > 1.6) continue;
      s.taken = true;
      scene.remove(s.mesh);
      stats.shards++;
      audio.play('coin');
      emit(s.x, s.y, s.z, '#7ff6ff', 40, { speed: 5, up: 4, life: 1, grav: 2 });
      showToast('MEMORY SHARD', `“${s.lore}”`);
      log(`shard: ${s.lore}`, 'l-shard');
    }
    for (const n of r.npcs) {
      if (n.met || Math.hypot(n.x - player.x, n.z - player.z) > 3.4) continue;
      n.met = true;
      stats.met++;
      audio.play('sign');
      showToast(n.name, `“${n.line}”`, 5200);
      const bubble = textSprite(n.line, { scale: 0.62, width: 1700 });
      bubble.position.set(n.x, n.y + 3.3, n.z);
      scene.add(bubble);
      popIn(bubble, now);
      setTimeout(() => scene.remove(bubble), 9000);
    }
    const q = r.quest;
    if (q && !q.done && Math.hypot(q.x - player.x, q.z - player.z) < 1.8) {
      q.done = true;
      stats.quests++;
      scene.remove(q.beam);
      q.sprite.scale.setScalar(3.2);
      audio.play('quest');
      emit(q.x, q.y + 1.5, q.z, '#ffd84d', 120, { speed: 8, up: 8, life: 1.6, grav: 5 });
      showToast('QUEST COMPLETE', `${q.emoji} ${q.text}`, 4500);
    }
    for (const c of r.creatures) {
      if (Math.hypot(c.x - player.x, c.z - player.z) < 0.9 && now > (player.bumpAt ?? 0)) {
        player.vy = 6;
        player.grounded = false;
        player.bumpAt = now + 900;
        audio.play('stomp');
      }
    }
  }
}

// ---------- rendering ----------
const skyTop = new THREE.Color();
const skyHorizon = new THREE.Color();
const skyBottom = new THREE.Color();
const camPos = new THREE.Vector3(R / 2, 30, R + 30);
const camLook = new THREE.Vector3(R / 2, 2, R / 2);
const tmpV = new THREE.Vector3();
const tmpW = new THREE.Vector3();

function render(now, dt) {
  if (filmCam) {
    const region = filmCam.region;
    // Hold the cutaway until the region has risen and settled, then return to the explorer.
    if (region.status === 'ready' && !region.rise && region.settleAt === undefined) region.settleAt = now + 2600;
    if (now > filmCam.until || (region.settleAt !== undefined && now > region.settleAt) || region.status === 'missing') {
      filmEvents.push({ type: 'cutaway-end', at: region.key, t: Date.now() });
      filmCam = null;
    }
  }
  if (filmCam) {
    const region = filmCam.region;
    const cx = region.rx * R + R / 2;
    const cz = region.rz * R + R / 2;
    const a = (now - filmCam.start) / 9000 + Math.atan2(player.x - cx, player.z - cz);
    tmpV.set(cx + Math.sin(a) * 36, 17, cz + Math.cos(a) * 36);
    camPos.lerp(tmpV, Math.min(1, dt * 2.2));
    camLook.lerp(tmpW.set(cx, 2, cz), Math.min(1, dt * 2.2));
  } else if (state === 'title') {
    const a = now / 11000;
    const orbit = FILM ? 33 : 52;
    tmpV.set(R / 2 + Math.sin(a) * orbit, FILM ? 15 : 26, R / 2 + Math.cos(a) * orbit);
    camPos.lerp(tmpV, Math.min(1, dt * 2));
    camLook.lerp(tmpW.set(R / 2, 3, R / 2), Math.min(1, dt * 2));
  } else {
    const dist = 8.5;
    const target = tmpW.set(player.x, player.y + 1.5, player.z);
    tmpV.set(
      target.x - Math.sin(camYaw) * dist * Math.cos(camPitch),
      target.y + Math.sin(camPitch) * dist,
      target.z - Math.cos(camYaw) * dist * Math.cos(camPitch),
    );
    // Pull the camera in front of any landmark between it and the explorer.
    const dx = tmpV.x - target.x;
    const dz = tmpV.z - target.z;
    const segLen = Math.hypot(dx, dz) || 1;
    let reach = 1;
    for (const c of world.colliders) {
      const ox = c.x - target.x;
      const oz = c.z - target.z;
      const along = (ox * dx + oz * dz) / (segLen * segLen);
      if (along <= 0 || along >= reach) continue;
      const px = target.x + dx * along - c.x;
      const pz = target.z + dz * along - c.z;
      if (Math.hypot(px, pz) < c.r + 0.6) reach = Math.max(0.18, along - (c.r + 0.8) / segLen);
    }
    tmpV.x = target.x + dx * reach;
    tmpV.z = target.z + dz * reach;
    tmpV.y = target.y + (tmpV.y - target.y) * Math.max(0.45, reach);
    // Keep the camera out of hills between it and the explorer.
    for (let k = 1; k <= 6; k++) {
      const t = k / 6;
      const g = groundAt(target.x + (tmpV.x - target.x) * t, target.z + (tmpV.z - target.z) * t);
      if (g !== null) tmpV.y = Math.max(tmpV.y, g + 0.9);
    }
    camPos.lerp(tmpV, Math.min(1, dt * 7));
    camLook.lerp(target, Math.min(1, dt * 12));
  }
  camera.position.copy(camPos);
  if (shake > 0) camera.position.add(tmpV.set(rand(-shake, shake), rand(-shake, shake), rand(-shake, shake)));
  camera.lookAt(camLook);
  sky.position.copy(camera.position);
  sun.position.set(camLook.x - 30, 55, camLook.z + 22);
  sun.target.position.copy(camLook);
  skyUniforms.sunDir.value.set(-30, 55, 22).normalize();

  // Sky, fog and ambient light take the colors of the region in view.
  const viewRegion = regionAt(camLook.x, camLook.z);
  if (viewRegion?.status === 'ready') {
    const pal = PALETTES[viewRegion.color];
    // A clear sky that deepens overhead, tinted by the region, never a white haze.
    skyHorizon.set(pal[0]).lerp(new THREE.Color('#9fc4ff'), 0.35).multiplyScalar(0.78);
    skyTop.set('#1f4fa8').lerp(new THREE.Color(pal[1]), 0.3).multiplyScalar(0.8);
    skyBottom.set(pal[2]);
  } else {
    skyHorizon.set('#2a2f55');
    skyTop.set('#0b0f24');
    skyBottom.set('#07080f');
  }
  const k = Math.min(1, dt * 1.2);
  skyUniforms.top.value.lerp(skyTop, k);
  skyUniforms.horizon.value.lerp(skyHorizon, k);
  skyUniforms.bottom.value.lerp(skyBottom, k);
  scene.fog.color.copy(skyUniforms.horizon.value).multiplyScalar(0.85);
  hemi.color.copy(skyUniforms.horizon.value);
  hemi.groundColor.copy(skyUniforms.bottom.value);
  moteMat.color.copy(skyUniforms.horizon.value).lerp(new THREE.Color('#fff2c0'), 0.5);

  wallBusy.opacity = 0.5 + Math.sin(now / 140) * 0.2;
  for (const wall of walls.values()) {
    const n = world.regions.get(wall.userData.neighbour);
    wall.material = n && (n.status === 'writing' || n.status === 'requested') ? wallBusy : wallIdle;
  }

  // Explorer animation.
  explorer.g.visible = state === 'play';
  explorer.g.position.set(player.x, player.y, player.z);
  explorer.g.rotation.y = player.heading;
  const moving = player.grounded ? clamp(player.speed / WALK, 0, 1.4) : 0;
  const swing = Math.sin(player.phase) * 0.85 * moving;
  if (player.grounded) {
    explorer.legL.rotation.x = swing;
    explorer.legR.rotation.x = -swing;
    explorer.armL.rotation.x = -swing * 0.8;
    explorer.armR.rotation.x = swing * 0.8;
    explorer.body.position.y = Math.abs(Math.sin(player.phase)) * 0.07 * moving + Math.sin(now / 700) * 0.01;
  } else {
    explorer.legL.rotation.x = 0.7;
    explorer.legR.rotation.x = -0.3;
    explorer.armL.rotation.x = -2.4;
    explorer.armR.rotation.x = -2.4;
    explorer.body.position.y = 0;
  }
  explorer.body.rotation.x = moving * 0.08;
  explorer.tail.rotation.x = 0.3 + moving * 0.5 + Math.sin(now / 120) * 0.1 * moving;

  composer.render();
}

function drawMinimap(now) {
  const size = minimap.width;
  const cell = 26;
  mm.clearRect(0, 0, size, size);
  const prx = player.x / R;
  const prz = player.z / R;
  const toX = (rx) => size / 2 + (rx - prx) * cell;
  const toY = (rz) => size / 2 + (rz - prz) * cell;
  for (const region of world.regions.values()) {
    const x = toX(region.rx);
    const y = toY(region.rz);
    if (x < -cell || y < -cell || x > size || y > size) continue;
    if (region.status === 'ready') {
      mm.fillStyle = PALETTES[region.color][1];
      mm.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      if (region.quest && !region.quest.done) {
        mm.fillStyle = '#ffd84d';
        mm.fillRect(toX(region.quest.x / R) - 2, toY(region.quest.z / R) - 2, 4, 4);
      }
    } else if (region.status === 'writing' || region.status === 'requested') {
      mm.strokeStyle = `rgba(255,181,71,${region.status === 'writing' ? 0.6 + Math.sin(now / 150) * 0.4 : 0.5})`;
      mm.lineWidth = 2;
      mm.strokeRect(x + 2, y + 2, cell - 4, cell - 4);
    }
  }
  mm.save();
  mm.translate(size / 2, size / 2);
  mm.rotate(-player.heading + Math.PI);
  mm.fillStyle = '#ffffff';
  mm.beginPath();
  mm.moveTo(0, -7);
  mm.lineTo(5, 6);
  mm.lineTo(-5, 6);
  mm.closePath();
  mm.fill();
  mm.restore();
}

function updateCompass() {
  if (state !== 'play') {
    ui.compass.classList.add('hidden');
    return;
  }
  let best = null;
  let bestD = Infinity;
  for (const region of world.regions.values()) {
    const q = region.quest;
    if (!q || q.done || region.rise) continue;
    const d = Math.hypot(q.x - player.x, q.z - player.z);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  if (!best) {
    ui.compass.classList.add('hidden');
    return;
  }
  const bearing = Math.atan2(best.x - player.x, best.z - player.z);
  const rel = angleDiff(bearing, camYaw);
  ui.compassArrow.style.transform = `rotate(${-rel}rad)`;
  ui.compassText.innerHTML = `${escapeHtml(best.emoji)} ${escapeHtml(best.text)} · <b>${Math.round(bestD)} m</b>`;
  ui.compass.classList.remove('hidden');
}

function updateHud(now) {
  const ready = [...world.regions.values()].filter((r) => r.status === 'ready').length;
  ui.regions.textContent = String(ready);
  ui.shards.textContent = String(stats.shards);
  ui.quests.textContent = String(stats.quests);
  ui.met.textContent = String(stats.met);
  const live = gen.inflight.find((r) => r.meter && r.meter.spanMs > 0);
  if (live) {
    const tokens = (live.meter.thinkDeltas + live.meter.textDeltas) * tokensPerDelta;
    const seconds = live.meter.spanMs / 1000;
    ui.tps.textContent = `≈${fmt(tokens / seconds)}`;
    ui.tok.textContent = `≈${fmt(tokens)}`;
    ui.sec.textContent = seconds.toFixed(1);
    ui.speedNote.textContent = `writing region (${live.region.rx}, ${live.region.rz}) right now`;
  } else if (gen.lastSpeed) {
    const s = gen.lastSpeed;
    ui.tps.textContent = `${s.approximate ? '≈' : ''}${fmt(s.tps)}`;
    ui.tok.textContent = `${s.approximate ? '≈' : ''}${fmt(s.tokens)}`;
    ui.sec.textContent = s.seconds.toFixed(1);
    ui.speedNote.textContent = `“${s.region.name ?? '…'}” · ×${fmt(s.tps / HUMAN_TOKENS_PER_SECOND)} human typing${s.queue !== null ? ` · queue ${s.queue.toFixed(0)}s (not counted)` : ''}`;
  }
  const status = gen.inflight.length
    ? gen.inflight.map((r) => `(${r.region.rx},${r.region.rz}) ${r.firstAt === null ? `queued ${((now - r.startedAt) / 1000).toFixed(0)}s` : 'writing'}`).join(' · ')
    : now < gen.retryAt
      ? `retry in ${((gen.retryAt - now) / 1000).toFixed(0)}s`
      : 'idle';
  ui.logMeta.textContent = `${status} · ${fmt(world.lines)} lines`;
  if (state === 'title') {
    const home = world.regions.get(key(0, 0));
    if (home?.status === 'ready' && !home.rise) {
      ui.titleStatus.textContent = `Kimi has written “${home.name}” · ${ready} regions so far`;
      ui.startHint.classList.remove('hidden');
    } else if (gen.inflight.length) {
      const r = gen.inflight[0];
      ui.titleStatus.textContent = r.firstAt === null ? `Kimi is in the Cerebras queue… ${((now - r.startedAt) / 1000).toFixed(1)}s` : 'Kimi is writing the place where you wake up…';
    }
  }
}

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.setSize(w, h);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// Recording hooks, driven from the preview tool while capturing a demo.
let recorder = null;
window.__unwritten = {
  go() {
    released = true;
    return 'released';
  },
  start() {
    start();
    return state;
  },
  // Staging for recordings: walk the autopilot to a spot and wait there.
  aim(x, z) {
    auto.target = { x, z, kind: 'edge' };
    auto.pickAt = performance.now() + 10 * 60 * 1000;
    return 'aiming';
  },
  events() {
    return filmEvents.slice();
  },
  status() {
    return {
      state,
      regions: [...world.regions.values()].filter((r) => r.status !== 'missing').map((r) => ({ at: r.key, status: r.status, name: r.name, rising: Boolean(r.rise) })),
      inflight: gen.inflight.map((r) => ({ at: r.region.key, writing: r.firstAt !== null })),
      player: { x: Math.round(player.x), z: Math.round(player.z) },
      stats,
    };
  },
  sync() {
    const flash = document.createElement('div');
    flash.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:99';
    document.body.append(flash);
    audio.play('sync');
    setTimeout(() => flash.remove(), 150);
    return 'sync';
  },
  startAudio(name) {
    const stream = audio.capture();
    if (!stream) return 'no audio';
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      const res = await fetch(`/api/recordings?name=${encodeURIComponent(name)}`, { method: 'POST', body: new Blob(chunks, { type: 'audio/webm' }) });
      recorder.saved = await res.json();
    };
    recorder.start(1000);
    return 'recording audio';
  },
  async stopAudio() {
    if (!recorder) return 'not recording';
    const r = recorder;
    r.stop();
    for (let i = 0; i < 100 && !r.saved; i++) await new Promise((ok) => setTimeout(ok, 100));
    recorder = null;
    return r.saved ?? 'upload pending';
  },
};
if (FILM) {
  ui.title.classList.add('hidden');
  document.body.classList.add('film');
}
if (AUTOPILOT) {
  const tag = document.createElement('div');
  tag.className = 'stat';
  tag.innerHTML = '<span class="label">MODE</span><span class="value accent">AUTO</span>';
  document.querySelector('.hud-left').append(tag);
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.033, (now - lastFrame) / 1000);
  lastFrame = now;
  frameNo++;
  update(dt, now);
  render(now, dt);
  drawMinimap(now);
  updateCompass();
  updateHud(now);
  requestAnimationFrame(frame);
}

resize();
log('UNWRITTEN · every line Kimi writes appears here, as it writes it.', 'l-sys');
log(`world ${world.id.slice(0, 11)} · add ?fresh=1 for a brand-new world`, 'l-sys');
getRegion(0, 0);
loadSavedWorld();
requestAnimationFrame(frame);
