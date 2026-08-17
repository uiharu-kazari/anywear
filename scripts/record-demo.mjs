// Records the full Anywear demo flow as a webm + events.json timing log.
// Usage: node scripts/record-demo.mjs [outDir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ?? '/tmp/anywear-demo';
fs.mkdirSync(OUT, { recursive: true });

const APP = 'http://localhost:5199';
const events = [];
let t0 = 0;
const mark = (name) => {
  events.push({ name, t: (Date.now() - t0) / 1000 });
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${name}`);
};

const CURSOR_JS = `
(() => {
  if (window.__cursorInstalled) return; window.__cursorInstalled = true;
  const d = document.createElement('div');
  d.id = '__cursor';
  d.style.cssText = 'position:fixed;z-index:99999;width:26px;height:26px;border-radius:50%;border:2.5px solid #4C6349;background:rgba(76,99,73,0.18);pointer-events:none;transform:translate(-50%,-50%);transition:width .12s,height .12s;left:-50px;top:-50px;box-shadow:0 1px 6px rgba(0,0,0,0.25)';
  const attach = () => document.body && document.body.appendChild(d);
  document.body ? attach() : addEventListener('DOMContentLoaded', attach);
  addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => { d.style.width = '18px'; d.style.height = '18px'; }, true);
  addEventListener('mouseup', () => { d.style.width = '26px'; d.style.height = '26px'; }, true);
})();`;

async function moveClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('no box for locator');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
  await page.waitForTimeout(350);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
});
const page = await ctx.newPage();
await page.addInitScript(CURSOR_JS);

page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 200)));
process.on('uncaughtException', async (e) => {
  console.log('FATAL:', String(e).slice(0, 300));
  try { await page.screenshot({ path: OUT + '/failure.png' }); } catch {}
  try { await ctx.close(); } catch {}
  process.exit(1);
});
t0 = Date.now();
await page.goto(APP);
await page.waitForLoadState('networkidle');
mark('welcome');
await page.waitForTimeout(2600);

// Enter with demo persona
await moveClick(page, page.getByRole('button', { name: 'Step in with the demo persona' }));
await page.waitForSelector('text=Drop any', { timeout: 30000 });
mark('studio');
await page.waitForTimeout(2200);

// Skin analysis
await moveClick(page, page.getByRole('button', { name: 'Read my skin' }));
mark('skin_start');
await page.waitForSelector('text=Oil balance', { timeout: 120000 });
mark('skin_scores');
await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("today's palette"), null, { timeout: 120000 });
mark('skin_brief');
await page.waitForTimeout(1200);
// slow scroll of the left rail to show the brief
await page.evaluate(() => window.scrollTo({ top: 320, behavior: 'smooth' }));
await page.waitForTimeout(2400);
await page.evaluate(() => window.scrollTo({ top: 620, behavior: 'smooth' }));
await page.waitForTimeout(2600);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await page.waitForTimeout(1400);
mark('skin_viewed');

// Try-on 1: street style photo
await moveClick(page, page.locator('button[title="Street-style photo"]'));
mark('detect_start');
await page.waitForSelector('text=tap the one', { timeout: 120000 });
mark('detect_done');
await page.waitForTimeout(2800);
const outfitBtn = page.locator('button', { hasText: /outfit/i }).first();
await moveClick(page, outfitBtn);
mark('vto1_start');
await page.waitForSelector('text=Try another', { timeout: 240000 });
mark('vto1_done');
await page.waitForTimeout(1500);

// Drag the before/after slider
const stage = await page.locator('.mirror-reveal').boundingBox();
if (stage) {
  const y = stage.y + stage.height * 0.55;
  await page.mouse.move(stage.x + stage.width * 0.28, y, { steps: 20 });
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.9, y, { steps: 45 });
  await page.mouse.move(stage.x + stage.width * 0.16, y, { steps: 55 });
  await page.mouse.move(stage.x + stage.width * 0.62, y, { steps: 40 });
  await page.mouse.up();
}
mark('slider_played');

// Wait for the verdict tag
await page.waitForFunction(
  () => /Wear it|Maybe|Skip it/.test(document.body.innerText),
  null,
  { timeout: 120000 },
);
mark('verdict1');
await page.waitForTimeout(4200);

// Occasion switch to a night out + try-on 2 (slip dress)
await moveClick(page, page.getByRole('button', { name: 'a night out' }));
mark('occasion_set');
// The stylist re-judges the same look for the new occasion.
await page.waitForFunction(() => document.body.innerText.includes('Looking you over'), null, { timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => /Wear it|Maybe|Skip it/.test(document.body.innerText), null, { timeout: 120000 });
mark('verdict1b');
await page.waitForTimeout(3800);
await moveClick(page, page.getByRole('button', { name: 'Try another' }));
await page.waitForSelector('text=Drop any', { timeout: 15000 });
mark('stage_cleared');
await page.waitForTimeout(700);
await moveClick(page, page.locator('button[title="Slip dress shot"]'));
mark('vto2_start');
await page.waitForSelector('text=Try another', { timeout: 240000 });
mark('vto2_done');
await page.waitForTimeout(1200);
const stage2 = await page.locator('.mirror-reveal').boundingBox();
if (stage2) {
  const y = stage2.y + stage2.height * 0.5;
  await page.mouse.move(stage2.x + stage2.width * 0.8, y, { steps: 25 });
  await page.mouse.down();
  await page.mouse.move(stage2.x + stage2.width * 0.2, y, { steps: 50 });
  await page.mouse.up();
}
await page.waitForFunction(
  () => /Wear it|Maybe|Skip it/.test(document.body.innerText),
  null,
  { timeout: 120000 },
);
mark('verdict2');
await page.waitForTimeout(4500);

// Lookbook close
await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
await page.waitForTimeout(2800);
mark('lookbook');
await page.waitForTimeout(1500);
mark('end');

await ctx.close();
const video = await page.video()?.path();
await browser.close();
fs.writeFileSync(path.join(OUT, 'events.json'), JSON.stringify(events, null, 2));
console.log('video:', video);
console.log('events written:', path.join(OUT, 'events.json'));
