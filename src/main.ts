import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { getLang, setLang, t, type Key } from './i18n';
import { isOpenNow } from './hours';
import { isHidden, waterGroup } from './classify';

const DONATE_URL = 'https://github.com/sponsors/0xjitsu'; // TODO: placeholder until the account is chosen; empty string hides the link
const PC = ['coalesce', ['get', 'point_count'], 0]; // clusters only; 0 keeps step expressions numeric for plain points
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'; // OpenFreeMap: free, no key
// Layer draw order, bottom to top: water goes last so it is never buried.
const TYPES = ['refill', 'toilets', 'shelter', 'water'] as const;
type PlaceType = (typeof TYPES)[number];
const UI_ORDER: PlaceType[] = ['water', 'refill', 'toilets', 'shelter'];
const FILES = ['water', 'toilets', 'shelter'] as const;
// Dark enough for white text (>= 4.5:1); toilets is a neutral so it stays apart from water for colour-blind users.
const COLORS: Record<PlaceType, string> = { water: '#0369a1', refill: '#0f766e', toilets: '#374151', shelter: '#92400e' };
const RADII = [14, 18, 24, 30];
const UNNAMED: Record<PlaceType, Key> = { water: 'unnamedWater', refill: 'unnamedRefill', toilets: 'unnamedToilets', shelter: 'unnamedShelter' };

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
}
type LngLat = [number, number];

const raw: Record<PlaceType, Feat[]> = { water: [], refill: [], toilets: [], shelter: [] };
const visible: Record<PlaceType, boolean> = { water: true, refill: false, toilets: true, shelter: true };
const filters = { free: false, wheelchair: false, open: false };
let meta: Meta | null = null;
let dataState: 'loading' | 'ready' | 'error' = 'loading';
let userPos: LngLat | null = null;
let userMarker: maplibregl.Marker | null = null;
let map: maplibregl.Map | null = null;
let mapReady = false;
let listOpen = false;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const isMobile = (): boolean => window.matchMedia('(max-width: 760px)').matches;

// ---- icons -----------------------------------------------------------------
function drawGlyph(g: CanvasRenderingContext2D, type: PlaceType, color: string): void {
  g.fillStyle = color;
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.lineJoin = 'round';
  if (type === 'water' || type === 'refill') {
    g.beginPath();
    g.moveTo(24, 10);
    g.bezierCurveTo(32, 20, 34, 24, 34, 28);
    g.arc(24, 28, 10, 0, Math.PI, false);
    g.bezierCurveTo(14, 24, 16, 20, 24, 10);
    if (type === 'water') g.fill();
    else g.stroke(); // outline drop = refill / ask inside
  } else if (type === 'toilets') {
    g.beginPath();
    g.arc(16, 14, 3.5, 0, Math.PI * 2);
    g.arc(32, 14, 3.5, 0, Math.PI * 2);
    g.fill();
    g.fillRect(12.5, 19, 7, 14);
    g.fillRect(28.5, 19, 7, 14);
    g.fillRect(22.5, 14, 3, 22);
  } else {
    g.beginPath();
    g.moveTo(9, 22);
    g.lineTo(24, 10);
    g.lineTo(39, 22);
    g.closePath();
    g.fill();
    g.fillRect(14, 24, 3.5, 13);
    g.fillRect(30.5, 24, 3.5, 13);
    g.fillRect(14, 24, 20, 3);
  }
}

function drawIconCanvas(type: PlaceType): HTMLCanvasElement {
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
  drawGlyph(g, type, '#fff');
  return c;
}

