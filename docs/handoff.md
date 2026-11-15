# GlobalVibe Maps: Handoff

Status: Chapter 1 complete. The POC is a working, self-hostable, open-source map stack for
weather, geoscience and planetary data, built to replace Mapbox inside GlobalVibe.ai. Everything
in this folder runs today with no build step and no third-party account.

This document covers three things:

1. **How it works** (architecture and core concepts)
2. **How to use it** (run it, the SDK, the backend services)
3. **How to integrate it with GlobalVibe.ai to replace Mapbox** (the migration plan)

A companion `README.md` has the file-by-file detail and the honest test log. This document is the
"pick it up and ship it" version.

---

## 1. How it works

### 1.1 The one-sentence version

A vendored copy of **MapLibre GL JS** draws a globe (Earth, Moon, Mars). Every data source the map
can touch is declared in a **manifest** with its license and commercial terms, is **probed live**
before it draws, and is wrapped behind a single **SDK object** (`GlobeMap`). Round worlds draw on
that globe; genuinely **irregular bodies** (Phobos, Ganymede) are drawn as their real NASA glTF
**shape models** by a second, dependency-free WebGL renderer (`ShapeModel`), since you cannot map a
lumpy moon onto a sphere. Three small zero-dependency Node services add a contact form, a metered
tile/key gateway, and an MCP server for agents.

### 1.2 Directory map

| Path | What it is | Role in integration |
|---|---|---|
| `vendor/maplibre-gl/` | MapLibre GL JS 6.17.0 (BSD-3-Clause), vendored | The renderer. This is the Mapbox GL JS replacement. |
| `src/maps.js` | **The SDK** (`GlobeMap` class; also exports `ShapeModel`) | **Primary integration surface.** Wraps renderer + manifest + probes + bodies + layers. |
| `src/shapemodel.js` | `ShapeModel`: dependency-free glTF (`.glb`) loader + WebGL renderer | Second renderer, for non-spherical worlds (Phobos, Ganymede). Not MapLibre. |
| `src/eqproj.js` | `gveq://` equirectangular to Web Mercator reprojection | Lets Moon/Mars tiles draw with no tile server in between. |
| `src/celestial.js` | Astronomy engine (frames, precession, ephemerides, star catalogue) | Powers the celestial sky + day/night terminator. Node-tested. |
| `src/starfield.js` | Shared sky + terminator renderer over any MapLibre globe | Used by both the SDK and the playground; one place for the sky. |
| `src/poc.js` | The playground logic | Reference implementation and a parity test harness. |
| `src/site.js` | The marketing/docs site + contact form | Not needed in the app; useful as copy and wiring reference. |
| `manifest.json` | Every allowed source with license, commercial flag, share-alike, probe URL | The provenance/allow-list. Copy and extend this in the app. |
| `features.json` | Feature list the Developers tab renders | Documentation data, not runtime. |
| `playground.html` | Standalone interactive playground | Use its "Copy camera" + presets to A/B against Mapbox. |
| `sdk-demo.html` | A page driven entirely by the SDK | The smallest working example of the SDK. |
| `shapes.html` | Shape-model demo: Ganymede + Phobos as real meshes, with graticule + named features | The working example of `ShapeModel` (irregular bodies). |
| `index.html` | Three-tab marketing/docs site | Product/Developers/Playground. Not part of the app. |
| `serve.mjs` | Zero-dependency static server + `POST /api/contact` + `/v1` gateway | Dev server and reference backend. |
| `mailer.mjs` | Dependency-free SMTP client | Contact-form notifications. |
| `keys.mjs` + `keys.json` | Metered `/v1` tile + usage gateway and its key store | Reference for keys/metering at the edge. |
| `mcp-server.mjs` | MCP server (JSON-RPC over stdio or HTTP/SSE) | Lets an AI agent ask for map-ready layers with licenses attached. |
| `data/` | Natural Earth 110m basemap, bright-star catalogue, and `data/models/` NASA glTF shape models | Bundled offline basemap + star data + Ganymede/Phobos models. |
| `fonts/` | Noto Sans glyphs (SIL OFL) | Self-hosted label glyphs. |
| `design/tokens.css` | Design system tokens | Only needed if you reuse the marketing UI. |

