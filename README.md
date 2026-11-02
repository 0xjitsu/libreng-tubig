# Libreng Tubig

**Free water, toilets and shade.** A free, public-good map of Metro Manila showing drinking water, public toilets and covered shelters, for commuters, walkers and delivery riders. Live at https://libreng-tubig.vercel.app

- MapLibre GL map with three toggleable layers (water, toilets, shelter), clustering and a legend
- Popups with name, fee, opening hours, wheelchair, access, changing table, unisex/male/female, bottle refill, covered, plus **Directions** and **Edit on OpenStreetMap**
- Filters: free only (`fee=no` or unknown), wheelchair accessible, open now (hides only spots whose `opening_hours` parse as closed; unparseable hours count as unknown)
- "Use my location": nearest water, toilet and shelter with distance and walking time. **This is straight-line distance (walking time assumes about 80 m/min), not a routed walk.** A clear message is shown when location is denied
- "Add a missing spot" opens the OpenStreetMap editor at the current map view
- English / Tagalog toggle
- No API keys, no paid services, no runtime Overpass calls

## Data

- Source: [OpenStreetMap](https://www.openstreetmap.org) via the [Overpass API](https://overpass-api.de), prebaked into static GeoJSON in `public/data/` (`water`, `toilets`, `shelter`, plus `meta.json`).
- Tags: `amenity=drinking_water`, `amenity=water_point`, any other feature with `drinking_water=yes` (all shown as *water*), `amenity=toilets`, `amenity=shelter`. Nodes, ways and relations are included (as their centre point).
- Area: a **bounding box** around the National Capital Region (`14.35,120.90` to `14.78,121.15`), not the exact admin boundary, so a few spots just outside the NCR border (e.g. in Rizal or Cavite) may appear. The box is defined in `scripts/lib.mjs`.
- Fetch date: shown in the page footer and stored in `public/data/meta.json`. Current data was fetched **2026-11-02**.

### Refresh the data

```sh
npm run fetch-data     # node scripts/fetch-osm.mjs; retries and rotates Overpass mirrors
npm run build && npm run smoke
git add public/data && git commit -m "Refresh OSM data"
```

## Attribution and licences

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the [ODbL](https://opendatacommons.org/licenses/odbl/). The GeoJSON in `public/data/` is a derived database and stays under ODbL.
- Base map tiles and style: [OpenFreeMap](https://openfreemap.org) (free, no key; map data from OpenStreetMap, schema by OpenMapTiles). Please respect their [terms](https://openfreemap.org/tos/) and keep the attribution.
- Code: MIT (see `LICENSE`).

## Development

```sh
npm install
npm run dev        # Vite dev server
npm run lint       # tsc type-check + syntax checks of scripts
npm run build      # type-check + vite build -> dist/
npm run smoke      # validates dist/: OG/Twitter tags, preview.mp4 (<5 MB, MP4/H.264), GeoJSON (valid, non-empty, inside NCR bbox)
scripts/check-live.sh https://libreng-tubig.vercel.app   # same tag/video checks against a deployed URL
```

Deployed on Vercel as a static site (`vercel.json`: `outputDirectory: dist`, `buildCommand: npm run build`).

### Link-preview video

`public/og/preview.mp4` (1200×630, H.264, 7 s, ~1 MB) and `public/og/preview.png` are rendered from the real app by `scripts/render-preview.mjs` (headless Chromium + ffmpeg; it uses `playwright-core` and `CHROME_PATH` or `/usr/bin/chromium`). Re-render after visual changes with `npm run build && node scripts/render-preview.mjs`. `public/og/player.html` is the Twitter player page. The preview tags use the absolute base `https://libreng-tubig.vercel.app` in `index.html`.

## Add a missing spot

Open **Add a missing spot** in the app (or go to https://www.openstreetmap.org/edit), click *Add point*, choose the preset *Drinking water*, *Toilets* or *Shelter*, fill in what you know (`fee`, `opening_hours`, `wheelchair`) and save. New spots appear here after the next data refresh.

## Limitations

- **OSM coverage has gaps**: absence of a pin does not mean there is no fountain, toilet or shelter nearby.
- **Water potability is not verified.** `drinking_water=yes` and the `drinking_water` amenity are community-tagged; check signage, and when unsure, treat the water as non-potable.
- **Opening hours may be stale**, and the "open now" filter understands only simple `opening_hours` values (day ranges, times, `off`, `24/7`), evaluated in Manila time. Anything else is "unknown" and stays visible.
- Many toilets and shelters have no name or no fee/access tags; "free only" keeps unknown-fee spots.
- Distances are straight-line, not routes.
- Data is a static snapshot, not live.

## Support

Donate: https://github.com/sponsors/0xjitsu <!-- TODO: placeholder until the account is chosen. In the app, set DONATE_URL in src/main.ts to an empty string to hide the link. -->

## License

MIT