/** White badge with a coloured glyph, drawn on cluster circles so clusters differ by shape, not only colour. */
function drawBadge(type: PlaceType): ImageData {
  const size = 40;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.arc(20, 20, 19, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  const s = 0.62;
  g.translate(20 - 24 * s, 20 - 24 * s);
  g.scale(s, s);
  drawGlyph(g, type, COLORS[type]);
  return g.getImageData(0, 0, size, size);
}

const swatchCache: Partial<Record<PlaceType, string>> = {};
const swatch = (ty: PlaceType): string =>
  `<img class="swatch" alt="" width="22" height="22" src="${(swatchCache[ty] ??= drawIconCanvas(ty).toDataURL())}">`;

// ---- data ------------------------------------------------------------------
async function loadData(): Promise<void> {
  dataState = 'loading';
  renderDataState();
  try {
    const [metaRes, ...cols] = await Promise.all([fetch('/data/meta.json'), ...FILES.map((ty) => fetch(`/data/${ty}.geojson`))]);
    if (!metaRes.ok || cols.some((r) => !r.ok)) throw new Error('HTTP error');
    meta = (await metaRes.json()) as Meta;
    const parsed = await Promise.all(cols.map((r) => r.json() as Promise<{ features: Feat[] }>));
    const byType: Record<PlaceType, Feat[]> = { water: [], refill: [], toilets: [], shelter: [] };
    FILES.forEach((file, i) => {
      for (const f of parsed[i].features) {
        if (isHidden(f.properties)) continue; // private / no-access spots are not shown at all
        if (file === 'water') {
          if (waterGroup(f.properties) === 'refill') byType.refill.push({ ...f, properties: { ...f.properties, type: 'refill' } });
          else byType.water.push(f);
        } else byType[file].push(f);
      }
    });
    for (const ty of TYPES) raw[ty] = byType[ty];
    dataState = 'ready';
  } catch {
    dataState = 'error';
  }
  renderDataState();
  renderUi();
  refreshSources();
  renderNearest();
  renderList();
}

function passes(f: Feat): boolean {
  const p = f.properties;
  // Shelters have no fee to know about, so "known free only" applies to the rest.
  if (filters.free && p.type !== 'shelter' && p.fee !== 'no') return false;
  if (filters.wheelchair && p.wheelchair !== 'yes') return false;
  if (filters.open && isOpenNow(p.opening_hours) === false) return false;
  return true;
}
const filtered = (ty: PlaceType): Feat[] => raw[ty].filter(passes);

function refreshSources(): void {
  if (!map || !mapReady) return;
  for (const ty of TYPES) {
    (map.getSource(ty) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: filtered(ty) } as never);
  }
}

function renderDataState(): void {
  const el = $('datastatus');
  if (dataState === 'loading') el.innerHTML = `<p class="note">${t('loading')}</p>`;
  else if (dataState === 'error') el.innerHTML = `<p class="err">${t('dataError')} <button type="button" id="retry-data" class="link">${t('retry')}</button></p>`;
  else el.innerHTML = '';
  document.getElementById('retry-data')?.addEventListener('click', () => void loadData());
}

// ---- popup -----------------------------------------------------------------
const triLabel = (v: string | undefined): string =>
  v === 'yes' ? t('yes') : v === 'no' ? t('no') : v === 'limited' ? t('limited') : v ? esc(v) : t('unknown');

function feeLabel(p: Props): string {
  const v = p.fee ?? (p.charge ? p.charge : undefined);
  if (!v) return t('unknown');
  if (v === 'no') return t('feeFree');
  if (v === 'yes') return t('feePaid');
  return esc(v);
}
function accessLabel(a: string): string {
  if (a === 'customers') return t('customersOnly');
  if (a === 'permit') return t('permitOnly');
  if (a === 'yes' || a === 'permissive' || a === 'public') return t('accessOpen');
  return esc(a);
}
const spotName = (p: Props): string => p.name || p['name:en'] || p['name:tl'] || t(UNNAMED[p.type]);
function badges(p: Props): string {
  const out: string[] = [];
  if (p.access === 'customers') out.push(t('customersOnly'));
  else if (p.access === 'permit') out.push(t('permitOnly'));
  return out.map((b) => ` <span class="badge">${b}</span>`).join('');
}

