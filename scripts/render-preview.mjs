#!/usr/bin/env node
// Renders public/og/preview.mp4 (+ preview.png) by driving the real built app in headless Chromium.
// Needs: npm run build, ffmpeg, and a Chromium/Chrome binary (CHROME_PATH or /usr/bin/chromium).
// Usage: npm run build && node scripts/render-preview.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const W = 1200, H = 630, FPS = 20, SECONDS = 7;
const FRAMES = FPS * SECONDS;
const dir = '/tmp/lt-frames';
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3000));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto('http://localhost:4173/');
await page.waitForFunction(() => window.__map && window.__map.loaded() && window.__map.getSource('shelter'), null, { timeout: 60000 });
await page.addStyleTag({
  content: `#topbar,#panel,#footer,.maplibregl-ctrl{display:none!important}#app{display:block!important}#map{height:100vh!important}
  #cap{position:fixed;left:40px;bottom:40px;padding:14px 22px;border-radius:14px;background:rgba(11,110,153,.94);color:#fff;font:700 40px system-ui,sans-serif;z-index:9}
  #cap small{display:block;font-weight:500;font-size:22px;opacity:.9;margin-top:4px}`,
});
await page.evaluate(() => {
  const d = document.createElement('div');
  d.id = 'cap';
  document.body.appendChild(d);
  const m = window.__map;
  m.resize();
  for (const ty of ['water', 'toilets', 'shelter']) for (const l of ['clusters', 'count', 'points']) m.setLayoutProperty(`${ty}-${l}`, 'visibility', 'none');
});

const caps = [
  ['💧 Libreng Tubig', 'Free water, toilets and shade in Metro Manila'],
  ['💧 Free drinking water', 'Refill your bottle'],
  ['🚻 Public toilets', 'When you need a restroom'],
  ['☂️ Shelter & shade', 'Out of the sun and the rain'],
  ['💧 Libreng Tubig', 'libreng-tubig.vercel.app'],
];
for (let i = 0; i < FRAMES; i++) {
  const p = i / (FRAMES - 1);
  const e = p * p * (3 - 2 * p);
  const zoom = 9.9 + 1.7 * e;
  const lon = 121.03 - 0.02 * e;
  const lat = 14.6 - 0.02 * e;
  const stage = p < 0.18 ? 0 : p < 0.42 ? 1 : p < 0.62 ? 2 : p < 0.82 ? 3 : 4;
  await page.evaluate(
    ([zoom, lon, lat, stage, cap]) => {
      const m = window.__map;
      m.jumpTo({ center: [lon, lat], zoom });
      const on = { water: stage >= 1, toilets: stage >= 2, shelter: stage >= 3 };
      for (const ty of Object.keys(on)) for (const l of ['clusters', 'count', 'points']) m.setLayoutProperty(`${ty}-${l}`, 'visibility', on[ty] ? 'visible' : 'none');
      document.getElementById('cap').innerHTML = `${cap[0]}<small>${cap[1]}</small>`;
    },
    [zoom, lon, lat, stage, caps[stage]],
  );
  await page.waitForFunction(() => window.__map.areTilesLoaded(), null, { timeout: 30000 });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${dir}/f${String(i).padStart(4, '0')}.png` });
}
// Poster: last-but-one stage, all layers visible.
await page.screenshot({ path: 'public/og/preview.png' });
await browser.close();
server.kill();

execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', `${dir}/f%04d.png`, '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
  '-crf', '28', '-preset', 'slow', '-movflags', '+faststart', '-an', 'public/og/preview.mp4'], { stdio: 'inherit' });
console.log('done');
