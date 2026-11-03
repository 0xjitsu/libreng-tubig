#!/usr/bin/env node
// Smoke checks on the built site (dist/). Run after `npm run build`.
import { readFile, stat } from 'node:fs/promises';
import { NCR_BBOX as b, TYPES } from './lib.mjs';

const BASE = 'https://libreng-tubig.vercel.app';
const MAX_MP4 = 5 * 1024 * 1024;
const errors = [];
const fail = (m) => errors.push(m);

// --- head tags ---------------------------------------------------------------
const html = await readFile('dist/index.html', 'utf8');
const metaTags = [...html.matchAll(/<meta\b[^>]*>/gis)].map((m) => m[0]);
function tag(key, value) {
  const re = new RegExp(`(?:property|name)\\s*=\\s*"${key.replace(/[:.]/g, '\\$&')}"`, 'i');
  const hit = metaTags.find((t) => re.test(t));
  const content = hit?.match(/content\s*=\s*"([^"]*)"/i)?.[1];
  if (content == null) return fail(`missing meta ${key}`);
  if (value instanceof RegExp ? !value.test(content) : content !== value) fail(`meta ${key} has unexpected value: ${content}`);
}
const abs = new RegExp(`^${BASE.replace(/\./g, '\\.')}/`);
tag('og:title', /\S/);
tag('og:description', /\S/);
tag('og:image', new RegExp(`^${BASE.replace(/\./g, '\\.')}/.+\\.png$`));
tag('og:image:width', '1200');
tag('og:image:height', '630');
tag('og:video', `${BASE}/og/preview.mp4`);
tag('og:video:secure_url', `${BASE}/og/preview.mp4`);
tag('og:video:type', 'video/mp4');
tag('og:video:width', /^\d+$/);
tag('og:video:height', /^\d+$/);
tag('twitter:card', 'player');
tag('twitter:player', new RegExp(`^${BASE.replace(/\./g, '\\.')}/og/player\\.html$`));
tag('twitter:player:width', /^\d+$/);
tag('twitter:player:height', /^\d+$/);
void abs;

// --- video -------------------------------------------------------------------
try {
  const s = await stat('dist/og/preview.mp4');
  if (s.size >= MAX_MP4) fail(`preview.mp4 is ${s.size} bytes (limit ${MAX_MP4})`);
  const buf = await readFile('dist/og/preview.mp4');
  if (buf.subarray(4, 8).toString('latin1') !== 'ftyp') fail('preview.mp4 is not an MP4 (no ftyp box)');
  if (!buf.includes(Buffer.from('avc1')) || !buf.includes(Buffer.from('avcC'))) fail('preview.mp4 does not look like H.264 (no avc1/avcC)');
} catch (e) {
  fail(`preview.mp4: ${e.message}`);
}
for (const f of ['dist/og/preview.png', 'dist/og/player.html']) await stat(f).catch(() => fail(`missing ${f}`));
try {
  const png = await readFile('dist/og/preview.png');
  if (png.readUInt32BE(16) !== 1200 || png.readUInt32BE(20) !== 630) fail('preview.png is not 1200x630');
} catch { /* reported above */ }

// --- geojson -----------------------------------------------------------------
for (const type of TYPES) {
  try {
    const fc = JSON.parse(await readFile(`dist/data/${type}.geojson`, 'utf8'));
    if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw new Error('not a FeatureCollection');
    if (fc.features.length === 0) fail(`${type}: zero features`);
    for (const f of fc.features) {
      const c = f.geometry?.coordinates;
      if (f.type !== 'Feature' || f.geometry?.type !== 'Point' || !Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite)) {
        fail(`${type}: invalid feature ${f.id}`);
        continue;
      }
      if (c[0] < b.west || c[0] > b.east || c[1] < b.south || c[1] > b.north) fail(`${type}: ${f.id} outside NCR bbox`);
      if (f.properties?.type !== type || !f.properties?.osm) fail(`${type}: ${f.id} bad properties`);
    }
    console.log(`${type}: ${fc.features.length} features`);
  } catch (e) {
    fail(`${type}.geojson: ${e.message}`);
  }
}
try {
  const meta = JSON.parse(await readFile('dist/data/meta.json', 'utf8'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.fetched)) fail('meta.json: bad fetched date');
} catch (e) {
  fail(`meta.json: ${e.message}`);
}

if (errors.length) {
  console.error('SMOKE FAILED:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log('smoke ok');
