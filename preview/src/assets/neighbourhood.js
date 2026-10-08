// Neighbourhood around the preview house: ground, street, our garden, neighbours, far blocks, forest, skyline.
// Everything static is merged per material (few draw calls); repeated far objects are instanced.
// Returns spots for detailed trees, shrubs, hedges and cars, which other kits build.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function nbRng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function nbTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function nbSpeckle(g, w, h, R, n, alpha, light) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = light ? `rgba(255,255,255,${R() * alpha})` : `rgba(0,0,0,${R() * alpha})`;
    const s = 1 + R() * 1.8;
    g.fillRect(R() * w, R() * h, s, s);
  }
}

let NB = null;
function nbAssets() {
  if (NB) return NB;
  /* Textures. Each one states the real-world size it covers. */
  const grass = nbTex(512, 512, (g, w, h) => { // 3 m
    const R = nbRng(3);
    g.fillStyle = '#5b8a3f'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const x = R() * w, y = R() * h, r = 40 + R() * 90;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      const c = R() < 0.5 ? '96,140,62' : '78,116,50';
      grd.addColorStop(0, `rgba(${c},0.35)`); grd.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 16000; i++) {
      const v = (R() - 0.5) * 46;
      g.fillStyle = `rgba(${(84 + v) | 0},${(128 + v) | 0},${(56 + v * 0.5) | 0},0.55)`;
      g.fillRect(R() * w, R() * h, 1.4, 2.6 + R() * 2);
    }
  });
  const lawn = nbTex(256, 256, (g, w, h) => { // 1.8 m wide: two mowing stripes
    const R = nbRng(4);
    g.fillStyle = '#6a9d45'; g.fillRect(0, 0, w / 2, h);
    g.fillStyle = '#5c8f3c'; g.fillRect(w / 2, 0, w / 2, h);
    for (let i = 0; i < 9000; i++) {
      const v = (R() - 0.5) * 40;
      g.fillStyle = `rgba(${(92 + v) | 0},${(140 + v) | 0},${(62 + v * 0.5) | 0},0.45)`;
      g.fillRect(R() * w, R() * h, 1.2, 2.4);
    }
  });
  const asphalt = nbTex(512, 512, (g, w, h) => { // 4 m
    const R = nbRng(5);
    g.fillStyle = '#45474a'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 30000; i++) {
      const v = (R() - 0.5) * 50;
      g.fillStyle = `rgba(${(70 + v) | 0},${(72 + v) | 0},${(75 + v) | 0},0.6)`;
      g.fillRect(R() * w, R() * h, 1.3, 1.3);
    }
    for (let i = 0; i < 6; i++) {
      const x = R() * w, y = R() * h, r = 50 + R() * 80;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(25,25,27,0.22)'); grd.addColorStop(1, 'rgba(25,25,27,0)');
      g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  const tiles = nbTex(256, 256, (g, w, h) => { // 1.2 m, 30 x 30 cm tiles
    const R = nbRng(6);
    g.fillStyle = '#8c8a86'; g.fillRect(0, 0, w, h);
    const n = 4, s = w / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = (R() - 0.5) * 18;
      g.fillStyle = `rgb(${(178 + v) | 0},${(176 + v) | 0},${(170 + v) | 0})`;
      g.fillRect(i * s + 1.5, j * s + 1.5, s - 3, s - 3);
    }
    nbSpeckle(g, w, h, R, 3000, 0.12);
  });
  const herring = nbTex(512, 512, (g, w, h) => { // 2 m: 20 x 10 cm concrete pavers in half bond, sand joints
    const R = nbRng(7);
    g.fillStyle = '#8b8377'; g.fillRect(0, 0, w, h);
    const bw = w / 10, bh = h / 20;
    for (let r = 0; r < 20; r++) {
      const off = (r % 2) * bw / 2;
      for (let c = -1; c <= 10; c++) {
        const v = (R() - 0.5) * 22;
        g.fillStyle = `rgb(${(92 + v) | 0},${(93 + v) | 0},${(96 + v) | 0})`;
        g.fillRect(c * bw + off + 1, r * bh + 1, bw - 2, bh - 2);
        g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(c * bw + off + 1, r * bh + 1, bw - 2, 2);
      }
    }
    nbSpeckle(g, w, h, R, 7000, 0.16);
  });
  const brick = nbTex(512, 256, (g, w, h) => { // 2 m x 1 m, light so the material colour tints it
    const R = nbRng(8);
    g.fillStyle = '#cfc8be'; g.fillRect(0, 0, w, h);
    const rows = 16, rh = h / rows, per = 9, bw = w / per;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * bw / 2;
      for (let i = -1; i <= per; i++) {
        const v = (R() - 0.5) * 40;
        g.fillStyle = `rgb(${(200 + v) | 0},${(160 + v) | 0},${(140 + v) | 0})`;
        g.fillRect(i * bw + off + 1.5, r * rh + 1.5, bw - 3, rh - 3);
      }
    }
    nbSpeckle(g, w, h, R, 4000, 0.1);
  });
  const roof = nbTex(512, 512, (g, w, h) => { // 2 m, light pans so the material colour tints them
    const R = nbRng(9);
    const cols = 7, rows = 6, tw = w / cols, th = h / rows;
    g.fillStyle = '#6a6a6a'; g.fillRect(0, 0, w, h);
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * tw * 0.5;
      for (let c = -1; c < cols; c++) {
        const x = c * tw + off, y = r * th, v = (R() - 0.5) * 26;
        const grd = g.createLinearGradient(0, y, 0, y + th);
        grd.addColorStop(0, `rgb(${(120 + v) | 0},${(120 + v) | 0},${(120 + v) | 0})`);
        grd.addColorStop(0.16, `rgb(${(232 + v) | 0},${(232 + v) | 0},${(232 + v) | 0})`);
        grd.addColorStop(1, `rgb(${(205 + v) | 0},${(205 + v) | 0},${(205 + v) | 0})`);
        g.fillStyle = grd; g.fillRect(x + 1, y + 1, tw - 2, th - 2);
        const hg = g.createLinearGradient(x, 0, x + tw, 0);
        hg.addColorStop(0, 'rgba(255,255,255,0.08)'); hg.addColorStop(0.35, 'rgba(255,255,255,0.16)'); hg.addColorStop(1, 'rgba(0,0,0,0.22)');
        g.fillStyle = hg; g.fillRect(x + 1, y + 1, tw - 2, th - 2);
      }
    }
    nbSpeckle(g, w, h, R, 5000, 0.12);
  });
  const windowT = nbTex(128, 128, (g, w, h) => {
    g.fillStyle = '#efede7'; g.fillRect(0, 0, w, h);
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, '#62788a'); grd.addColorStop(0.5, '#243039'); grd.addColorStop(1, '#3a4955');
    g.fillStyle = grd; g.fillRect(9, 9, w - 18, h - 18);
    g.fillStyle = '#efede7'; g.fillRect(w / 2 - 3, 9, 6, h - 18);
    g.fillStyle = 'rgba(255,255,255,0.16)'; g.beginPath(); g.moveTo(13, 13); g.lineTo(44, 13); g.lineTo(13, 50); g.fill();
  });
  const wood = nbTex(256, 256, (g, w, h) => { // 1.2 m of 12 cm boards
    const R = nbRng(10);
    g.fillStyle = '#2a211b'; g.fillRect(0, 0, w, h);
    const n = 10, bh = h / n;
    for (let i = 0; i < n; i++) {
      const v = (R() - 0.5) * 16;
      g.fillStyle = `rgb(${(78 + v) | 0},${(60 + v) | 0},${(46 + v) | 0})`;
      g.fillRect(0, i * bh + 1.5, w, bh - 3);
      for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(30,22,16,${R() * 0.25})`; g.fillRect(R() * w, i * bh + 2 + R() * (bh - 4), 10 + R() * 40, 1); }
    }
  });
  const facade = nbTex(256, 256, (g, w, h) => { // 12 m: 4 bays x 4 floors
    const R = nbRng(11);
    g.fillStyle = '#d9d6cf'; g.fillRect(0, 0, w, h);
    const s = w / 4;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const lit = R();
      g.fillStyle = lit < 0.15 ? '#8796a3' : lit < 0.3 ? '#4a5866' : '#5f7182';
      g.fillRect(i * s + 6, j * s + 10, s - 12, s - 22);
      g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(i * s + 6, j * s + 10, s - 12, 4);
    }
  });

  const std = (o) => new THREE.MeshStandardMaterial(o);
  const M = {
    grass: std({ map: grass, roughness: 1, vertexColors: true }),
    lawn: std({ map: lawn, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    asphalt: std({ map: asphalt, roughness: 0.92 }),
    tiles: std({ map: tiles, roughness: 0.9 }),
    terrace: std({ map: tiles, color: 0xb9b6b0, roughness: 0.85 }),
    gutter: std({ map: tiles, color: 0x8f8d88, roughness: 0.9 }),
    kerb: std({ color: 0xb7b4ad, roughness: 0.85 }),
    herring: std({ map: herring, roughness: 0.9 }),
    brick0: std({ map: brick, color: 0xa5583f, roughness: 0.93 }),
    brick1: std({ map: brick, color: 0x6e4433, roughness: 0.93 }),
    brick2: std({ map: brick, color: 0xd2b58d, roughness: 0.93 }),
    roof0: std({ map: roof, color: 0xb35a3e, roughness: 0.75 }),
    roof1: std({ map: roof, color: 0x43464b, roughness: 0.7 }),
    window: std({ map: windowT, roughness: 0.3 }),
    door: std({ color: 0x2c3a33, roughness: 0.6 }),
    trim: std({ color: 0xe9e6df, roughness: 0.7 }),
    dark: std({ color: 0x2f3134, roughness: 0.8 }),
    panel: std({ color: 0x18243a, roughness: 0.3, metalness: 0.1 }),
    wood: std({ map: wood, roughness: 0.9 }),
    hedge: std({ map: grass, color: 0x7da45f, roughness: 1 }),
    lamp: std({ color: 0x6b7075, roughness: 0.45, metalness: 0.6 }),
    crown: std({ color: 0xffffff, roughness: 1 }),
    pine: std({ color: 0x2f4a2c, roughness: 1 }),
    trunk: std({ color: 0x4d3a2a, roughness: 1 }),
    mini: std({ vertexColors: true, roughness: 0.9 }),
    tower0: std({ map: facade, color: 0x9fb2c4, roughness: 0.35, metalness: 0.2 }),
    tower1: std({ map: facade, color: 0xe6e3dc, roughness: 0.8 }),
    tower2: std({ map: facade, color: 0x6c7b88, roughness: 0.3, metalness: 0.25 }),
  };
  NB = { M };
  return NB;
}

/* Geometry helpers: UVs in metres divided by the texture's real-world tile size. */
function nbBox(w, h, d, tw = 1, th = 1) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  const uv = geo.attributes.uv;
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k;
    uv.setXY(i, (uv.getX(i) * dims[f][0]) / tw, (uv.getY(i) * dims[f][1]) / th);
  }
  return geo;
}
function nbPlane(w, h, tw = 1, th = 1) {
  const geo = new THREE.PlaneGeometry(w, h);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / tw, (uv.getY(i) * h) / th);
  return geo;
}
const nbM4 = new THREE.Matrix4(), nbQ = new THREE.Quaternion(), nbE = new THREE.Euler(), nbS = new THREE.Vector3(1, 1, 1);
function nbXf(geo, x, y, z, rx = 0, ry = 0, rz = 0, order = 'XYZ') {
  nbM4.compose(new THREE.Vector3(x, y, z), nbQ.setFromEuler(nbE.set(rx, ry, rz, order)), nbS);
  geo.applyMatrix4(nbM4);
  return geo;
}

class NbBuckets {
  constructor() { this.map = new Map(); }
  put(key, geo, parent) {
    if (parent) geo.applyMatrix4(parent);
    const g = geo.index ? geo.toNonIndexed() : geo;
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!this.map.has(key)) this.map.set(key, []);
    this.map.get(key).push(g);
  }
  build(group, M, flags = {}) {
    for (const [key, list] of this.map) {
      const mesh = new THREE.Mesh(mergeGeometries(list, false), M[key]);
      const f = flags[key] || {};
      mesh.castShadow = f.cast !== false;
      mesh.receiveShadow = f.receive !== false;
      if (f.noAO) mesh.userData.noAO = true;
      mesh.name = 'nb-' + key;
      group.add(mesh);
    }
  }
}

/* A simplified Dutch house: brick walls, tiled gable roof, windows, door, optional dormer, panels, chimney.
   Built in local space (ridge along x, front facade towards -z), then placed with `rotY` at (x, z). */
function nbHouse(B, o) {
  const { w, d, h, pitch } = o;
  const ov = 0.35, t = 0.12, tp = Math.tan(pitch);
  const parent = new THREE.Matrix4().compose(new THREE.Vector3(o.x, 0, o.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, o.rotY || 0, 0)), new THREE.Vector3(1, 1, 1));
  const put = (key, geo) => B.put(key, geo, parent);
  put(o.brick, nbXf(nbBox(w, h, d, 2, 1), 0, h / 2, 0));
  put('dark', nbXf(nbBox(w + 0.06, 0.4, d + 0.06), 0, 0.2, 0));
  const rise = (d / 2) * tp;
  const run = d / 2 + ov, L = run / Math.cos(pitch);
  for (const side of [-1, 1]) {
    const geo = nbBox(w + 0.5, t, L, 2, 2);
    const cz = side * run / 2, cy = h - ov * tp + (run * tp) / 2;
    put(o.roof, nbXf(geo, 0, cy, cz, side < 0 ? -pitch : pitch, 0, 0));
    const tri = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, rise)]);
    const gable = new THREE.ShapeGeometry(tri);
    const uv = gable.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 2, uv.getY(i));
    gable.rotateY(side * Math.PI / 2);
    put(o.brick, nbXf(gable, side * w / 2, h, 0));
  }
  put('dark', nbXf(nbBox(w + 0.52, 0.18, 0.18), 0, h + rise + 0.05, 0, Math.PI / 4, 0, 0));
  /* Windows and door on the long sides, small ones on the gables. */
  const R = o.R;
  const slots = Math.max(2, Math.floor(w / 2.4));
  const doorSlot = o.doorSlot ?? Math.floor(R() * slots);
  for (const side of [-1, 1]) {
    for (let i = 0; i < slots; i++) {
      const x = -w / 2 + (i + 0.5) * (w / slots);
      const z = side * (d / 2 + 0.02);
      const ry = side < 0 ? Math.PI : 0;
      if (side < 0 && i === doorSlot) {
        put('door', nbXf(nbPlane(1.0, 2.2), x, 0.4 + 1.1, z, 0, ry, 0));
        put('trim', nbXf(nbBox(1.2, 0.1, 0.15), x, 2.65, z + side * 0.05));
      } else {
        put('window', nbXf(nbPlane(1.3, 1.3), x, 1.75, z, 0, ry, 0));
      }
      if (h > 4.8) put('window', nbXf(nbPlane(1.15, 1.2), x, 4.3, z, 0, ry, 0));
    }
  }
  for (const side of [-1, 1]) {
    put('window', nbXf(nbPlane(1.0, 1.2), side * (w / 2 + 0.02), 1.8, d * 0.18, 0, side * Math.PI / 2, 0));
    if (rise > 1.6) put('window', nbXf(nbPlane(0.7, 0.9), side * (w / 2 + 0.02), h + rise * 0.35, 0, 0, side * Math.PI / 2, 0));
  }
  /* Point on the front (-z) slope: s along the slope from the eave edge, lift along its normal. */
  const front = (x, s, lift) => new THREE.Vector3(x, h - ov * tp + s * Math.sin(pitch) + lift * Math.cos(pitch), -run + s * Math.cos(pitch) - lift * Math.sin(pitch));
  if (o.dormer) {
    const dz = -d / 2 + 1.0, dy = h + 1.0 * tp;
    put('trim', nbXf(nbBox(2.8, 1.55, 1.9), 0, dy + 0.55, dz + 0.95));
    put('window', nbXf(nbPlane(2.2, 1.0), 0, dy + 0.62, dz - 0.005, 0, Math.PI, 0));
    put('dark', nbXf(nbBox(3.0, 0.12, 2.1), 0, dy + 1.38, dz + 0.95));
  }
  if (o.panels) {
    const cols = Math.min(5, Math.floor((w - 1.5) / 1.05));
    for (let r = 0; r < 2; r++) for (let c = 0; c < cols; c++) {
      const p = front(-cols * 0.525 + 0.5 + c * 1.05 + (o.dormer ? 0 : 0), 1.0 + r * 1.72 + 0.85, 0.12);
      if (o.dormer && Math.abs(p.x) < 1.8) continue;
      put('panel', nbXf(nbBox(1.0, 0.04, 1.68), p.x, p.y, p.z, -pitch, 0, 0));
    }
  }
  if (o.chimney) put(o.brick, nbXf(nbBox(0.55, 1.7, 0.55, 2, 1), w * 0.28, h + rise - 0.1, d * 0.12));
}

/* Low-poly "far house": walls + prism roof with vertex colours, used instanced at 80-400 m. */
function nbMiniHouse() {
  /* Unit house: walls 1 x 0.6 x 0.8, gable roof along x with a little overhang. Vertex colours: walls / roof. */
  const walls = new THREE.BoxGeometry(1, 0.6, 0.8).toNonIndexed();
  walls.translate(0, 0.3, 0);
  walls.deleteAttribute('uv');
  const hx = 0.54, hz = 0.46, y0 = 0.58, y1 = 0.98;
  const v = [
    // two slopes
    -hx, y0, -hz, hx, y0, -hz, hx, y1, 0, -hx, y0, -hz, hx, y1, 0, -hx, y1, 0,
    hx, y0, hz, -hx, y0, hz, -hx, y1, 0, hx, y0, hz, -hx, y1, 0, hx, y1, 0,
    // gable ends
    -0.5, y0, hz - 0.06, -0.5, y0, -hz + 0.06, -0.5, y1 - 0.02, 0,
    0.5, y0, -hz + 0.06, 0.5, y0, hz - 0.06, 0.5, y1 - 0.02, 0,
  ];
  const roof = new THREE.BufferGeometry();
  roof.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  roof.computeVertexNormals();
  const paint = (g, c, from = 0, to = Infinity, c2) => {
    const col = new THREE.Color(c), col2 = new THREE.Color(c2 ?? c);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const k = i >= from && i < to ? col : col2; arr[i * 3] = k.r; arr[i * 3 + 1] = k.g; arr[i * 3 + 2] = k.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  };
  return mergeGeometries([paint(walls, 0x9c5d47), paint(roof, 0x8e4532, 0, 12, 0x9c5d47)]);
}

export function buildNeighbourhood({ seed = 7 } = {}) {
  const { M } = nbAssets();
  const R = nbRng(seed);
  const group = new THREE.Group();
  group.name = 'neighbourhood';
  const B = new NbBuckets();
  const treeSpots = [], shrubSpots = [], hedgeRuns = [], carSpots = [];
  const clearOfOrbit = (x, z, r = 24) => Math.hypot(x, z) > r;

  /* ---------- Ground: a large subdivided disc with slow colour variation ---------- */
  {
    const size = 4000, seg = 120;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    const col = new Float32Array(pos.count * 3);
    const N = (x, z) => Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.009 - 0.7) + 0.5 * Math.sin(x * 0.027 + z * 0.021) + 0.3 * Math.sin((x - z) * 0.05);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), r = Math.hypot(x, z);
      const far = Math.min(1, Math.max(0, (r - 120) / 300));
      const n = N(x, z);
      const field = Math.floor((x + 3000) / 180) * 31 + Math.floor((z + 3000) / 140) * 17;
      const f = ((Math.sin(field * 12.9898) * 43758.5453) % 1 + 1) % 1;
      let cr = 1, cg = 1, cb = 1;
      cr += 0.08 * n; cg += 0.06 * n;
      if (f > 0.72) { cr += 0.45 * far; cg += 0.18 * far; cb -= 0.1 * far; }
      else if (f < 0.25) { cr -= 0.08 * far; cg -= 0.12 * far; }
      col[i * 3] = cr; col[i * 3 + 1] = cg; col[i * 3 + 2] = cb;
      uv.setXY(i, x / 3, z / 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const ground = new THREE.Mesh(geo, M.grass);
    ground.receiveShadow = true;
    ground.name = 'nb-ground';
    group.add(ground);
  }

  /* ---------- Our plot ---------- */
  {
    const lawnGeo = nbPlane(20, 33, 1.8, 1.8);
    lawnGeo.rotateX(-Math.PI / 2);
    const lawnMesh = new THREE.Mesh(nbXf(lawnGeo, -1, 0.006, -0.5), M.lawn);
    lawnMesh.receiveShadow = true; lawnMesh.name = 'nb-lawn';
    group.add(lawnMesh);
    // Driveway: herringbone concrete pavers with a darker border, a few cm above the lawn.
    B.put('herring', nbXf(nbBox(3.4, 0.05, 12.4, 2, 2), 3.5, 0.025, -10.8));
    B.put('dark', nbXf(nbBox(0.1, 0.06, 12.4), 1.8, 0.03, -10.8));
    B.put('dark', nbXf(nbBox(0.1, 0.06, 12.4), 5.2, 0.03, -10.8));
    // Doorstep and a strip of tiles along the front facade.
    B.put('terrace', nbXf(nbBox(1.6, 0.12, 0.7, 1.2, 1.2), 2.9, 0.06, -4.4));
    B.put('terrace', nbXf(nbBox(10.4, 0.05, 0.5, 1.2, 1.2), 0, 0.025, -4.3));
    // Back terrace in large tiles.
    B.put('terrace', nbXf(nbBox(6.5, 0.05, 3.9, 2.4, 2.4), -0.75, 0.025, 6.55));
    // Shed (tuinhuis) in dark stained wood with a mono-pitch roof.
    B.put('wood', nbXf(nbBox(2.5, 2.2, 2.5, 1.2, 1.2), -8.5, 1.1, 13.5, 0, Math.PI / 2, 0));
    B.put('dark', nbXf(nbBox(2.9, 0.1, 2.9), -8.5, 2.3, 13.5, 0.08, 0, 0));
    B.put('door', nbXf(nbPlane(0.9, 1.9), -8.5, 0.95, 12.24, 0, Math.PI, 0));
    // Fences (schutting) around the back garden: posts every 1.8 m, boards between.
    const fence = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0), ry = Math.atan2(-(z1 - z0), x1 - x0);
      const n = Math.max(1, Math.round(len / 1.8));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        B.put('dark', nbXf(nbBox(0.09, 1.9, 0.09), x0 + (x1 - x0) * t, 0.95, z0 + (z1 - z0) * t, 0, ry, 0));
      }
      B.put('wood', nbXf(nbBox(len, 1.8, 0.03, 1.2, 1.2), (x0 + x1) / 2, 0.9, (z0 + z1) / 2, 0, ry, 0));
    };
    fence(-11, 0, -11, 16); fence(9, 0, 9, 16); fence(-11, 16, 9, 16);
    // Hedges, trees, shrubs and the car are built by the other kits.
    hedgeRuns.push({ x: -4.75, z: -17, length: 12.4, height: 1.0, depth: 0.6, rotationY: 0, seed: 2 });
    hedgeRuns.push({ x: -11, z: -8.5, length: 16.4, height: 1.0, depth: 0.6, rotationY: Math.PI / 2, seed: 3 });
    hedgeRuns.push({ x: 7.6, z: -17, length: 2.6, height: 1.0, depth: 0.6, rotationY: 0, seed: 4 });
    hedgeRuns.push({ x: 9, z: -8.5, length: 16.4, height: 1.0, depth: 0.6, rotationY: Math.PI / 2, seed: 5 });
    treeSpots.push({ x: -8.5, z: 9, height: 7.5, seed: 11, kind: 'oak', detail: 'hero' });
    treeSpots.push({ x: 7.2, z: -14, height: 6.5, seed: 12, kind: 'birch', detail: 'hero' });
    const shrubs = [
      [-4.4, -5.3, 0.55, 0.8, 'boxwood'], [-1.8, -5.3, 0.55, 0.8, 'hydrangea'], [0.8, -5.3, 0.5, 0.7, 'boxwood'],
      [-5.9, -4.7, 0.7, 1.1, 'hydrangea'], [6.2, -4.6, 0.6, 0.9, 'boxwood'], [6.4, 3.4, 0.8, 1.1, 'hydrangea'],
      [-6.6, 2.4, 0.6, 0.9, 'grass'], [-10.2, 5.5, 0.7, 1.1, 'boxwood'], [8.1, 8.5, 0.7, 1.0, 'hydrangea'],
      [8.0, 13.5, 0.8, 1.2, 'boxwood'], [3.5, 15.0, 0.7, 1.0, 'grass'], [-3.5, 15.0, 0.6, 0.9, 'hydrangea'],
    ];
    shrubs.forEach(([x, z, r, hh, kind], i) => shrubSpots.push({ x, z, radius: r, height: hh, seed: 20 + i, kind }));
    carSpots.push({ x: 3.5, z: -10.5, yaw: Math.PI, color: 0x2d4f7c, style: 'estate', plate: 'K-482-RV', seed: 1 });
  }

  /* ---------- Street along x (centre z = -22), cross street along z (centre x = 46) ---------- */
  {
    const W = 260;
    const road = (len, cx, cz, rotY) => {
      const p = new THREE.Matrix4().compose(new THREE.Vector3(cx, 0, cz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0)), new THREE.Vector3(1, 1, 1));
      B.put('asphalt', nbXf(nbBox(len, 0.04, 4.9, 4, 4), 0, 0.02, 0), p);
      for (const s of [-1, 1]) {
        B.put('gutter', nbXf(nbBox(len, 0.045, 0.3, 1.2, 1.2), 0, 0.022, s * 2.6), p);
        B.put('kerb', nbXf(nbBox(len, 0.14, 0.12), 0, 0.07, s * 2.81), p);
        B.put('tiles', nbXf(nbBox(len, 0.11, 2.0, 1.2, 1.2), 0, 0.055, s * 3.87), p);
      }
    };
    road(W, 0, -22, 0);
    road(150, 46, -22 + 75 + 2.75 + 2.0, Math.PI / 2);
    // Kerb-to-kerb crossing at the junction keeps the asphalt continuous.
    B.put('asphalt', nbXf(nbBox(9.8, 0.04, 9.8, 4, 4), 46, 0.021, -22));
    // Street lamps on the north pavement, all outside the drone's orbit.
    const lampXs = [-120, -95, -70, -45, -20, 20, 37, 70, 95, 120];
    const lampGeo = (() => {
      const pole = new THREE.CylinderGeometry(0.05, 0.07, 6, 8).toNonIndexed(); pole.translate(0, 3, 0);
      const arm = new THREE.BoxGeometry(0.08, 0.06, 0.9).toNonIndexed(); arm.translate(0, 5.95, 0.42);
      const head = new THREE.BoxGeometry(0.22, 0.08, 0.5).toNonIndexed(); head.translate(0, 5.9, 0.85);
      return mergeGeometries([pole, arm, head].map((g) => { g.deleteAttribute('uv'); return g; }));
    })();
    const lamps = new THREE.InstancedMesh(lampGeo, M.lamp, lampXs.length);
    lampXs.forEach((x, i) => {
      nbM4.compose(new THREE.Vector3(x, 0.11, -18.1), nbQ.setFromEuler(nbE.set(0, 0, 0)), nbS);
      lamps.setMatrixAt(i, nbM4);
    });
    lamps.castShadow = true; lamps.name = 'nb-lamps';
    group.add(lamps);
    // Detailed street trees near the house; farther ones are part of the cheap instanced trees below.
    for (const x of [-37.5, -22.5, -7.5, 7.5, 22.5, 37.5]) treeSpots.push({ x, z: -25.9, height: 9 + R() * 1.5, seed: 40 + Math.round(x), kind: 'linden', detail: 'street' });
    carSpots.push({ x: -15.5, z: -23.9, yaw: Math.PI / 2, color: 0xe8e8e6, style: 'hatchback', plate: 'S-114-XN', seed: 2 });
    carSpots.push({ x: 18.5, z: -20.1, yaw: -Math.PI / 2, color: 0x3a3d42, style: 'suv', plate: 'G-907-HT', seed: 3 });
  }

  /* ---------- Neighbour houses ---------- */
  const bricks = ['brick0', 'brick1', 'brick2'];
  const roofs = ['roof0', 'roof1'];
  const cheapTrees = [];
  {
    // Same street, front facades towards the street (-z).
    const row = [-102, -84, -66, -48, -30, 30, 62, 80, 98];
    row.forEach((x, i) => {
      const type = i % 3;
      const o = { x, z: -1.5, R, brick: bricks[(i * 2 + 1) % 3], roof: roofs[(i + 1) % 2], pitch: 0.75 + R() * 0.12, chimney: R() < 0.5, dormer: R() < 0.55, panels: R() < 0.5 };
      if (type === 0) Object.assign(o, { w: 10, d: 9, h: 5.8 });
      if (type === 1) Object.assign(o, { w: 9, d: 10.5, h: 5.6, rotY: Math.PI / 2, dormer: false });
      if (type === 2) Object.assign(o, { w: 12.5, d: 9, h: 6.0 });
      nbHouse(B, o);
      // Front garden: driveway, low hedge, a garden tree behind the house.
      const side = R() < 0.5 ? -1 : 1;
      B.put('herring', nbXf(nbBox(3.0, 0.05, 11.5, 2, 2), x + side * (o.w / 2 + 1.0 - (type === 1 ? 1 : 0)), 0.025, -11.6));
      B.put('hedge', nbXf(nbBox(9, 0.9, 0.6, 3, 3), x - side * 3, 0.45, -16.9));
      cheapTrees.push({ x: x + (R() - 0.5) * 8, z: 9 + R() * 6, h: 6 + R() * 4 });
    });
    // Back neighbours: semi-detached pairs facing away from us; their back gardens and fence face our garden.
    for (const x of [-60, -38, -16, 6, 28, 64, 86]) {
      const o = { x, z: 33.5, R, w: 12, d: 9, h: 5.9, rotY: Math.PI, pitch: 0.78, brick: bricks[Math.floor(R() * 3)], roof: roofs[Math.floor(R() * 2)], dormer: R() < 0.6, panels: R() < 0.4, chimney: R() < 0.4 };
      nbHouse(B, o);
      cheapTrees.push({ x: x + (R() - 0.5) * 10, z: 25 + R() * 2, h: 5 + R() * 3 });
    }
    // Their back fence along z = 24.5 with posts.
    B.put('wood', nbXf(nbBox(170, 1.8, 0.03, 1.2, 1.2), 10, 0.9, 24.5));
    // Across the street: two terraces (rijtjeshuizen), front facades towards the street (+z).
    for (const [x0, units] of [[-44, 7], [6, 6]]) {
      const w = units * 5.6;
      nbHouse(B, { x: x0 + w / 2, z: -37, R, w, d: 9.5, h: 5.9, rotY: Math.PI, pitch: 0.79, brick: x0 < 0 ? 'brick1' : 'brick0', roof: x0 < 0 ? 'roof1' : 'roof0', dormer: false, panels: false, chimney: false, doorSlot: -1 });
      for (let u = 0; u < units; u++) {
        const ux = x0 + 2.8 + u * 5.6;
        // Doors and front windows per unit (front is +z after the 180 degree turn).
        B.put('door', nbXf(nbPlane(1.0, 2.2), ux - 1.6, 1.5, -37 + 4.77, 0, 0, 0));
        if (R() < 0.6) {
          const dzF = -37 + 4.75 - 1.0, dy = 5.9 + 1.0 * Math.tan(0.79);
          B.put('trim', nbXf(nbBox(2.6, 1.5, 1.9), ux, dy + 0.55, dzF - 0.95));
          B.put('window', nbXf(nbPlane(2.0, 1.0), ux, dy + 0.62, dzF + 0.005));
          B.put('dark', nbXf(nbBox(2.8, 0.12, 2.1), ux, dy + 1.38, dzF - 0.95));
        }
        B.put('hedge', nbXf(nbBox(2.2, 0.8, 0.5, 3, 3), ux + 1.2, 0.4, -29.4));
        B.put('tiles', nbXf(nbBox(1.4, 0.05, 3.4, 1.2, 1.2), ux - 1.6, 0.025, -30.6));
      }
    }
  }

  /* ---------- Far residential blocks (instanced low-poly houses) ---------- */
  {
    const spots = [];
    for (let i = 0; i < 2600 && spots.length < 340; i++) {
      const a = R() * Math.PI * 2, r = 70 + R() * 380;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(z + 22) < 16 && Math.abs(x) < 130) continue;     // our street and its rows
      if (z > 18 && z < 48 && Math.abs(x) < 100) continue;           // back neighbours
      if (Math.abs(x - 46) < 10 && z < 60) continue;                 // cross street
      const ang = Math.atan2(z, x);
      if (r > 140 && ang > 0.15 && ang < 1.75) continue;             // forest sector
      // Align to a loose street grid so blocks read as neighbourhoods.
      const gx = Math.round(x / 16) * 16, gz = Math.round(z / 12) * 12;
      if (spots.some((s) => Math.abs(s.x - gx) < 9 && Math.abs(s.z - gz) < 7)) continue;
      spots.push({ x: gx + (R() - 0.5) * 2, z: gz, s: 9 + R() * 4, rot: R() < 0.8 ? 0 : Math.PI / 2 });
    }
    const mini = new THREE.InstancedMesh(nbMiniHouse(), M.mini, spots.length);
    const tint = new THREE.Color();
    spots.forEach((s, i) => {
      nbM4.compose(new THREE.Vector3(s.x, 0, s.z), nbQ.setFromEuler(nbE.set(0, s.rot, 0)), new THREE.Vector3(s.s, s.s * 0.95, s.s * 0.9));
      mini.setMatrixAt(i, nbM4);
      const k = R();
      if (k < 0.3) mini.setColorAt(i, tint.setRGB(0.55, 0.56, 0.6));
      else if (k < 0.5) mini.setColorAt(i, tint.setRGB(1.25, 1.12, 0.95));
      else mini.setColorAt(i, tint.setRGB(0.95 + R() * 0.1, 0.95, 0.95));
      if (R() < 0.5) cheapTrees.push({ x: s.x + (R() - 0.5) * 12, z: s.z + 6 + R() * 3, h: 6 + R() * 5 });
    });
    mini.castShadow = false; mini.receiveShadow = true; mini.name = 'nb-far-houses';
    group.add(mini);
  }

  /* ---------- Trees: neighbours' gardens, far blocks, street (far part) and a forest to the north-east ---------- */
  {
    for (let x = -112.5; x <= 112.5; x += 15) if (Math.abs(x) > 40) cheapTrees.push({ x, z: -25.9, h: 9 + R() * 1.5 });
    const pines = [];
    for (let i = 0; i < 1100; i++) {
      const a = 0.2 + R() * 1.5, r = 150 + Math.pow(R(), 0.7) * 230;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (R() < 0.28) pines.push({ x, z, h: 14 + R() * 10 });
      else cheapTrees.push({ x, z, h: 12 + R() * 9 });
    }
    const crownGeo = (() => {
      const g = new THREE.IcosahedronGeometry(1, 1);
      const p = g.attributes.position, rr = nbRng(99);
      for (let i = 0; i < p.count; i++) { const k = 0.85 + rr() * 0.3; p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.9, p.getZ(i) * k); }
      g.computeVertexNormals();
      return g;
    })();
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1, 5); trunkGeo.translate(0, 0.5, 0);
    const pineGeo = (() => {
      const a = new THREE.ConeGeometry(1, 1.4, 8).toNonIndexed(); a.translate(0, 0.9, 0);
      const b = new THREE.ConeGeometry(0.75, 1.1, 8).toNonIndexed(); b.translate(0, 1.55, 0);
      return mergeGeometries([a, b]);
    })();
    const trees = cheapTrees.filter((t) => clearOfOrbit(t.x, t.z, 26));
    const crowns = new THREE.InstancedMesh(crownGeo, M.crown, trees.length);
    const trunks = new THREE.InstancedMesh(trunkGeo, M.trunk, trees.length + pines.length);
    const col = new THREE.Color();
    trees.forEach((t, i) => {
      const cr = t.h * 0.33;
      nbM4.compose(new THREE.Vector3(t.x, t.h - cr * 0.95, t.z), nbQ.setFromEuler(nbE.set(0, R() * 6.28, 0)), new THREE.Vector3(cr, cr * 1.05, cr));
      crowns.setMatrixAt(i, nbM4);
      col.setHSL(0.24 + R() * 0.06, 0.38 + R() * 0.15, 0.27 + R() * 0.08, THREE.SRGBColorSpace);
      crowns.setColorAt(i, col);
      nbM4.compose(new THREE.Vector3(t.x, 0, t.z), nbQ.identity(), new THREE.Vector3(t.h * 0.06 / 0.15, t.h - cr * 1.4, t.h * 0.06 / 0.15));
      trunks.setMatrixAt(i, nbM4);
    });
    const pineMesh = new THREE.InstancedMesh(pineGeo, M.pine, pines.length);
    pines.forEach((t, i) => {
      const s = t.h / 2.1;
      nbM4.compose(new THREE.Vector3(t.x, t.h * 0.12, t.z), nbQ.setFromEuler(nbE.set(0, R() * 6.28, 0)), new THREE.Vector3(s * 0.32, s, s * 0.32));
      pineMesh.setMatrixAt(i, nbM4);
      col.setHSL(0.33 + R() * 0.04, 0.3 + R() * 0.12, 0.17 + R() * 0.06, THREE.SRGBColorSpace);
      pineMesh.setColorAt(i, col);
      nbM4.compose(new THREE.Vector3(t.x, 0, t.z), nbQ.identity(), new THREE.Vector3(2.4, t.h * 0.25, 2.4));
      trunks.setMatrixAt(trees.length + i, nbM4);
    });
    for (const m of [crowns, trunks, pineMesh]) {
      m.castShadow = true; m.receiveShadow = true;
      group.add(m);
    }
    crowns.name = 'nb-tree-crowns'; trunks.name = 'nb-tree-trunks'; pineMesh.name = 'nb-pines';
  }

  /* ---------- City skyline to the north-west, and a few apartment slabs nearer by ---------- */
  {
    const dir = Math.atan2(0.6, -0.8);
    const towers = [];
    for (let i = 0; i < 22; i++) {
      const a = dir + (R() - 0.5) * 0.42, r = 620 + R() * 380;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = 25 + Math.pow(R(), 1.6) * 90, w = 16 + R() * 18, d = 16 + R() * 14;
      const key = ['tower0', 'tower1', 'tower2'][Math.floor(R() * 3)];
      towers.push({ x, z, h, w, d, key });
    }
    towers.sort((a, b) => b.h - a.h);
    towers[0].h = 120; towers[0].spire = true; towers[1].h = 95; towers[1].setback = true;
    for (const t of towers) {
      B.put(t.key, nbXf(nbBox(t.w, t.h, t.d, 12, 12), t.x, t.h / 2, t.z, 0, R() * 0.6, 0));
      if (t.setback) B.put(t.key, nbXf(nbBox(t.w * 0.65, 22, t.d * 0.65, 12, 12), t.x, t.h + 11, t.z));
      if (t.spire) B.put('lamp', nbXf(new THREE.CylinderGeometry(0.4, 1.2, 26, 6), t.x, t.h + 13, t.z));
    }
    for (let i = 0; i < 9; i++) {
      const a = R() * Math.PI * 2, r = 300 + R() * 220;
      if (Math.abs(a - 0.95) < 0.8) continue;
      const x = Math.cos(a) * r, z = Math.sin(a) * r, h = 14 + R() * 16;
      B.put('tower1', nbXf(nbBox(58 + R() * 30, h, 12, 12, 12), x, h / 2, z, 0, R() * 3.14, 0));
    }
  }

  B.build(group, M, {
    tower0: { cast: false }, tower1: { cast: false }, tower2: { cast: false },
    asphalt: { cast: false }, tiles: { cast: false }, gutter: { cast: false }, herring: { cast: false }, terrace: { cast: false },
    window: { cast: false }, door: { cast: false },
  });
  return { group, treeSpots, shrubSpots, hedgeRuns, carSpots };
}