function popupHtml(p: Props, coords: LngLat): string {
  const rows: [string, string][] = [];
  rows.push([t('fee'), feeLabel(p)]);
  if (p.opening_hours) {
    const o = isOpenNow(p.opening_hours);
    rows.push([t('hours'), esc(p.opening_hours) + (o === null ? '' : ` — ${o ? t('openState') : t('closedState')}`)]);
  }
  rows.push([t('wheelchair'), triLabel(p.wheelchair)]);
  if (p.access) rows.push([t('access'), accessLabel(p.access)]);
  if (p.type === 'toilets') {
    if (p.changing_table) rows.push([t('changing'), triLabel(p.changing_table)]);
    for (const k of ['unisex', 'male', 'female'] as const) if (p[k]) rows.push([t(k), triLabel(p[k])]);
  }
  const isWater = p.type === 'water' || p.type === 'refill';
  if (isWater && p.bottle) rows.push([t('bottle'), triLabel(p.bottle)]);
  if (p.type === 'shelter') {
    if (p.covered) rows.push([t('covered'), triLabel(p.covered)]);
    if (p.shelter_type) rows.push([t('shelterType'), esc(p.shelter_type.replace(/_/g, ' '))]);
  }
  const [kind, id] = p.osm.split('/');
  const dir = dirUrl(coords);
  const edit = `https://www.openstreetmap.org/edit?${kind}=${id}`;
  const caveat = isWater
    ? `<p class="caveat"><strong>${t('potability')}</strong> ${t('osmTagged')}${p.type === 'refill' ? ' ' + t('bizNote') : ''}</p>`
    : '';
  return `<div class="pop"><h3>${esc(spotName(p))}</h3>
    <div class="kind">${swatch(p.type)} ${t(p.type)}${badges(p)}</div>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${caveat}
    <div class="pop-links"><a href="${dir}" target="_blank" rel="noopener">${t('directions')}</a>
    <a href="https://www.openstreetmap.org/${kind}/${id}" target="_blank" rel="noopener">OSM</a>
    <a href="${edit}" target="_blank" rel="noopener">${t('edit')}</a></div></div>`;
}

let popup: maplibregl.Popup | null = null;
let selected: LngLat | null = null;
let popupTrigger: (() => HTMLElement | null) | null = null;
// No fixed anchor: MapLibre auto-flips the popup to stay on screen.
function openPopup(f: { properties: Props; coords: LngLat }): void {
  if (!map || !mapReady) return;
  popup?.remove();
  selected = f.coords;
  const pop = new maplibregl.Popup({ maxWidth: '300px', offset: 14 }).setLngLat(f.coords).setHTML(popupHtml(f.properties, f.coords)).addTo(map);
  pop.on('close', () => {
    if (popup === pop) popup = selected = null;
  });
  popup = pop;
}
function closePopup(): void {
  popup?.remove();
  popup = selected = null;
}

/** Map-down fallback: show the spot's details inline in the panel instead of a popup. */
function showDetail(f: Feat): void {
  const el = $('detail');
  el.innerHTML = popupHtml(f.properties, f.geometry.coordinates) + `<button type="button" class="link" id="detail-close">${t('close')}</button>`;
  document.getElementById('detail-close')?.addEventListener('click', clearDetail);
  el.focus({ preventScroll: false });
}
function clearDetail(): void {
  const d = $('detail');
  const hadFocus = d.contains(document.activeElement);
  d.innerHTML = '';
  if (hadFocus) popupTrigger?.()?.focus({ preventScroll: true });
}

/** Height of the bottom sheet that overlaps the map (0 on desktop or when closed). */
function sheetOverlap(): number {
  const panel = $('panel');
  if (!isMobile() || !panel.classList.contains('open') || !map) return 0;
  const mapBottom = map.getContainer().getBoundingClientRect().bottom;
  return Math.max(0, Math.round(mapBottom - (window.innerHeight - panel.offsetHeight)));
}

function focusSpot(ty: PlaceType, id: string): void {
  const f = raw[ty].find((x) => x.id === id);
  if (!f) return;
  if (!map || !mapReady) {
    showDetail(f);
    return;
  }
  if (isMobile()) closeSheet();
  map.flyTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), 17) });
  openPopup({ properties: f.properties, coords: f.geometry.coordinates });
}

