// Usage: node tools/shoot.mjs <outDir> <jobs.json> [page.html]   (default page: dist/dakscan-voorbeeld.html)
// jobs: [{name, width, height, scheme:'light'|'dark', tab:'klant'|'mail'|'werkwijze', actions:[{seek:t}|{mode:'explore'}|{focus:'v1'}|{scene:'na'}|{wait:ms}|{click:'#sel'}|{scroll:y}], fullPage:bool, clip:'viewer'|null}]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const [,, outDir, jobsFile, htmlFile] = process.argv;
const html = fs.readFileSync(htmlFile || path.join(here, '../dist/dakscan-voorbeeld.html'), 'utf8');
const skeleton = /^\s*<!doctype/i.test(html) ? html : `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui;background:#fafafa}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${html}</body></html>`;
const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = [];
for (const job of jobs) {
  const ctx = await browser.newContext({ viewport: { width: job.width || 1280, height: job.height || 900 }, colorScheme: job.scheme || 'light', deviceScaleFactor: job.dpr || 1, isMobile: !!job.mobile, hasTouch: !!job.mobile });
  const page = await ctx.newPage();
  if (job.init) await page.addInitScript(job.init);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('http://preview.test/')) return route.fulfill({ status: 200, contentType: 'text/html', body: skeleton });
    const m = url.match(/cdn\.jsdelivr\.net\/npm\/three@0\.170\.0\/(.*)$/);
    if (m) {
      const f = path.join(here, '../node_modules/three', m[1]);
      if (fs.existsSync(f)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) });
      return route.fulfill({ status: 404, body: 'nf' });
    }
    return route.abort(); // fonts etc. blocked offline; fallback stacks apply
  });
  const t0 = Date.now();
  await page.goto('http://preview.test/' + (job.tab ? '#' + job.tab : ''));
  await page.waitForFunction(() => window.__previewReady === true, null, { timeout: 30000 }).catch(() => errors.push('previewReady timeout'));
  const readyMs = Date.now() - t0;
  await page.waitForTimeout(400);
  for (const a of job.actions || []) {
    if (a.seek !== undefined) await page.evaluate((t) => window.__preview.seek(t), a.seek);
    if (a.mode) await page.evaluate((m) => window.__preview.setMode(m), a.mode);
    if (a.focus) await page.evaluate((id) => window.__preview.focus(id), a.focus);
    if (a.scene) await page.evaluate((s) => window.__preview.setScene(s), a.scene);
    if (a.click) await page.click(a.click);
    if (a.scroll !== undefined) await page.evaluate((y) => window.scrollTo(0, y), a.scroll);
    if (a.wait) await page.waitForTimeout(a.wait);
    if (a.eval) report.push({ name: job.name, eval: a.eval, result: await page.evaluate(a.eval) });
  }
  await page.waitForTimeout(job.settle ?? 350);
  const file = path.join(outDir, `${job.name}.png`);
  try {
    const sel = job.clip === 'viewer' ? '#viewer' : job.clip;
    if (sel) {
      const box = await page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; }, sel);
      await page.screenshot({ path: file, clip: box, fullPage: true, timeout: 180000 });
    } else await page.screenshot({ path: file, fullPage: !!job.fullPage, timeout: 180000 });
  } catch (e) { errors.push('screenshot: ' + e.message.split('\n')[0]); }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  report.push({ name: job.name, file, readyMs, overflowX: overflow, errors });
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 2));