### 1.3 Core concepts

**Manifest-first, probe-gated, no silent fallback.** Nothing is requested unless it is listed in
`manifest.json`. On load, the SDK fetches each entry's `probe` URL from the browser. A layer can
only be enabled if its probe passed. `addLayer()` and `setBase()` reject if the source is not
reachable, rather than drawing a placeholder. This is the opposite of Mapbox's "it just works"
behavior and is intentional: you always know exactly what the map is touching and why.

**License provenance is data, not tribal knowledge.** Each manifest entry carries `license`,
`attribution`, `commercial` (`ok` / `review`), and `share_alike`. Share-alike sources (currently
OpenStreetMap via OpenFreeMap, ODbL 1.0) are flagged `store: "quarantine"`, and their map layers
carry `metadata: { "gv:store": "quarantine" }`. A paid build can strip those layers by rule
instead of by memory. This is the mechanism that keeps a commercial product license-clean.

**Round bodies share one renderer; irregular ones get a second.** Earth, Moon and Mars use the same
MapLibre instance. Planetary mosaics from NASA Trek are equirectangular; `src/eqproj.js` registers a
`gveq://` protocol that rebuilds them as Mercator tiles on a canvas in the browser, so no tile server
sits in between. Caveat: MapLibre always assumes Earth's radius, so the scale bar is hidden off-Earth
and there are no polar caps beyond 85.05 degrees.

For a genuinely non-spherical body you cannot use the globe at all — Phobos is a ~27 km lump whose
largest crater is nearly half its width. `ShapeModel` (`src/shapemodel.js`) is a second, smaller,
dependency-free renderer that loads NASA's own glTF (`.glb`) shape models and draws them as the real
triangle meshes they are, in a plain WebGL canvas, with the map data (a lon/lat graticule and named
surface features) draped on the actual surface rather than a pretend sphere. The `.glb` container,
its accessors, and the embedded texture are all parsed in-browser; the 4×4 matrix maths is a few
functions at the bottom of the file. It is a separate canvas, not a MapLibre layer, so the globe-only
features (tiles, projections, the starfield) do not apply to it. The playground swaps the MapLibre
canvas for a `ShapeModel` canvas when Ganymede or Phobos is selected; `shapes.html` is the standalone
demo. Ganymede/Phobos models live in `data/models/` (NASA 3D Resources).

**The SDK is the integration surface.** `GlobeMap` is a thin layer over MapLibre. It owns the
manifest, the probes, the body switching, the layer catalog, and bring-your-own-data. It exposes
the underlying MapLibre map as `.maplibre` for anything it does not wrap, so you are never boxed in.

### 1.4 Data flow

```
new GlobeMap({container, body, base})
   -> fetch manifest.json  (the allow-list)
   -> register gveq:// protocol (planetary reprojection)
   -> create maplibregl.Map (globe, glyphs, bundled basemap)
   -> reprobe(): fetch every source's probe URL, emit 'probe' events
   -> enable the requested base if its probe passed
   -> emit 'ready'

addLayer('quakes')  -> usable('quakes')? -> build source+layers -> show
addUserLayer(file)  -> parse GeoJSON/KML/GPX in-browser -> add source+layers -> fit
setBody('mars')     -> disable Earth layers -> swap bg/sky/projection -> enable Mars base
```

---

## 2. How to use it

### 2.1 Run it (development)

Requires Node 18+. No install, no build.

```
node serve.mjs            # http://localhost:8787
node serve.mjs 9000       # pick a port
```

It must be served over http; opening `index.html` from disk will not work (module + fetch).