const dirUrl = (c: LngLat): string => `https://www.google.com/maps/dir/?api=1&destination=${c[1]},${c[0]}&travelmode=walking`;
const dirLink = (f: Feat): string =>
  `<a class="dir" href="${dirUrl(f.geometry.coordinates)}" target="_blank" rel="noopener">${t('directions')}<span class="sr"> — ${esc(spotName(f.properties))}</span></a>`;

function bindSpotButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach((b) =>
    b.addEventListener('click', () => {
      const [ty, id] = b.dataset.id!.split(/:(.+)/) as [PlaceType, string];
      const want = b.dataset.id!;
      popupTrigger = () => [...root.querySelectorAll<HTMLButtonElement>('button[data-id]')].find((x) => x.dataset.id === want) ?? null;
      focusSpot(ty, id);
    }),
  );
}

// ---- nearest ---------------------------------------------------------------
function distM(a: LngLat, b: LngLat): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestOf(ty: PlaceType, from: LngLat): { best: Feat | null; bd: number } {
  let best: Feat | null = null;
  let bd = Infinity;
  for (const f of filtered(ty)) {
    const d = distM(from, f.geometry.coordinates);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return { best, bd };
}
const fmtDist = (m: number): string => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

function nearestItems(from: LngLat): { ty: PlaceType; best: Feat | null; bd: number }[] {
  const items: { ty: PlaceType; best: Feat | null; bd: number }[] = [];
  for (const base of ['water', 'toilets', 'shelter'] as const) {
    if (!visible[base]) continue; // respect layer toggles
    let ty: PlaceType = base;
    let r = nearestOf(base, from);
    // Prefer a public tap. Fall back to a business only when there is no public tap, and label it.
    if (base === 'water' && !r.best) {
      ty = 'refill';
      r = nearestOf('refill', from);
    }
    items.push({ ty, ...r });
  }
  return items;
}

function renderNearest(): void {
  const out = $('nearest');
  if (!userPos) return;
  if (dataState !== 'ready') {
    out.innerHTML = '';
    return;
  }
  const items = nearestItems(userPos);
  if (!items.length) {
    out.innerHTML = `<h3>${t('nearest')}</h3><p class="note">${t('allOff')}</p>`;
    return;
  }
  out.innerHTML =
    `<h3>${t('nearest')}</h3><ul>` +
    items
      .map(({ ty, best, bd }) => {
        if (!best) return `<li>${swatch(ty)}${t(ty)}: ${t('nothing')}</li>`;
        const mins = Math.max(1, Math.round(bd / 80));
        const isWater = ty === 'water' || ty === 'refill';
        return `<li>${swatch(ty)}<button type="button" data-id="${ty}:${esc(best.id)}">${t(ty)}: ${esc(spotName(best.properties))}</button>${badges(best.properties)}
          <span class="dist">${fmtDist(bd)} · ~${mins} ${t('walk')}</span>
          ${dirLink(best)}
          ${ty === 'refill' ? `<span class="note">${t('bizNote')}</span>` : ''}
          ${isWater ? `<span class="note">${t('potability')}</span>` : ''}</li>`;
      })
      .join('') +
    `</ul><p class="note">${t('straight')}</p>`;
  bindSpotButtons(out);
}

function placeUserMarker(): void {
  if (!map || !mapReady || !userPos) return;
  userMarker?.remove();
  const el = document.createElement('div');
  el.className = 'me';
  userMarker = new maplibregl.Marker({ element: el }).setLngLat(userPos).addTo(map);
}

function locate(): void {
  const out = $('nearest');
  openSheet(false);
  if (!('geolocation' in navigator)) {
    out.innerHTML = `<p class="err">${t('unsupported')}</p>`;
    return;
  }
  out.innerHTML = `<p class="note">${t('locating')}</p>`;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const here: LngLat = [pos.coords.longitude, pos.coords.latitude];
      const inNcr = here[0] > 120.9 && here[0] < 121.15 && here[1] > 14.35 && here[1] < 14.78;
      if (!inNcr) {
        out.innerHTML = `<p class="err">${t('outside')}</p>`;
        userPos = null;
        return;
      }
      userPos = here;
      placeUserMarker();
      renderNearest();
      if (!map || !mapReady || dataState !== 'ready') return;
      const bottom = sheetOverlap(); // measured after results render, so it is the real sheet height
      const bounds = new maplibregl.LngLatBounds(here, here);
      for (const it of nearestItems(here)) if (it.best) bounds.extend(it.best.geometry.coordinates);
      map.fitBounds(bounds, {
        padding: { top: 70, left: 50, right: 50, bottom: 70 + bottom },
        maxZoom: 16,
      });
    },
    () => {
      out.innerHTML = `<p class="err">${t('denied')}</p>`;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

// ---- list of spots in view (keyboard / screen-reader alternative to the map) ----
function renderList(): void {
  const el = $('list');
  const btn = $('list-btn');
  btn.textContent = listOpen ? t('listHide') : t('list');
  btn.setAttribute('aria-expanded', String(listOpen));
  if (!listOpen) {
    el.innerHTML = '';
    return;
  }
  if (dataState !== 'ready') {
    el.innerHTML = '';
    return;
  }
  const c = map && mapReady ? map.getCenter() : { lng: 121.0, lat: 14.58 };
  const center: LngLat = [c.lng, c.lat];
  const b = map && mapReady ? map.getBounds() : null;
  const rows = UI_ORDER.filter((ty) => visible[ty])
    .flatMap((ty) => filtered(ty).map((f) => ({ ty, f, d: distM(center, f.geometry.coordinates) })))
    .filter(({ f }) => !b || b.contains(f.geometry.coordinates))
    .sort((a, z) => a.d - z.d)
    .slice(0, 25);
  el.innerHTML = rows.length
    ? `<p class="note">${t(b ? 'listNote' : 'listNoteNoMap')}</p><ul class="spots">` +
      rows
        .map(
          ({ ty, f, d }) =>
            `<li>${swatch(ty)}<button type="button" data-id="${ty}:${esc(f.id)}">${esc(spotName(f.properties))}</button>${badges(f.properties)}<span class="dist">${t(ty)} · ${fmtDist(d)}</span>${dirLink(f)}</li>`,
        )
        .join('') +
      '</ul>'
    : `<p class="note">${t('listEmpty')}</p>`;
  bindSpotButtons(el);
}

// ---- bottom sheet (mobile) ---------------------------------------------------
let sheetFocusTimer = 0;
/** While the modal sheet is open, keep Tab (and screen readers) inside it. */
function setBackgroundInert(on: boolean): void {
  if (on && !isMobile()) return; // never inert on desktop
  for (const id of ['topbar', 'stage', 'footer']) document.getElementById(id)?.toggleAttribute('inert', on);
}
function openSheet(showMore: boolean): void {
  const panel = $('panel');
  const wasOpen = panel.classList.contains('open');
  panel.classList.add('open');
  panel.classList.toggle('show-more', showMore);
  $('chip').setAttribute('aria-expanded', 'true');
  if (!isMobile()) return;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', t('chip'));
  // Focus only once the sheet is visible; focus() on a visibility:hidden element is a no-op.
  const focusClose = (): void => {
    window.clearTimeout(sheetFocusTimer);
    panel.removeEventListener('transitionend', onEnd);
    if (panel.classList.contains('open') && isMobile()) {
      $('sheet-close').focus({ preventScroll: true });
      setBackgroundInert(true); // only after focus is inside the sheet
    }
  };
  const onEnd = (e: TransitionEvent): void => {
    if (e.target === panel && e.propertyName === 'transform') focusClose();
  };
  if (wasOpen || window.matchMedia('(prefers-reduced-motion: reduce)').matches) focusClose();
  else {
    panel.addEventListener('transitionend', onEnd);
    sheetFocusTimer = window.setTimeout(focusClose, 400); // fallback if transitionend never fires
  }
  // The sheet's nearest rows already give name, caveat and Directions, so drop the popup
  // (it would sit inside the inert map) and keep the selected spot centred in the visible strip.
  if (map && mapReady && selected) {
    const spot = selected;
    closePopup();
    const overlap = sheetOverlap();
    map.easeTo({ center: spot, padding: { top: 0, left: 0, right: 0, bottom: overlap }, offset: [0, 0], duration: 250 });
  }
}
function closeSheet(): void {
  const panel = $('panel');
  const wasOpen = panel.classList.contains('open');
  panel.classList.remove('open', 'show-more');
  panel.removeAttribute('role');
  panel.removeAttribute('aria-modal');
  setBackgroundInert(false);
  window.clearTimeout(sheetFocusTimer);
  panel.removeAttribute('aria-label');
  $('chip').setAttribute('aria-expanded', 'false');
  if (!wasOpen) return;
  if (map && mapReady) map.easeTo({ padding: { top: 0, left: 0, right: 0, bottom: 0 }, duration: 0 });
  if (isMobile() && panel.contains(document.activeElement)) $('chip').focus({ preventScroll: true });
}

// ---- UI --------------------------------------------------------------------
function fmtDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(getLang() === 'tl' ? 'fil-PH' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function renderUi(): void {
  const ready = dataState === 'ready';
  $('layers').innerHTML =
    `<h2>${t('layers')}</h2>` +
    UI_ORDER.map(
      (ty) =>
        `<label class="row"><input type="checkbox" data-layer="${ty}" ${visible[ty] ? 'checked' : ''}>${swatch(ty)}<span>${t(ty)} <small>${ready ? `(${filtered(ty).length})` : ''}</small></span></label>`,
    ).join('') +
    `<p class="note">${t('refillHint')}</p><p class="note">${t('cluster')}</p>`;
  $('filters').innerHTML =
    `<h2>${t('filters')}</h2>` +
    (['free', 'wheelchair', 'open'] as const)
      .map((k) => {
        const label: Key = k === 'free' ? 'freeOnly' : k === 'open' ? 'openNow' : 'wheelchair';
        return `<label class="row"><input type="checkbox" data-filter="${k}" ${filters[k] ? 'checked' : ''}><span>${t(label)}</span></label>`;
      })
      .join('');
  $('locate-btn').textContent = '📍 ' + t('locate');
  $('fab').textContent = '📍 ' + t('fab');
  $('chip').textContent = t('chip');
  $('sheet-close').textContent = t('close');
  $('add').innerHTML = `<h2><a id="add-link" href="#" target="_blank" rel="noopener">➕ ${t('add')}</a></h2><p class="note">${t('addNote')}</p>`;
  const wasOpen = document.querySelector<HTMLDetailsElement>('#footer details')?.open ?? false;
  $('footer').innerHTML =
    `<details${wasOpen ? ' open' : ''}><summary>${meta ? `${t('dataFrom')} ${esc(fmtDate(meta.fetched))} · ` : ''}${t('footerShort')} ⓘ</summary>` +
    `<div class="foot-body"><p>${t('disclaimer')}</p>` +
    `<p><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors (ODbL)</a> · ${t('tiles')}: <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a></p>` +
    `<p>MIT License${DONATE_URL ? ` · <a href="${esc(DONATE_URL)}" target="_blank" rel="noopener">♥ ${t('donate')}</a>` : ''}</p></div></details>`;
  $('lang').textContent = t('langName');
  $('lang').setAttribute('lang', getLang() === 'en' ? 'tl' : 'en');
  renderDataState();
  renderList();
  updateAddLink();

  document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((el) =>
    el.addEventListener('change', () => {
      const ty = el.dataset.layer as PlaceType;
      visible[ty] = el.checked;
      if (map && mapReady) {
        for (const l of ['clusters', 'count', 'glyph', 'points']) map.setLayoutProperty(`${ty}-${l}`, 'visibility', el.checked ? 'visible' : 'none');
      }
      renderNearest();
      renderList();
    }),
  );
  document.querySelectorAll<HTMLInputElement>('[data-filter]').forEach((el) =>
    el.addEventListener('change', () => {
      filters[el.dataset.filter as keyof typeof filters] = el.checked;
      refreshSources();
      renderUi();
      renderNearest();
    }),
  );
}

function updateAddLink(): void {
  const c = map && mapReady ? map.getCenter() : null;
  const z = map && mapReady ? Math.round(map.getZoom()) : 12;
  const a = document.getElementById('add-link') as HTMLAnchorElement | null;
  if (a) a.href = c ? `https://www.openstreetmap.org/edit#map=${Math.max(z, 16)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}` : 'https://www.openstreetmap.org/edit';
}

// ---- map -------------------------------------------------------------------
function showMapError(): void {
  const el = $('mapmsg');
  el.hidden = false;
  el.innerHTML = `<p>${t('mapError')}</p><button type="button" id="retry-map">${t('retry')}</button>`;
  document.getElementById('retry-map')?.addEventListener('click', () => {
    el.hidden = true;
    map?.remove();
    map = null;
    initMap();
  });
}

/** Picks the closest visible marker or cluster within a 44 px touch target. */
function pickAt(pt: maplibregl.Point): { f: maplibregl.MapGeoJSONFeature; cluster: boolean } | null {
  if (!map || !mapReady) return null;
  const layers = TYPES.filter((ty) => visible[ty]).flatMap((ty) => [`${ty}-points`, `${ty}-clusters`]);
  if (!layers.length) return null;
  const R = 22;
  const feats = map.queryRenderedFeatures([[pt.x - R, pt.y - R], [pt.x + R, pt.y + R]], { layers });
  let best: { f: maplibregl.MapGeoJSONFeature; cluster: boolean } | null = null;
  let bd = Infinity;
  for (const f of feats) {
    const p = map.project((f.geometry as unknown as { coordinates: LngLat }).coordinates);
    const d = Math.hypot(p.x - pt.x, p.y - pt.y);
    if (d < bd) {
      bd = d;
      best = { f, cluster: f.properties.cluster === true };
    }
  }
  return best;
}

function initMap(): void {
  mapReady = false;
  const m = new maplibregl.Map({
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
  map = m;
  (window as unknown as { __map: maplibregl.Map }).__map = m; // used by scripts/render-preview.mjs
  m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  m.on('moveend', () => {
    updateAddLink();
    if (listOpen) renderList();
  });
  // The basemap style has icon gaps; give missing images a blank so MapLibre stays quiet.
  m.on('styleimagemissing', (e) => {
    if (!m.hasImage(e.id)) m.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });
  m.on('error', () => {
    if (!mapReady && map === m) showMapError(); // style failed to load; UI keeps working without the map
  });
  m.on('load', () => {
    // The basemap's own POI icons look like ours; hide them (keep transit).
    for (const l of m.getStyle().layers) {
      if ((l as { 'source-layer'?: string })['source-layer'] === 'poi' && l.id !== 'poi_transit') m.setLayoutProperty(l.id, 'visibility', 'none');
    }
    for (const ty of TYPES) {
      m.addImage(`icon-${ty}`, drawIconCanvas(ty).getContext('2d')!.getImageData(0, 0, 48, 48), { pixelRatio: 2 });
      m.addImage(`badge-${ty}`, drawBadge(ty), { pixelRatio: 2 });
    }
    for (const ty of TYPES) {
      const vis = visible[ty] ? 'visible' : 'none';
      const bump = ty === 'water' ? 4 : 0; // water is the product; make its clusters larger
      const radius = ['step', PC, RADII[0] + bump, 10, RADII[1] + bump, 50, RADII[2] + bump, 200, RADII[3] + bump];
      const off = (r: number) => ['literal', [Math.round((r + bump) * 0.72), -Math.round((r + bump) * 0.72)]];
      m.addSource(ty, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: filtered(ty) } as never,
        cluster: true,
        clusterRadius: 45,
        clusterMaxZoom: 15,
      });
      m.addLayer({
        id: `${ty}-clusters`,
        type: 'circle',
        source: ty,
        filter: ['has', 'point_count'],
        layout: { visibility: vis },
        paint: {
          'circle-color': COLORS[ty],
          'circle-opacity': 1, // opaque so the white count keeps >= 4.5:1
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
          'circle-radius': radius as never,
        },
      });
      m.addLayer({
        id: `${ty}-count`,
        type: 'symbol',
        source: ty,
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-allow-overlap': true, visibility: vis },
        paint: { 'text-color': '#fff' },
      });
      m.addLayer({
        id: `${ty}-glyph`,
        type: 'symbol',
        source: ty,
        filter: ['has', 'point_count'],
        layout: {
          'icon-image': `badge-${ty}`,
          'icon-size': 0.7,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-offset': ['step', PC, off(RADII[0]), 10, off(RADII[1]), 50, off(RADII[2]), 200, off(RADII[3])] as never,
          visibility: vis,
        },
      });
      m.addLayer({
        id: `${ty}-points`,
        type: 'symbol',
        source: ty,
        filter: ['!', ['has', 'point_count']],
        layout: { 'icon-image': `icon-${ty}`, 'icon-size': 0.9, 'icon-allow-overlap': true, visibility: vis },
      });
    }
    m.on('click', async (e) => {
      const hit = pickAt(e.point);
      if (!hit) return;
      const coords = (hit.f.geometry as unknown as { coordinates: LngLat }).coordinates.slice() as LngLat;
      if (hit.cluster) {
        const zoom = await (m.getSource(hit.f.source) as GeoJSONSource).getClusterExpansionZoom(hit.f.properties.cluster_id);
        m.easeTo({ center: coords, zoom: zoom + 0.5 });
      } else {
        popupTrigger = () => m.getCanvas();
        openPopup({ properties: hit.f.properties as unknown as Props, coords });
      }
    });
    m.on('mousemove', (e) => {
      m.getCanvas().style.cursor = pickAt(e.point) ? 'pointer' : '';
    });
    // Attribution stays one tap away (and in the footer) but starts collapsed.
    const attrib = m.getContainer().querySelector('.maplibregl-ctrl-attrib');
    attrib?.removeAttribute('open');
    attrib?.classList.remove('maplibregl-compact-show');
    mapReady = true;
    $('mapmsg').hidden = true;
    placeUserMarker();
    updateAddLink();
    renderList();
  });
}

// ---- boot ------------------------------------------------------------------
setLang(navigator.language?.toLowerCase().startsWith('fil') || navigator.language?.toLowerCase().startsWith('tl') ? 'tl' : 'en');
$('locate-btn').addEventListener('click', locate);
$('fab').addEventListener('click', locate);
$('chip').addEventListener('click', () => (document.getElementById('panel')!.classList.contains('open') ? closeSheet() : openSheet(true)));
$('sheet-close').addEventListener('click', closeSheet);
window.matchMedia('(max-width: 760px)').addEventListener('change', (e) => {
  if (!e.matches) closeSheet();
});
$('list-btn').addEventListener('click', () => {
  listOpen = !listOpen;
  renderList();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const hadPopup = !!popup;
    const trigger = popupTrigger;
    closePopup();
    closeSheet();
    clearDetail();
    if (hadPopup && !isMobile() && (!document.activeElement || document.activeElement === document.body)) {
      (trigger?.() ?? map?.getCanvas())?.focus({ preventScroll: true });
    }
  }
});
$('lang').addEventListener('click', () => {
  setLang(getLang() === 'en' ? 'tl' : 'en');
  renderUi();
  renderNearest();
});
renderUi(); // the panel works without the map
void loadData();
try {
  initMap();
} catch {
  showMapError();
}
$('panel').classList.add('ready');
