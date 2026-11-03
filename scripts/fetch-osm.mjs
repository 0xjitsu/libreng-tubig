#!/usr/bin/env node
// Regenerates public/data/{water,toilets,shelter}.geojson and meta.json from OpenStreetMap (Overpass API).
// Usage: node scripts/fetch-osm.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { NCR_BBOX as b } from './lib.mjs';

const BBOX = `${b.south},${b.west},${b.north},${b.east}`;
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const QUERIES = {
  water: `(nwr["amenity"="drinking_water"](${BBOX});nwr["amenity"="water_point"](${BBOX});nwr["drinking_water"="yes"]["amenity"!="drinking_water"](${BBOX}););`,
  toilets: `nwr["amenity"="toilets"](${BBOX});`,
  shelter: `nwr["amenity"="shelter"](${BBOX});`,
};
const KEEP = ['name', 'name:en', 'name:tl', 'amenity', 'fee', 'charge', 'opening_hours', 'wheelchair', 'access',
  'changing_table', 'unisex', 'male', 'female', 'bottle', 'covered', 'drinking_water', 'shelter_type',
  'operator', 'description', 'indoor', 'seasonal'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(body) {
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'libreng-tubig/1.0 (https://github.com/0xjitsu/libreng-tubig)',
          accept: 'application/json',
        },
        body: 'data=' + encodeURIComponent(body),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.warn(`attempt ${attempt + 1} failed: ${e.message}`);
      await sleep(3000 * (attempt + 1));
    }
  }
  throw lastErr;
}

function toFeature(el, type) {
  const lon = el.lon ?? el.center?.lon;
  const lat = el.lat ?? el.center?.lat;
  if (lon == null || lat == null) return null;
  const props = { osm: `${el.type}/${el.id}`, type };
  for (const k of KEEP) if (el.tags?.[k] != null) props[k] = el.tags[k];
  return {
    type: 'Feature',
    id: `${el.type}/${el.id}`,
    properties: props,
    geometry: { type: 'Point', coordinates: [+lon.toFixed(6), +lat.toFixed(6)] },
  };
}

await mkdir('public/data', { recursive: true });
const counts = {};
let timestamp = null;
for (const [type, q] of Object.entries(QUERIES)) {
  const json = await overpass(`[out:json][timeout:90];${q}out center tags;`);
  timestamp ||= json.osm3s?.timestamp_osm_base;
  const features = json.elements.map((e) => toFeature(e, type)).filter(Boolean);
  features.sort((a, c) => a.id.localeCompare(c.id));
  counts[type] = features.length;
  await writeFile(`public/data/${type}.geojson`, JSON.stringify({ type: 'FeatureCollection', features }) + '\n');
  console.log(type, features.length);
  await sleep(2000);
}
const meta = {
  fetched: new Date().toISOString().slice(0, 10),
  osmBase: timestamp,
  bbox: b,
  counts,
  source: 'OpenStreetMap via Overpass API',
};
await writeFile('public/data/meta.json', JSON.stringify(meta, null, 2) + '\n');
console.log(meta);