- Site: `http://localhost:8787/`
- Playground: `http://localhost:8787/playground.html`
- SDK demo: `http://localhost:8787/sdk-demo.html`

### 2.2 The SDK (`GlobeMap`)

This is what the app imports. The whole public API:

```js
import { GlobeMap } from './src/maps.js';

const map = new GlobeMap({
  container: 'map',        // element id or HTMLElement (required)
  body: 'earth',           // 'earth' | 'moon' | 'mars'
  base: 'base-open',        // a base layer id for that body
  projection: 'globe',     // 'globe' | 'mercator'
  controls: true,          // nav + scale controls
  // manifestUrl, date, hash, mapOptions also supported
});

map.on('probe', (s) => {}); // fires per source as its probe runs: {id, state, commercial, ...}
map.on('ready', () => {});   // manifest loaded, probes run, globe drawn
map.on('body',  (b) => {});
map.on('error', (e) => {});
await map.ready;             // resolves to the instance

// bodies and projection
await map.setBody('mars', { base: 'mars-viking' });
await map.setProjection('mercator');

// layers (probe-gated: reject if the source is down)
await map.setBase('bluemarble');
await map.addLayer('quakes');       // overlay on
await map.addLayer('osm', { on: false });

// bring your own, read entirely in the browser
const layer = await map.addUserLayer(fileOrUrl); // GeoJSON/KML/GPX file or URL, or {z}/{x}/{y} template
map.removeUserLayer(layer.id);

// place search (bundled Natural Earth names; self-hosted)
map.flyToPlace(map.search('Lake Tahoe')[0]);

// draw and measure (geodesic length / spherical area)
const draw = map.draw({ mode: 'polygon' });
draw.on('finish', (f) => console.log(f.properties)); // { mode, length_km, area_km2 }

// time animation over the real VIIRS daily mosaic
map.playTimesteps('viirs', { days: 7 });

// particle flow field (illustrative by default; pass field(lng,lat)=>[u,v] for real data)
map.addParticles({ count: 2000 });

// real celestial sky: coloured stars, Milky Way, Sun/Moon/planets, constellations, terminator
const sky = map.addStarfield({ time: '2026-07-01T00:00Z', constellations: true, grid: true });
sky.setTime('2026-12-21T00:00Z');   // advance the whole sky
map.addTerminator();                 // real day/night shading on the globe

// escape hatch to raw MapLibre
map.maplibre.addLayer({ /* any MapLibre layer */ });
```

**Layer catalog** (ids you pass to `setBase` / `addLayer`):

- Earth bases: `base-open` (bundled Natural Earth), `bluemarble`, `s2` (Sentinel-2 2016), `viirs` (daily)
- Earth overlays: `borders`, `hillshade`, `terrain3d`, `osm` (quarantined), `quakes`
- Moon base: `moon-wac`
- Mars bases: `mars-viking`, `mars-mola`

**Irregular bodies (`ShapeModel`).** A separate renderer for non-spherical worlds, drawn from NASA
glTF shape models rather than on the globe. Same shape of API as `GlobeMap` (options object, `ready`
promise, event emitter), but it owns its own WebGL `<canvas>` — the globe-only features do not apply.

```js
import { ShapeModel } from './src/maps.js';

const model = new ShapeModel({
  container: 'view',
  model: 'data/models/phobos.glb',   // NASA 3D Resources glTF; also data/models/ganymede.glb
  radiusKm: [13.0, 11.4, 9.1],       // mean radius, or [a,b,c] triaxial — readout only
  graticule: true,                   // lon/lat graticule draped on the real surface
  lonDir: -1,                        // Phobos is measured west-positive (IAU)
  features: [{ name: 'Stickney', lon: 49, lat: 1 }],  // named surface features, planetographic deg
});
await model.ready;                   // .glb fetched, parsed, meshed, drawn
model.on('select', (f) => {});       // a feature pin was clicked
model.setGraticule(false);
model.flyTo({ lon: 49, lat: 1 });    // swing the camera to a lon/lat
```

