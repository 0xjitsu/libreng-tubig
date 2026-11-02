import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { getLang, setLang, t, type Key } from './i18n';
import { isOpenNow } from './hours';

const DONATE_URL = 'https://github.com/sponsors/0xjitsu'; // TODO: placeholder until the account is chosen; empty string hides the link
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'; // OpenFreeMap: free, no key
const TYPES = ['water', 'toilets', 'shelter'] as const;
type PlaceType = (typeof TYPES)[number];
const COLORS: Record<PlaceType, string> = { water: '#0b84d8', toilets: '#7b3fb5', shelter: '#d97706' };

interface Props {
  osm: string;
  type: PlaceType;
  [k: string]: string;
}
interface Feat {
  id: string;
  properties: Props;
  geometry: { type: 'Point'; coordinates: [number, number] };
  type: 'Feature';
}
interface Meta {
  fetched: string;
  osmBase?: string;
}

const raw: Record<PlaceType, Feat[]> = { water: [], toilets: [], shelter: [] };
const visible: Record<PlaceType, boolean> = { water: true, toilets: true, shelter: true };
const filters = { free: false, wheelchair: false, open: false };
let meta: Meta | null = null;
let userPos: [number, number] | null = null;
let userMarker: maplibregl.Marker | null = null;
let map: maplibregl.Map;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---- icons -----------------------------------------------------------------
function drawIcon(type: PlaceType): ImageData {
  const size = 48;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.arc(24, 24, 21, 0, Math.PI * 2);
  g.fillStyle = COLORS[type];
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = '#fff';
  g.stroke();
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineWidth = 3;
  g.lineJoin = 'round';
  if (type === 'water') {
    g.beginPath();
    g.moveTo(24, 10);
    g.bezierCurveTo(32, 20, 34, 24, 34, 28);
    g.arc(24, 28, 10, 0, Math.PI, false);
    g.bezierCurveTo(14, 24, 16, 20, 24, 10);
    g.fill();
  } else if (type === 'toilets') {
    g.beginPath();
    g.arc(16, 14, 3.500, 0, Math.PI * 2);
    g.arc(32, 14, 3.500, 0, Math.PI * 2);
    g.fill();
    g.fillRect(12.500, 19, 7, 14);
    g.fillRect(28.500, 19, 7, 14);
    g.fillRect(22.500, 14, 3, 22);
  } else {
    g.beginPath();
    g.moveTo(9, 22);
    g.lineTo(24, 10);
    g.lineTo(39, 22);
    g.closePath();
    g.fill();
    g.fillRect(14, 24, 3.500, 13);
    g.fillRect(30.500, 24, 3.500, 13);
    g.fillRect(14, 24, 20, 3);
  }
  return g.getImageData(0, 0, size, size);
}

// ---- data ------------------------------------------------------------------
async function loadData(): Promise<void> {
  const [metaRes, ...cols] = await Promise.all([
    fetch('/data/meta.json'),
    ...TYPES.map((ty) => fetch(`/data/${ty}.geojson`)),
  ]);
  meta = (await metaRes.json()) as Meta;
  const parsed = await Promise.all(cols.map((r) => r.json() as Promise<{ features: Feat[] }>));
  TYPES.forEach((ty, i) => (raw[ty] = parsed[i].features));
}

function passes(f: Feat): boolean {
  const p = f.properties;
  if (filters.free && p.fee && p.fee !== 'no') return false;
  if (filters.wheelchair && p.wheelchair !== 'yes') return false;
  if (filters.open && isOpenNow(p.opening_hours) === false) return false;
  return true;
}
const filtered = (ty: PlaceType): Feat[] => raw[ty].filter(passes);

function refreshSources(): void {
  for (const ty of TYPES) {
    (map.getSource(ty) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: filtered(ty) } as never);
  }
  if (userPos) renderNearest();
}

// ---- popup -----------------------------------------------------------------
const triLabel = (v: string | undefined): string =>
  v === 'yes' ? t('yes') : v === 'no' ? t('no') : v === 'limited' ? t('limited') : v ? esc(v) : t('unknown');

