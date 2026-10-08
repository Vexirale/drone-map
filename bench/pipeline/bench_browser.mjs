// Load a GLB in headless Chromium (SwiftShader) with three.js 0.170.0 GLTFLoader + MeshoptDecoder.
// usage: node bench_browser.mjs <file.glb> [--throttle-mbps 20] [--shot out.png]
// Prints JSON: download size, load (fetch+parse+decode) time, first frame, est GPU texture memory,
// peak summed PSS of all Chromium processes (sampled every 100 ms).
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const require = createRequire(path.join(ROOT, 'node', 'package.json'));
const { chromium } = require('playwright-core');

const args = process.argv.slice(2);
const glb = path.resolve(args[0]);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const mbps = +opt('--throttle-mbps', 0);
const shot = opt('--shot', null);
const [VW, VH] = opt('--size', '1280x720').split('x').map(Number);

const THREE_DIR = path.join(ROOT, 'node', 'node_modules', 'three');
const types = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let f;
  if (u === '/' || u === '/viewer.html') f = path.join(HERE, 'viewer.html');
  else if (u.startsWith('/three/')) f = path.join(THREE_DIR, u.slice(7));
  else if (u === '/model.glb') f = glb;
  else { res.writeHead(404); return res.end(); }
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const st = fs.statSync(f);
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });

// memory sampler: sum PSS over all chrome processes
function chromePids() {
  try { return execSync(`pgrep -f chromium-1194`).toString().trim().split('\n').filter(Boolean).map(Number); } catch { return []; }
}
function pssMB() {
  let kb = 0;
  for (const pid of chromePids()) {
    try { const m = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m); if (m) kb += +m[1]; } catch {}
  }
  return kb / 1024;
}
let peak = 0; const baseline = pssMB();
const timer = setInterval(() => { peak = Math.max(peak, pssMB()); }, 100);

const page = await browser.newPage({ viewport: { width: VW, height: VH } });
const consoleLines = [];
page.on('console', m => consoleLines.push(m.text()));
page.on('pageerror', e => consoleLines.push('pageerror ' + e.message));
if (mbps > 0) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: mbps * 1e6 / 8, uploadThroughput: 5e6 / 8 });
}
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/viewer.html?m=/model.glb&w=${VW}&h=${VH}`);
await page.waitForFunction(() => window.__result, null, { timeout: 30 * 60 * 1000, polling: 200 });
const result = await page.evaluate(() => window.__result);
result.wallMs = Date.now() - t0;
if (shot) await page.screenshot({ path: shot });
clearInterval(timer);
peak = Math.max(peak, pssMB());
result.fileMB = fs.statSync(glb).size / 1048576;
result.chromePssPeakMB = Math.round(peak);
result.chromePssBaselineMB = Math.round(baseline);
result.throttleMbps = mbps || null;
if (consoleLines.length) result.console = consoleLines.slice(0, 10);
await browser.close();
server.close();
console.log(JSON.stringify(result, null, 1));