Calibration per body: `northAxis` (pole), `lon0` (prime-meridian offset), `lonDir` (±1 east/west).
The playground selects Ganymede/Phobos as bodies and swaps in a `ShapeModel`; `shapes.html` is the
standalone demo.

### 2.3 Backend services (optional, reference-grade)

**Contact form** (`POST /api/contact`): stores a JSON lead to `leads/enterprise.jsonl` (never
served) and emails it if SMTP is configured. Enable email with env vars:

```
SMTP_HOST=smtp.example.com CONTACT_TO=sales@you.example SMTP_USER=... SMTP_PASS=... node serve.mjs
```

**Keys + metering** (`/v1`): keys live in `keys.json` (public keys only). Each request is
key-checked, origin-checked and rate-limited; usage persists to `usage.json` across restarts.

```
GET /v1/tiles/{body}/{tileset}/{z}/{x}/{y}?key=gv_pk_...   # 302 to upstream tile, metered
GET /v1/usage?key=gv_pk_...                                # per-key usage JSON
```

**MCP server for agents** (`mcp-server.mjs`): JSON-RPC 2.0 over stdio or HTTP/SSE.

```
node mcp-server.mjs                      # stdio (point Claude Desktop etc. here)
MCP_HTTP_PORT=2091 node mcp-server.mjs   # HTTP: POST JSON-RPC to /mcp
```

Tools: `list_layers`, `get_layer_license`, `get_style_url`, `search_place`.

---

## 3. Replacing Mapbox in GlobalVibe.ai

### 3.1 Why this is tractable

MapLibre GL JS is a community fork of the last open-source Mapbox GL JS (v1.13). For v1-era code
the APIs are close to identical: `Map`, `addSource`, `addLayer`, expressions, events, `flyTo`, and
so on all carry over. The main differences you will hit:

- Mapbox GL JS v2/v3 added proprietary pieces (its globe, Standard style, some camera and fog
  APIs). MapLibre has its own globe, terrain, and sky, so those map across but are configured
  differently.
- Mapbox uses `mapbox://` style, tile, glyph and sprite URLs plus an access token. All of those
  must be replaced with self-hosted equivalents (this POC bundles a basemap, glyphs, and a
  manifest of open sources to replace them).

### 3.2 Two integration modes

**Mode A: drop-in renderer swap (lowest level).** Keep the app's existing map wiring and swap
`mapboxgl` for `maplibregl`, pointing sources at self-hosted/open endpoints. Maximum control, but
you reimplement source wiring, probes, and provenance yourself.

**Mode B: adopt the `GlobeMap` SDK (recommended for the science/planetary surface).** Let the SDK
own bodies, probes, the layer catalog and provenance. Use `map.maplibre` for app-specific layers.
You get license-clean gating and Earth/Moon/Mars for free. The two modes coexist: the SDK is just
a MapLibre map with conventions.

Recommendation: Mode B for the map surface GlobalVibe.ai is replacing, dropping to Mode A
(`map.maplibre`) only for app-specific layers that the catalog does not cover yet.

### 3.3 Mapbox to GlobalVibe Maps mapping

| In GlobalVibe.ai today (Mapbox) | Replace with | Notes |
|---|---|---|
| `mapbox-gl` + access token | vendored `maplibre-gl`, no token | Remove `mapboxgl.accessToken`. |
| `mapboxgl.Map({ style: 'mapbox://...' })` | `new GlobeMap({...})` or `new maplibregl.Map({ style })` | Style becomes a local style object or SDK config. |
| Mapbox globe projection | MapLibre globe (`projection: { type: 'globe' }`) | Native in the SDK via `projection: 'globe'`. |
| Mapbox Terrain / `setTerrain` | MapLibre `setTerrain` over Mapterhorn DEM | SDK overlay `terrain3d`; or raw `map.setTerrain`. |
| Mapbox Satellite tiles | `bluemarble` / `s2` (open, commercial-ok) | Open imagery tops out near 10m. See gaps. |
| Mapbox Streets vector tiles | self-hosted PMTiles on your bucket (planned) or `osm` (quarantined) | OSM is share-alike; keep it out of paid builds. |
| `@mapbox/mapbox-gl-geocoder` | `map.search()` (bundled) or Photon gazetteer (planned) | Bundled is place-name grade only. |
| `@mapbox/mapbox-gl-draw` | `map.draw({ mode })` | Geodesic length + spherical area included. |
| Mapbox glyphs/sprites | self-hosted Noto Sans glyphs (bundled) | Add more glyph ranges for non-Latin scripts. |
| Mapbox usage/keys dashboard | `/v1` gateway + `keys.json` | Reference implementation; harden before billing. |