function popupHtml(p: Props, coords: [number, number]): string {
  const [lon, lat] = coords;
  const rows: [string, string][] = [];
  const feeVal = p.fee ?? (p.charge ? p.charge : undefined);
  rows.push([t('fee'), feeVal ? (feeVal === 'no' ? t('no') + ' (' + t('freeOnly').split(' (')[0].toLowerCase() + ')' : esc(feeVal)) : t('unknown')]);
  if (p.opening_hours) {
    const o = isOpenNow(p.opening_hours);
    rows.push([t('hours'), esc(p.opening_hours) + ` — ${o === null ? t('unknown') : o ? t('openState') : t('no') + ' / closed'}`]);
  }
  rows.push([t('wheelchair'), triLabel(p.wheelchair)]);
  if (p.access) rows.push([t('access'), esc(p.access)]);
  if (p.type === 'toilets') {
    if (p.changing_table) rows.push([t('changing'), triLabel(p.changing_table)]);
    for (const k of ['unisex', 'male', 'female'] as const) if (p[k]) rows.push([t(k), triLabel(p[k])]);
  }
  if (p.type === 'water' && p.bottle) rows.push([t('bottle'), triLabel(p.bottle)]);
  if (p.type === 'shelter') {
    if (p.covered) rows.push([t('covered'), triLabel(p.covered)]);
    if (p.shelter_type) rows.push(['Type', esc(p.shelter_type)]);
  }
  const name = p.name || p['name:en'] || p['name:tl'] || t(p.type);
  const [kind, id] = p.osm.split('/');
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=walking`;
  const edit = `https://www.openstreetmap.org/edit?${kind}=${id}`;
  return `<div class="pop"><h3 style="color:${COLORS[p.type]}">${esc(name)}</h3>
    <div class="kind">${t(p.type)}</div>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="pop-links"><a href="${dir}" target="_blank" rel="noopener">${t('directions')}</a>
    <a href="https://www.openstreetmap.org/${kind}/${id}" target="_blank" rel="noopener">OSM</a>
    <a href="${edit}" target="_blank" rel="noopener">${t('edit')}</a></div></div>`;
}

function openPopup(f: { properties: Props; coords: [number, number] }): void {
  new maplibregl.Popup({ maxWidth: '300px', offset: 14 })
    .setLngLat(f.coords)
    .setHTML(popupHtml(f.properties, f.coords))
    .addTo(map);
}

// ---- nearest ---------------------------------------------------------------
function distM(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function renderNearest(): void {
  if (!userPos) return;
  const out = $('nearest');
  const items = TYPES.map((ty) => {
    let best: Feat | null = null;
    let bd = Infinity;
    for (const f of filtered(ty)) {
      const d = distM(userPos!, f.geometry.coordinates);
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    return { ty, best, bd };
  });
  out.innerHTML =
    `<h3>${t('nearest')}</h3><ul>` +
    items
      .map(({ ty, best, bd }) => {
        if (!best) return `<li><span class="dot" style="background:${COLORS[ty]}"></span>${t(ty)}: ${t('nothing')}</li>`;
        const dist = bd < 1000 ? `${Math.round(bd)} m` : `${(bd / 1000).toFixed(1)} km`;
        const mins = Math.max(1, Math.round(bd / 80));
        const name = esc(best.properties.name || t('unnamed'));
        return `<li><span class="dot" style="background:${COLORS[ty]}"></span><button type="button" data-id="${ty}:${best.id}">${t(ty)}: ${name}</button> <span class="dist">${dist} · ~${mins} ${t('walk')}</span></li>`;
      })
      .join('') +
    `</ul><p class="note">${t('straight')}</p>`;
  out.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach((b) =>
    b.addEventListener('click', () => {
      const [ty, id] = b.dataset.id!.split(/:(.+)/) as [PlaceType, string];
      const f = raw[ty].find((x) => x.id === id);
      if (!f) return;
      map.flyTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), 17) });
      openPopup({ properties: f.properties, coords: f.geometry.coordinates });
    }),
  );
}

