// Unit tests for src/classify.ts (npm run test:classify). Types are stripped with esbuild (bundled with vite).
import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const js = transformSync(readFileSync(new URL('../src/classify.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' }).code;
const { waterGroup } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const d = (o) => ({ amenity: 'drinking_water', ...o });

const cases = [
  ['unnamed tap', d({}), 'water'],
  ['Alpha-Omega (named, no access)', d({ name: 'Alpha-Omega' }), 'refill'],
  ['Alpha-Omega Water Station', d({ name: 'Alpha-Omega Water Station' }), 'refill'],
  ['5S Water Destination Services', d({ name: '5S Water Destination Services' }), 'refill'],
  ['public fountain by name', d({ name: 'Rizal Park Public Fountain' }), 'water'],
  ['named with access=yes', d({ name: 'Alpha-Omega', access: 'yes' }), 'water'],
  ['named with access=permissive', d({ name: 'Barangay Hall', access: 'permissive' }), 'water'],
  ['fee=yes', d({ fee: 'yes' }), 'refill'],
  ['customers only', d({ access: 'customers' }), 'refill'],
  ['drinking_water=refill', d({ drinking_water: 'refill' }), 'refill'],
  ['business operator', d({ operator: 'Aqua Services Inc' }), 'refill'],
  ['not drinking_water', { amenity: 'water_point' }, 'refill'],
];
for (const [name, tags, want] of cases) assert.equal(waterGroup(tags), want, name);
console.log(`classify: ${cases.length} cases ok`);