### 3.4 A phased migration plan

**Phase 0: Audit (half a day).** Grep the app for `mapbox`, the access token, `mapbox://` URLs,
and the Mapbox plugins listed above. Write down every Mapbox-specific feature in use. Pay special
attention to: the basemap style, geocoding, draw tools, satellite imagery, and anything that reads
live weather/model data (this is where the real risk is, not the renderer).

**Phase 1: Swap the renderer (1 to 2 days).** Replace `mapbox-gl` with the vendored `maplibre-gl`
(or the `GlobeMap` SDK). Remove the token. Get a blank globe rendering with the bundled Natural
Earth basemap and the app's own layers drawn on top via `map.maplibre.addLayer(...)`. Most v1-era
layer and expression code moves over unchanged.

**Phase 2: Replace sources with self-hosted ones (2 to 4 days).** Move the app's tile and style
dependencies onto your own origin. Extend `manifest.json` with the app's sources, each with its
license and commercial flag. Stand up self-hosted PMTiles for any street basemap you need at city
zoom (this is the planned "your own bucket" path). Keep share-alike sources quarantined.

**Phase 3: Re-wire features onto the SDK (2 to 5 days).** Geocoder to `map.search()` or a hosted
gazetteer; draw to `map.draw()`; terrain/hillshade/time to the SDK overlays; planetary bodies if
in scope. Validate each against the Mapbox build using the playground's "Copy camera" and preset
workflow so zoom/pitch/bearing match exactly.

**Phase 4: Keys, metering, and the paid tier (scope-dependent).** Adopt or rebuild the `/v1`
gateway pattern with a persistent store and signed keys, run it at the edge, and wire the
quarantine rule so paid builds ship license-clean. Hook billing to the usage counts.

**Phase 5: Cutover and parity sign-off.** Run both builds side by side. Use the playground's HUD
(fps, settle time, first idle) and the parity checks in the README to confirm the swap holds under
real cameras, poles, the antimeridian, and the globe/mercator switch.

### 3.5 Minimal code swap example

Before (Mapbox):

```js
import mapboxgl from 'mapbox-gl';
mapboxgl.accessToken = 'pk.live...';
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/satellite-streets-v12',
  projection: 'globe',
});
```

After (GlobeMap SDK):

```js
import { GlobeMap } from './vendor/maps/maps.js';
const map = new GlobeMap({ container: 'map', body: 'earth', base: 's2', projection: 'globe' });
await map.ready;
// app-specific layers still use raw MapLibre:
map.maplibre.addLayer({ id: 'my-layer', /* ... */ });
```

### 3.6 Gaps that block a full cutover

These are the real risk items. The renderer swap is the easy part; data is the hard part.

- **Wind/current particles**: the renderer is live but runs on an illustrative field. Live forecast
  data needs the time-series pipeline. If GlobalVibe.ai's current product leans on animated
  wind/currents, this is the top blocker.
- **Time-series (hourly model data)**: animation over daily imagery works; the GFS/RTOFS hourly
  pipeline (one Cloud-Optimized GeoTIFF per timestep + a STAC index, served with Martin) is server
  infrastructure and is not built.
