// Render pipeline used by the preview: physical sky, image-based lighting from that sky,
// soft PCF sun shadows, and (quality 'high') GTAO ambient occlusion through an MSAA composer.
// Objects with userData.noAO = true are skipped by the AO pass (alpha-cut foliage, decals, glass).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const SUN_DIR = new THREE.Vector3(-0.5, 0.74, -0.45).normalize();

/* Art-directed sky dome: gradient, sun glow and soft fbm clouds. Its horizon colour is also the fog colour,
   so distant geometry melts into the sky without a seam. */
export function makeSky(L) {
  const uniforms = {
    sunDir: { value: SUN_DIR.clone() },
    zenith: { value: new THREE.Color(L.zenith) },
    horizon: { value: new THREE.Color(L.horizon) },
    groundCol: { value: new THREE.Color(L.horizon).multiplyScalar(0.92) },
    cloudAmt: { value: L.clouds },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        gl_Position.z = gl_Position.w;
      }`,
    fragmentShader: `
      uniform vec3 sunDir; uniform vec3 zenith; uniform vec3 horizon; uniform vec3 groundCol; uniform float cloudAmt;
      varying vec3 vWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 6; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
        return v;
      }
      void main() {
        vec3 d = normalize(vWorld - cameraPosition);
        float h = d.y;
        vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.48));
        col = mix(col, groundCol, smoothstep(0.0, -0.06, h));
        float s = max(dot(d, normalize(sunDir)), 0.0);
        col += vec3(1.0, 0.93, 0.8) * (pow(s, 900.0) * 30.0 + pow(s, 24.0) * 0.35 + pow(s, 4.0) * 0.06);
        if (h > 0.0) {
          vec2 uv = d.xz / (h + 0.12) * 1.1;
          float c = fbm(uv * 1.4 + vec2(4.0, 11.0));
          float detail = fbm(uv * 4.0 + vec2(-2.0, 3.0));
          float cov = smoothstep(0.62 - cloudAmt * 0.25, 0.86, c + detail * 0.12) * smoothstep(0.0, 0.18, h);
          float lit = 0.82 + 0.18 * smoothstep(0.3, 0.9, detail) + pow(s, 6.0) * 0.25;
          vec3 cloud = mix(horizon * 1.05, vec3(1.0, 0.99, 0.97), 0.7) * lit;
          col = mix(col, cloud, cov * 0.9);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(3000, 48, 24), mat);
  mesh.userData.noAO = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

export const LOOK = { exposure: 1.0, sun: 3.2, env: 0.8, hemi: 0.2, zenith: 0x2f6fc0, horizon: 0xbfd6ea, clouds: 0.5, fog: 0.0022 };

export function createStage({ canvas, quality = 'high', look = {} }) {
  const high = quality === 'high';
  const L = { ...LOOK, ...look };
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, high ? 2 : 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = L.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 4000);

  const sky = makeSky(L);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky);
  const envRT = pmrem.fromScene(envScene, 0.035);
  scene.add(sky);
  scene.environment = envRT.texture;
  scene.environmentIntensity = L.env;
  scene.fog = new THREE.FogExp2(new THREE.Color(L.horizon), L.fog);

  const hemi = new THREE.HemisphereLight(0xd6e6ff, 0x55623f, L.hemi);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d8, L.sun);
  sun.position.copy(SUN_DIR).multiplyScalar(90);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(high ? 4096 : 2048);
  Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 20, far: 190 });
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  let composer = null, gtao = null;
  if (high) {
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    gtao = new GTAOPass(scene, camera, 4, 4);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 0.9;
    gtao.updateGtaoMaterial({ radius: 0.85, distanceExponent: 1.6, thickness: 1.2, scale: 1.0, samples: 16, distanceFallOff: 1.0, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, radiusExponent: 1, rings: 2, samples: 16 });
    const baseOverride = gtao.overrideVisibility.bind(gtao);
    gtao.overrideVisibility = function () {
      baseOverride();
      this.scene.traverse((o) => { if (o.userData && o.userData.noAO) o.visible = false; });
    };
    composer.addPass(gtao);
    composer.addPass(new OutputPass());
  }

  function setSize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    }
  }
  let aoOn = !!composer;
  function render() {
    if (aoOn) composer.render();
    else renderer.render(scene, camera);
  }
  const api = { renderer, scene, camera, sun, sky, composer, gtao, setSize, render, high };
  api.setAO = (on) => { aoOn = !!composer && on; api.high = aoOn; };
  return api;
}