function locate(): void {
  const out = $('nearest');
  if (!('geolocation' in navigator)) {
    out.innerHTML = `<p class="err">${t('unsupported')}</p>`;
    return;
  }
  out.innerHTML = `<p>${t('locating')}</p>`;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userPos = [pos.coords.longitude, pos.coords.latitude];
      userMarker?.remove();
      const el = document.createElement('div');
      el.className = 'me';
      userMarker = new maplibregl.Marker({ element: el }).setLngLat(userPos).addTo(map);
      const inNcr = userPos[0] > 120.9 && userPos[0] < 121.15 && userPos[1] > 14.35 && userPos[1] < 14.78;
      if (!inNcr) {
        out.innerHTML = `<p class="err">${t('outside')}</p>`;
        userPos = null;
        return;
      }
      renderNearest();
      const near = TYPES.flatMap((ty) => {
        const sorted = filtered(ty)
          .map((f) => ({ f, d: distM(userPos!, f.geometry.coordinates) }))
          .sort((a, b) => a.d - b.d);
        return sorted.slice(0, 1).map((x) => x.f.geometry.coordinates);
      });
      const bounds = new maplibregl.LngLatBounds(userPos, userPos);
      near.forEach((c) => bounds.extend(c));
      map.fitBounds(bounds, { padding: 70, maxZoom: 16 });
    },
    () => {
      out.innerHTML = `<p class="err">${t('denied')}</p>`;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

// ---- UI --------------------------------------------------------------------
function renderUi(): void {
  $('layers').innerHTML =
    `<h2>${t('layers')}</h2>` +
    TYPES.map(
      (ty) =>
        `<label class="row"><input type="checkbox" data-layer="${ty}" ${visible[ty] ? 'checked' : ''}><span class="dot" style="background:${COLORS[ty]}"></span>${t(ty)} <small>(${filtered(ty).length})</small></label>`,
    ).join('') +
    `<p class="note">${t('cluster')}</p>`;
  $('filters').innerHTML =
    `<h2>${t('filters')}</h2>` +
    (['free', 'wheelchair', 'open'] as const)
      .map((k) => {
        const label: Key = k === 'free' ? 'freeOnly' : k === 'open' ? 'openNow' : 'wheelchair';
        return `<label class="row"><input type="checkbox" data-filter="${k}" ${filters[k] ? 'checked' : ''}>${t(label)}</label>`;
      })
      .join('');
  $('locate-btn').textContent = '📍 ' + t('locate');
  $('add').innerHTML = `<h2><a id="add-link" href="#" target="_blank" rel="noopener">➕ ${t('add')}</a></h2><p class="note">${t('addNote')}</p>`;
  $('footer').innerHTML =
    `<span>${meta ? `${t('dataFrom')}: ${esc(meta.fetched)}. ` : ''}${t('disclaimer')}</span> ` +
    `<span>${t('attribution')} <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors (ODbL)</a></span> ` +
    `<span>MIT License${DONATE_URL ? ` · <a href="${esc(DONATE_URL)}" target="_blank" rel="noopener">♥ ${t('donate')}</a>` : ''}</span>`;
  $('lang').textContent = getLang() === 'en' ? 'TL' : 'EN';
  updateAddLink();

  document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((el) =>
    el.addEventListener('change', () => {
      const ty = el.dataset.layer as PlaceType;
      visible[ty] = el.checked;
      for (const l of ['clusters', 'count', 'points']) {
        map.setLayoutProperty(`${ty}-${l}`, 'visibility', el.checked ? 'visible' : 'none');
      }
    }),
  );
  document.querySelectorAll<HTMLInputElement>('[data-filter]').forEach((el) =>
    el.addEventListener('change', () => {
      filters[el.dataset.filter as keyof typeof filters] = el.checked;
      refreshSources();
      renderUi();
    }),
  );
}

function updateAddLink(): void {
  const c = map?.getCenter();
  const z = map ? Math.round(map.getZoom()) : 12;
  const a = document.getElementById('add-link') as HTMLAnchorElement | null;
  if (a && c) a.href = `https://www.openstreetmap.org/edit#map=${Math.max(z, 16)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`;
}

// ---- map -------------------------------------------------------------------
function initMap(): void {
  map = new maplibregl.Map({
    container: 'map',
    style: STYLE_URL,
    center: [121.0, 14.58],
    zoom: 10.8,
    maxBounds: [
      [120.6, 14.15],
      [121.45, 15.0],
    ],
    attributionControl: { compact: true },
  });
  (window as unknown as { __map: maplibregl.Map }).__map = map; // used by scripts/render-preview.mjs
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('moveend', updateAddLink);
  map.on('load', async () => {
    for (const ty of TYPES) map.addImage(`icon-${ty}`, drawIcon(ty), { pixelRatio: 2 });
    try {
      await loadData();
    } catch {
      $('nearest').innerHTML = '<p class="err">Could not load map data.</p>';
    }
    for (const ty of TYPES) {
      map.addSource(ty, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: filtered(ty) } as never,
        cluster: true,
        clusterRadius: 45,
        clusterMaxZoom: 15,
      });
      map.addLayer({
        id: `${ty}-clusters`,
        type: 'circle',
        source: ty,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': COLORS[ty],
          'circle-opacity': 0.88,
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
          'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 24, 200, 30],
        },
      });
      map.addLayer({
        id: `${ty}-count`,
        type: 'symbol',
        source: ty,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12,
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#fff' },
      });
      map.addLayer({
        id: `${ty}-points`,
        type: 'symbol',
        source: ty,
        filter: ['!', ['has', 'point_count']],
        layout: { 'icon-image': `icon-${ty}`, 'icon-size': 0.75, 'icon-allow-overlap': true },
      });
      map.on('click', `${ty}-clusters`, async (e) => {
        const f = map.queryRenderedFeatures(e.point, { layers: [`${ty}-clusters`] })[0];
        if (!f) return;
        const zoom = await (map.getSource(ty) as GeoJSONSource).getClusterExpansionZoom(f.properties.cluster_id);
        map.easeTo({ center: (f.geometry as unknown as { coordinates: [number, number] }).coordinates, zoom: zoom + 0.5 });
      });
      map.on('click', `${ty}-points`, (e) => {
        const f = e.features?.[0] as MapGeoJSONFeature | undefined;
        if (!f) return;
        const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates.slice() as [number, number];
        openPopup({ properties: f.properties as unknown as Props, coords });
      });
      for (const l of ['clusters', 'points']) {
        map.on('mouseenter', `${ty}-${l}`, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', `${ty}-${l}`, () => (map.getCanvas().style.cursor = ''));
      }
    }
    renderUi();
  });
}

setLang(navigator.language?.toLowerCase().startsWith('fil') || navigator.language?.toLowerCase().startsWith('tl') ? 'tl' : 'en');
initMap();
$('locate-btn').addEventListener('click', locate);
$('lang').addEventListener('click', () => {
  setLang(getLang() === 'en' ? 'tl' : 'en');
  renderUi();
  if (userPos) renderNearest();
});
$('panel').classList.add('ready');
