// Usage: node shoot-asset.mjs <outDir> <jobs.json>
// Job: {name, width=1280, height=720, quality:'high'|'low', ground:true, camera:{pos:[x,y,z], target:[x,y,z], fov:38},
//       modules:[{file:'trees.js', export:'buildTree', args:{...}, position:[x,y,z], rotationY:0, scale:1}], shadowCenter:[x,z]}
// The export is called as fn(args) and may return an Object3D or {group: Object3D, ...}. Files are read from src/assets/.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const assetsDir = path.join(here, '../src/assets');
const [,, outDir, jobsFile] = process.argv;
const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
const page = (job) => `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
<style>html,body{margin:0;background:#000}canvas{display:block;width:${job.width || 1280}px;height:${job.height || 720}px}</style></head><body><canvas id="c"></canvas>
<script type="module">
import * as THREE from 'three';
import { createStage } from 'http://preview.test/tools/stage.js';
const job = ${JSON.stringify(job)};
try {
  const st = createStage({ canvas: document.getElementById('c'), quality: job.quality || 'high', look: job.look || {} });
  st.setSize(job.width || 1280, job.height || 720);
  if (job.ground !== false) {
    const g = new THREE.Mesh(new THREE.CircleGeometry(400, 64), new THREE.MeshStandardMaterial({ color: 0x5d7f45, roughness: 1 }));
    g.rotation.x = -Math.PI / 2; g.receiveShadow = true; st.scene.add(g);
  }
  if (job.shadowCenter) { st.sun.target.position.set(job.shadowCenter[0], 0, job.shadowCenter[1]); st.sun.position.copy(st.sun.target.position).addScaledVector(new THREE.Vector3(-0.5,0.74,-0.45).normalize(), 90); }
  for (const m of job.modules || []) {
    const mod = await import('http://preview.test/assets/' + m.file + '?v=' + Date.now());
    let out = await mod[m.export](m.args || {});
    const obj = out && out.isObject3D ? out : out.group;
    if (m.position) obj.position.set(...m.position);
    if (m.rotationY) obj.rotation.y = m.rotationY;
    if (m.scale) obj.scale.setScalar(m.scale);
    st.scene.add(obj);
  }
  const c = job.camera || { pos: [8, 5, 10], target: [0, 2, 0], fov: 38 };
  st.camera.fov = c.fov || 38; st.camera.position.set(...c.pos); st.camera.lookAt(new THREE.Vector3(...c.target)); st.camera.updateProjectionMatrix();
  st.renderer.info.autoReset = false; st.renderer.info.reset();
  st.renderer.render(st.scene, st.camera);
  window.__stats = { triangles: st.renderer.info.render.triangles, calls: st.renderer.info.render.calls, geometries: st.renderer.info.memory.geometries, textures: st.renderer.info.memory.textures };
  st.renderer.info.autoReset = true;
  st.render(); st.render();
  window.__done = true;
} catch (e) { window.__err = String(e && e.stack || e); window.__done = true; }
</script></body></html>`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = [];
for (const job of jobs) {
  const ctx = await browser.newContext({ viewport: { width: job.width || 1280, height: job.height || 720 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await p.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('http://preview.test/page')) return route.fulfill({ status: 200, contentType: 'text/html', body: page(job) });
    if (url.startsWith('http://preview.test/tools/')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(here, '../src', url.split('/tools/')[1].split('?')[0])) });
    if (url.startsWith('http://preview.test/assets/')) {
      const f = path.join(assetsDir, url.split('/assets/')[1].split('?')[0]);
      if (fs.existsSync(f)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) });
      return route.fulfill({ status: 404, body: 'not found' });
    }
    const m = url.match(/cdn\.jsdelivr\.net\/npm\/three@0\.170\.0\/(.*)$/);
    if (m) { const f = path.join(here, '../node_modules/three', m[1]); if (fs.existsSync(f)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) }); }
    return route.abort();
  });
  const t0 = Date.now();
  await p.goto('http://preview.test/page');
  await p.waitForFunction(() => window.__done === true, null, { timeout: 120000 }).catch(() => errors.push('timeout'));
  const ms = Date.now() - t0;
  const err = await p.evaluate(() => window.__err || null);
  if (err) errors.push(err);
  const stats = await p.evaluate(() => window.__stats || null);
  const file = path.join(outDir, job.name + '.png');
  await p.screenshot({ path: file });
  report.push({ name: job.name, file, ms, stats, errors });
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 2));