- **Geocoding**: only bundled, place-name grade. An address-grade or global gazetteer needs an
  external index (Photon over Overture/GeoNames).
- **Street basemap at city zoom**: the open OSM path is share-alike (quarantined) and minimally
  styled. A commercial street basemap means self-hosted PMTiles with a commercial-safe style.
- **High-resolution satellite imagery**: open imagery is about 10m at best. If the app depends on
  sub-meter Mapbox Satellite, that is a sourcing decision, not a code change.
- **Sky**: astronomically correct (22 Node checks pass; Orion/Canis Major verified in-browser;
  terminator shades the correct hemisphere; proper motion verified on Sirius). Ships the full
  naked-eye sky: 8,404 stars from the public-domain Yale Bright Star Catalogue (`data/stars.json`),
  with colour and per-epoch proper motion. A deeper catalogue (fainter than mag 6.5) drops into
  `addStarfield({ catalog })` but is rarely needed. Remaining accuracy headroom: the Moon ephemeris
  is abridged (~0.3 deg) and planets are ~arcminute; both can be upgraded to full series if required.

### 3.7 Legal and licensing notes (read before the resale track)

- Mapbox Product Terms restrict using Mapbox services to develop or benchmark a competing product.
  Comparing as a customer deciding what to run on is different from benchmarking a service you
  intend to sell. This POC deliberately embeds no Mapbox pane and takes no Mapbox token for that
  reason. Send any comparative material to counsel first.
- The share-alike quarantine system exists so a paid build can exclude ODbL data by rule. Confirm
  the commercial terms of every source you add to the manifest. `commercial: review` means "do not
  assume it is cleared."
- `keys.json` holds public keys only. If keys gate real cost, move to signed keys and a persistent,
  auditable usage store, and keep the file out of the served root (it already returns 403).

---

## 4. Decisions needed (owner input)

1. Which GlobalVibe.ai map surfaces are in scope for Chapter 2: the whole app, or the
   science/planetary views first?
2. Street basemap: self-host PMTiles (commercial-clean) or accept the quarantined OSM path for now?
3. Satellite imagery sourcing if sub-meter is required.
4. The data pipeline for wind/time-series (this is the biggest build and the biggest risk).
5. Geocoding: stand up Photon/Overture, or keep bundled place-name search short term?
6. Pricing/metering model that the `/v1` gateway should enforce.

---

## 5. Chapter 2 backlog (next, in rough priority)

1. **Time-series + particle data pipeline** (COG-per-timestep + STAC; wire `addParticles` field to
   real GFS/RTOFS). Unblocks the two hardest features.
2. **Self-hosted street tiles**: PMTiles on object storage with a commercial-safe style.
3. **Global gazetteer** search (Photon over Overture/GeoNames) behind `map.search()`.
4. **Bring-your-own** PMTiles and GeoTIFF (pmtiles + maplibre-cog-protocol).
5. **Harden `/v1`**: signed keys, edge deployment, billing hooks.
6. **MCP `sample_value`** once the raster pipeline exists.
7. **Sky polish** (optional): full-series Moon/planet ephemerides (arcsecond), deep-sky catalogue,
   and a WebGL star renderer if a sub-mag-6.5 catalogue is ever bundled. The naked-eye sky is done.

---

## 6. Quick reference

- Run: `node serve.mjs [port]`
- SDK entry: `src/maps.js`, class `GlobeMap`, escape hatch `map.maplibre`
- Irregular bodies: `ShapeModel` (from `src/maps.js`), demo `shapes.html`, models in `data/models/`
- Allow-list/provenance: `manifest.json`
- Reprojection protocol: `src/eqproj.js` (`gveq://`)
- Backend: `POST /api/contact`, `/v1/tiles`, `/v1/usage`, `mcp-server.mjs`
- Env: `SMTP_*`, `CONTACT_*`, `MCP_HTTP_PORT`
- Parity testing: playground "Copy camera" + presets + HUD; checks listed in `README.md`
