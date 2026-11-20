# Rendered Data

A standalone site and playground for a SDK for a self-owned maps stack. 

Three tabs, one page (`index.html`):

- **Product**: the marketing page. Its numbers and tables are read from `manifest.json` and `features.json` at load.
- **Developers**: the feature list. Each feature shows how it is built, parity, license flag, test status and code.
  Features marked live open directly in the playground (or the SDK demo); features marked planned show a proposed API that is not built.
- **Playground**: the POC (`playground.html`), also usable on its own. It accepts deep links, for example
  `playground.html?body=mars&base=mars-mola` or `playground.html?on=hillshade,quakes#9.6/39.09/-120.04/20/55`.

The **SDK** (`src/maps.js`) wraps all of the above behind one object, and `sdk-demo.html` is a
page driven entirely by it. See *The SDK* below.

The design system is `design/tokens.css`, Inter Tight and JetBrains Mono are self-hosted in `design/fonts/`.

## Run it

Requires Node 18 or later. No install step, no build step.

```
node serve.mjs
```

Open http://localhost:8787/ for the site, or http://localhost:8787/playground.html for the playground alone (pass a port to change it: `node serve.mjs 9000`).
It must be served over http; opening `index.html` from disk will not work.

## Download the SDK

The SDK is a **library**, not this whole repo — `src/maps.js` (which exports `GlobeMap`, `ShapeModel`,
`maplibregl`) plus the exact files it loads at runtime. To produce a self-contained, self-hostable
bundle of just that:

```
node build-sdk.mjs
```

This writes `dist/rendereddata-maps-sdk/` (and `dist/rendereddata-maps-sdk.zip`) containing only the
SDK's import graph and runtime assets, laid out so `import {GlobeMap} from './src/maps.js'` works on
any static host — no build step, no install, no key. It includes a `README.md` and a ready-to-run
`example.html`. Serve the folder (`npx serve .`) and open `example.html`.

The site's **Download the SDK** button serves this zip from the repo's latest GitHub release. To cut
a release after a change:

```
node build-sdk.mjs
gh release create v$(node -p "require('./package.json').version") \
  dist/rendereddata-maps-sdk.zip --title "SDK v$(node -p "require('./package.json').version")"
```

The download link (`releases/latest/download/rendereddata-maps-sdk.zip`) is stable across releases.

The bundle is **portable to any sub-path** (e.g. a CDN at `https://cdn.example.com/rdm/`): every
bundled asset resolves relative to the module URL, not the page. Keep `manifest.json`, `data/`,
`fonts/` and `vendor/` as siblings of `src/`. The core path (Earth basemap, borders, place search,
labels) works fully offline; imagery, terrain, OSM, quakes and the Moon/Mars Trek mosaics stream from
their third-party sources (each probed live before it draws).

## API keys

None. There is no token, account or signup anywhere in this POC. That is the point of it.

## The SDK

`src/maps.js` is the working package behind the "SDK" feature. It wraps the vendored
MapLibre renderer, the manifest, the live probes, the `gveq://` protocol and a small layer
catalogue behind one object. `sdk-demo.html` is driven entirely by it.

```js
import {GlobeMap} from './src/maps.js';

const map = new GlobeMap({container: 'map', body: 'earth', base: 'base-open'});
map.on('probe', (s) => console.log(s.id, s.state, s.commercial));
await map.ready;                                  // manifest loaded, probes run, globe drawn

await map.setBody('mars', {base: 'mars-viking'}); // switch worlds
await map.addLayer('quakes');                     // gated on the source's live probe

// bring your own, read in the browser: GeoJSON / KML / GPX, {z}/{x}/{y} raster, PMTiles, GeoTIFF/COG
const layer = await map.addUserLayer(fileOrUrl);
await map.addPMTiles('https://example.com/basemap.pmtiles');   // vector or raster, over HTTP range
await map.addGeoTIFF(tifFileOrUrl);                            // EPSG:4326 or 3857, decoded in-browser

// build your own world: paint an imaginary planet on the template, then wrap it on the globe
GlobeMap.sphereTemplate({width: 2048});   // equirectangular guide to paint on
await map.addUserWorld(imageFileOrUrl);   // wrapped on the sphere in the browser
console.log(layer.probe.state, layer.license);    // 'ok'  'user-supplied, license unknown'

// place search over the bundled names (self-hosted, nothing leaves the page)
map.flyToPlace(map.search('Argentina')[0]);   // bundled index is the Natural Earth countries (Earth only)

// draw & measure (geodesic length / spherical area)
const draw = map.draw({mode: 'polygon'});
draw.on('finish', (f) => console.log(f.properties)); // { mode, length_km, area_km2 }

// animate a time-aware layer, or run an illustrative particle field
map.playTimesteps('viirs', {days: 7});
map.addParticles({count: 2000});                  // pass field(lng,lat)=>[u,v] for real data

// real celestial sky: coloured stars, Milky Way, Sun/Moon/planets, constellations, all time-aware
map.addStarfield({time: '2026-07-01T00:00Z', constellations: true, grid: true});
map.addTerminator();                              // real day/night shading on the globe
```

The sky comes from `src/celestial.js`, a dependency-free, Node-tested astronomy engine (ICRF
frames, IAU precession, Sun/Moon/planet ephemerides, B-V star colour, galactic transform, proper
motion), with `data/stars.json`: 8,404 naked-eye stars (Yale Bright Star Catalogue) carrying colour and proper
motion, applied per epoch. The sky is observer-relative (from Mars you see Earth), and the reachable
worlds (Earth, Moon, Mars) render as clickable travel hotspots: click one and `travelTo()` flies the
view to it and swaps the model. Disable with `addStarfield({hotspots: false})`.

A layer whose probe has not passed cannot be enabled; `addLayer` / `setBase` reject instead of
drawing a silent fallback. The particle field defaults to an **illustrative** flow, not a forecast;
pass your own `field(lng, lat)` to drive it from real wind/current data.

### Available bodies

Two renderers draw two kinds of world. `GlobeMap` handles round bodies on MapLibre's sphere;
`ShapeModel` handles irregular bodies from a mesh (next section). Which worlds exist, and which
layers each supports, is introspectable at runtime — the table below is the current state.

**`GlobeMap` — round worlds.** Three today. Pick one at construction (`body`) or switch at runtime
(`setBody`). Every base/overlay is gated on its own live probe before it draws.

| `body` | Label | Sky | Default base | Base layers | Overlays |
| --- | --- | --- | --- | --- | --- |
| `earth` | Earth | yes | `base-open` | `base-open`, `bluemarble`, `s2`, `viirs` | `borders`, `hillshade`, `terrain3d`, `osm`, `quakes` |
| `moon`  | Moon  | no  | `moon-wac`   | `moon-wac` | — |
| `mars`  | Mars  | no  | `mars-viking`| `mars-viking`, `mars-mola` | — |

```js
const map = new GlobeMap({container: 'map', body: 'earth'});
await map.ready;
map.bodies;                 // ['earth', 'moon', 'mars']        — the authoritative list
map.basesFor('mars');       // ['mars-viking', 'mars-mola']
map.overlaysFor('earth');   // ['borders', 'hillshade', 'terrain3d', 'osm', 'quakes']
await map.setBody('mars', {base: 'mars-mola'});
```

Any id outside that set throws: `setBody('phobos')` → `Error: Unknown body: phobos`. Irregular bodies
like Phobos are not `GlobeMap` worlds — they use `ShapeModel` below.

**`ShapeModel` — irregular worlds.** Not a fixed list: hand it any NASA glTF (`.glb`). Bundled under
`data/models/`, plus a round body drawn as a textured sphere (`sphere: true` + a `texture`):

| How | `body` id | Sky / parent orbit |
| --- | --- | --- |
| `model: 'data/models/phobos.glb'` | `phobos` | around Mars (sibling: Deimos) |
| `model: 'data/models/ganymede.glb'` | `ganymede` | around Jupiter |
| `model: 'data/models/24879_Deimos_1_1000.glb'` | `deimos` | sibling of Phobos |
| `sphere: true, texture: 'data/textures/moon.jpg'` | `moon` | around Earth |

The astronomy engine (`src/celestial.js`) carries IAU orientation and ephemerides for `earth`, `moon`,
`mars`, `phobos`, `ganymede` and `jupiter` (as a parent). Set `opts.body` to one of these to get the
correct sky, Sun direction and parent orbit; any other id still renders the mesh, just without a
body-specific sky.

### Irregular bodies (shape models)

The `GlobeMap` above draws every world on MapLibre's mathematical sphere. That is fine for Earth, the
Moon and Mars, but wrong for a body like Phobos — a ~27×22×18 km lump whose largest crater (Stickney)
is nearly half its width. You cannot map a sphere onto Phobos; you have to map onto its real shape.

`ShapeModel` (`src/shapemodel.js`) is a second, smaller renderer for exactly that. It loads NASA's own
glTF (`.glb`) shape models and draws them as the triangle meshes they are, in a plain WebGL canvas,
with the map data (a lon/lat graticule and named surface features) draped on the **actual** surface.
It is dependency-free: the `.glb` container and its accessors are parsed here, the embedded texture is
decoded with the browser's own `createImageBitmap`, and the 4×4 matrix maths is a handful of functions
at the bottom of the file. `shapes.html` is driven entirely by it; see the "Irregular bodies" feature
in the Developers tab.

```js
import {ShapeModel} from './src/maps.js';

const model = new ShapeModel({
  container: 'view',
  model: 'data/models/phobos.glb',   // NASA 3D Resources glTF; also data/models/ganymede.glb
  radiusKm: [13.0, 11.4, 9.1],       // triaxial, for the readout only
  graticule: true,
  lonDir: -1,                        // Phobos is measured west-positive (IAU)
  features: [{name: 'Stickney', lon: 49, lat: 1}],
});
await model.ready;                   // .glb fetched, parsed, meshed, drawn
model.on('select', (f) => console.log(f.name, f.lon, f.lat));
model.flyTo({lon: 49, lat: 1});      // swing the camera round to the giant crater
```

The graticule and feature pins are derived from the mesh **geometry** (a direction→radius grid), not
the texture, so they hug the real lumpy surface and work even though Phobos's texture is a custom atlas
rather than a clean equirectangular map. The named-feature coordinates are a small curated subset, and
`northAxis` / `lon0` / `lonDir` are the mesh-to-map calibration per body. This is a separate WebGL
canvas, not a MapLibre layer, so the globe-only features (tiles, projections, the starfield) do not
apply to it. The two NASA models live under `data/models/` (NASA 3D Resources, free to use).

## Contact form (Enterprise)

The Enterprise pricing card opens a contact form that posts JSON to `POST /api/contact`, served by
`serve.mjs`. Every submission is validated and appended to `leads/enterprise.jsonl`. That folder is
kept out of the static root logic, so a `GET` to it returns 403; stored leads are never web-readable.

Email notification is **best-effort and off by default**: the lead is always saved; an email is sent
only if SMTP is configured via environment variables. If it is not configured (or sending fails), the
submission still succeeds and the server logs the outcome. There is no third-party form service.

```
SMTP_HOST=smtp.example.com     # required to enable email
CONTACT_TO=sales@you.example   # required; comma-separated for several recipients
SMTP_PORT=587                  # optional (default 587; use 465 with SMTP_SECURE=true)
SMTP_SECURE=false              # optional; true for implicit TLS on 465
SMTP_USER=...                  # optional; enables AUTH LOGIN
SMTP_PASS=...                  # optional
CONTACT_FROM=site@you.example  # optional (defaults to SMTP_USER or no-reply@SMTP_HOST)
```

```
SMTP_HOST=smtp.example.com CONTACT_TO=sales@you.example SMTP_USER=... SMTP_PASS=... node serve.mjs
```

Works with any SMTP provider (an app-specific password, Postmark, Resend, Mailgun, your own server).
It covers one plain-text notification per submission over STARTTLS or implicit TLS; it is not a
general-purpose mail library.

## Keys and metering (`/v1`)

`serve.mjs` also exposes a minimal metered gateway (`keys.mjs`). Keys live in `keys.json` (public
keys only, no secrets). Each request is checked against the key, its origin allow-list and a
per-minute rate limit, and counted per key. Usage totals and per-day counts persist to `usage.json`
and survive a restart (`usage.json` is never served); a real deployment would run this at the edge.

```
GET /v1/tiles/{body}/{tileset}/{z}/{x}/{y}?key=gv_pk_...   # 302 → upstream tile, metered
GET /v1/usage?key=gv_pk_...                                # { total, thisMinute, remainingThisMinute, byDay }
```

Tilesets map to manifest sources (`earth/bluemarble`, `earth/s2`, `earth/viirs`); the planetary
mosaics need reprojection and are not a straight redirect. Returns 401 (no/invalid key), 403
(origin not allowed), 404 (unknown tileset) or 429 (over the limit). `keys.json` is never served.

Mint a key with the helper script (appends to `keys.json`, which is git-ignored):

```
node scripts/mint-key.mjs "<label>" "<origin1,origin2|*>" [ratePerMin]
# e.g. node scripts/mint-key.mjs "Acme Corp" "acme.com" 120   → prints gv_pk_…
```

Self-hosting never needs a key — a key is a billing boundary on the hosted `/v1` gateway only.
To request a hosted key from us, use the **Request an API key** button on the site (it routes
through the contact form). See `docs/api-keys-plan.md` for the full issuance plan.

Cross-origin: set `ALLOW_ORIGIN` to let the browser SDK call `/v1` from another origin (e.g.
`rendereddata.com` → `api.rendereddata.com`). Unset or `*` allows any caller; a comma-separated
list reflects the request `Origin` when it matches (with `Vary: Origin`). Preflight `OPTIONS` is
answered 204. The key + origin allow-list + rate limit remain the real access controls.

## Object catalog (`catalog.json`)

`catalog.json` is the license-clear object catalog: every self-hostable source (the manifest's data
layers plus the bundled NASA shape models), each with its license, provenance, commercial flag and
share-alike status. It's **generated** from `manifest.json` + the shape models — don't hand-edit it:

```
npm run build:catalog    # regenerate catalog.json
npm run check:catalog    # fail if it's stale (CI / pre-commit)
```

Every current object is `tier: "open"` (free, self-hostable). `metered: true` (with `v1_tileset`)
marks the sources the hosted `/v1` gateway can proxy and bill — the metering boundary, not a paywall
on the software. The gateway also serves it, keyless, at **`GET /v1/catalog`** (the open catalog the
MCP server and a future catalog page can read); a future hosted/premium tier would add `tier: "hosted"`
entries here.

## MCP server for agents

`mcp-server.mjs` is a dependency-free Model Context Protocol server (JSON-RPC 2.0 over stdio). It
reads the same `manifest.json` and `features.json` and exposes four tools:

```
node mcp-server.mjs                      # stdio (default)
MCP_HTTP_PORT=2091 node mcp-server.mjs   # or HTTP + SSE: POST JSON-RPC to /mcp

list_layers(status?)        # id, group, status, commercial flag
get_layer_license(layer)    # license, attribution, commercial, share-alike, store
get_style_url(body, base)   # a playground deep link + the SDK call
search_place(query, body?)  # bundled, place-name grade
```

Two transports: newline-delimited JSON-RPC over **stdio** (point a client like Claude Desktop at
`node mcp-server.mjs`), or a minimal **Streamable-HTTP** endpoint: `POST /mcp` returns the response
as JSON or, when the client sends `Accept: text/event-stream`, as a single SSE event; `GET /mcp` with
that header opens a keepalive stream. `sample_value(lat, lon, layer, time)` is the one proposed tool
still pending the time-series pipeline.

## What is in the folder

| Path | What | License |
|---|---|---|
| `vendor/maplibre-gl/` | MapLibre GL JS 6.17.0 (renderer and worker), vendored from npm | BSD-3-Clause |
| `data/ne_110m_admin_0_countries.geojson` | Natural Earth 110m countries: the bundled basemap | Public domain |
| `fonts/Noto Sans Regular/` | Label glyphs, 5 ranges (Latin, Greek, Cyrillic) | SIL OFL 1.1 |
| `manifest.json` | Every source the POC may contact, with license and commercial flag | |
| `src/poc.js` | The playground | |
| `src/site.js` | The three-tab site, plus the Enterprise contact form | |
| `src/maps.js` | The SDK: one object over the renderer, manifest, probes, bodies and layers | |
| `src/shapemodel.js` | `ShapeModel`: dependency-free glTF (`.glb`) loader + WebGL renderer for irregular bodies | |
| `sdk-demo.html` | A live page driven entirely by the SDK | |
| `shapes.html` | Shape-model demo: Ganymede and Phobos as real meshes, with a graticule and named features | |
| `features.json` | The feature list the Developers tab renders | |
| `design/` | Design tokens, base components, self-hosted fonts | Fonts: SIL OFL 1.1 |
| `src/eqproj.js` | Equirectangular to Web Mercator tile reprojection (Moon, Mars) | |
| `src/celestial.js` | Astronomy engine: frames, precession, ephemerides, proper motion, bright-star set | |
| `src/starfield.js` | Shared celestial-sky + terminator renderer (used by the SDK and the playground) | |
| `data/stars.json` | 8,404 naked-eye stars (Yale Bright Star Catalogue) with colour + proper motion | Public domain |
| `data/planet-template.svg` | Equirectangular "paint your planet" template for `addUserWorld()` | |
| `data/models/` | NASA glTF shape models (Ganymede, Phobos) for the irregular-bodies renderer | NASA 3D Resources |
| `serve.mjs` | Zero-dependency static server, plus `POST /api/contact` and the metered `/v1` gateway | |
| `mailer.mjs` | Zero-dependency SMTP client for contact-form notifications | |
| `keys.mjs` + `keys.json` | Metered `/v1` tile+usage gateway and its public-key store | |
| `mcp-server.mjs` | Zero-dependency MCP server for agents (JSON-RPC over stdio) | |
| `leads/` | Where contact submissions are appended; never served back (not web-readable) | |

## How it behaves

- **Manifest-first.** On load the page probes every entry in `manifest.json` from your browser.
  A layer can only be switched on if its probe passed. A failed probe shows the reason in the
  manifest panel; there is no fallback imagery and no placeholder data.
- **Bundled versus third-party.** The basemap, borders, labels and renderer are served from this
  folder. Imagery, terrain, street detail, earthquakes and the planetary mosaics are fetched live
  from their public hosts. The "Hosts contacted" table lists every host the page has reached, so
  you can see the dependency list directly. In the real platform those third-party rows become
  your own bucket.
- **Bodies.** Earth, Moon and Mars use the same renderer. Moon and Mars tiles are equirectangular,
  so `src/eqproj.js` rebuilds them as Mercator tiles in the browser.

## Evaluating against Mapbox

Suggested checks:

1. Globe feel: drag, zoom, pitch, rotate; inertia and smoothness at the "Whole globe" preset.
2. Poles and antimeridian: "North Pole" and "Antimeridian" presets. Look for seams and label breaks.
3. Globe to mercator switch.
4. Imagery sharpness at "Lake Tahoe" and "Himalaya": Sentinel-2 2016 here against Mapbox Satellite.
   Expect Mapbox to win at close zoom; the question is whether it matters at the zooms you use.
5. Terrain: hillshade and 3D terrain at the same two presets.
6. Street detail at city zoom. The OSM styling here is deliberately minimal (water, roads, place names).
7. Time: change the VIIRS date and watch the settle time in the HUD.
8. Moon and Mars: there is no Mapbox equivalent to compare.
9. HUD numbers: frames per second while moving, settle time after a change.

One caution on method. Mapbox's Product Terms (§1.5) restrict using its services to develop or
benchmark a competing product. Comparing as a customer deciding what a site should run on
is one thing; benchmarking for a mapping service you intend to sell is another. For that reason
this POC does not embed a Mapbox pane or take a Mapbox token. Raise it with counsel before any
comparison is used for the resale track.

## What this POC does not cover

All twenty-one listed features now have working code in this folder, but several are deliberately
scoped and still have a real "next step":

- **Wind/current particles**: the renderer is live, but it runs on an *illustrative* analytic field.
  Live forecast data rides on the time-series pipeline below.
- **Time-series**: animation over the real VIIRS daily mosaic works client-side; the GFS/RTOFS
  hourly pipeline (one COG per timestep + STAC index, served with Martin) is server infrastructure
  and is not built. This plus particles remain the real migration risk for replacing current map engines.
- **Place search**: bundled Natural Earth names only, not a global gazetteer (Photon/Overture).
- **Bring-your-own-layer**: GeoJSON, KML, GPX, XYZ raster, PMTiles (vector and raster) and
  GeoTIFF/COG (EPSG:4326 and 3857), all read in the browser with no extra libraries
  (`src/rasterformats.js`, 48 Node checks). Other GeoTIFF projections need a gdalwarp first; WMS
  and PMTiles brotli/zstd blocks are not read. No hosted upload service, by choice.
- **Keys/metering**: usage persists to `usage.json` across restarts; no billing or edge deploy yet.
- **MCP**: stdio and a minimal HTTP/SSE transport, four tools; `sample_value` is not built.
- **Celestial sky**: astronomically correct (ICRF/J2000, IAU orientation + precession, ephemeris
  Sun/Moon/planets, per-star proper motion, real terminator), verified by 22 Node checks. Bundles
  8,404 naked-eye stars; a deeper catalogue drops in via `addStarfield({ catalog })`. Neglects
  nutation and aberration (sub-arcminute). Moon ephemeris is abridged (~0.3 deg); planets ~arcminute.

Still entirely absent: Sky View and routing. Self-hosted street tiles now work: point `addPMTiles`
at a vector PMTiles basemap on your own bucket.

## Known limits

- Moon and Mars: no polar caps beyond 85.05 degrees (Web Mercator limit), and the renderer still
  assumes Earth's radius, so the scale bar is hidden and 3D distances would be wrong.
- Country labels cover Latin, Greek and Cyrillic only. Place names in other scripts from the OSM
  layer will not draw until more glyph ranges are added.
- The bundled basemap is 110m scale: fine for a globe, coarse when zoomed in.

## Before this page goes public

- The page avoids naming any competitor. Keep it that way, and send comparative copy to counsel first.
- Pricing is presented as tiers (Developer free, Team usage-based, Enterprise "let's talk") rather than
  figures. No dollar amounts are claimed; confirm the model and the free-tier/commercial terms before launch.
- All twenty-one listed features are marked live, but several are scoped (see "What this POC does not cover"):
  particles run an illustrative field, time-series animates daily imagery only, search is bundled names,
  metering is in-memory. The page says "Live in playground", not "production ready". Several also rely on
  third-party layers that have not all been seen working (see below).
- The contact form stores leads locally and, if SMTP is configured, emails them. Point `CONTACT_TO` at a
  real inbox and set up a lead backup/retention policy before taking real submissions.
- `keys.json` holds public keys only. If keys ever gate real cost, move to signed keys with a persistent
  usage store, and keep the file out of the served root (it already returns 403).

## Test status at build (2026-11-09)

Tested in headless Chrome with software rendering:

- Page loads with no script errors; bundled basemap, borders, labels and glyphs render on the globe.
- Site: all three tabs, hash routing, feature filter, "Open in playground" deep links, hero globe, self-hosted fonts.
  The Product view made zero third-party requests. No horizontal overflow at 390 px or 1400 px.
- Globe and mercator switch; body switch (Earth, Moon, Mars, back); presets; camera readout; URL hash.
- Probe gating: with third-party hosts unreachable, every third-party layer was disabled with a
  visible reason and nothing was drawn in its place.
- `src/eqproj.js`: checked with an equirectangular Earth image cut into tiles (test fixture, not
  shipped). Reprojected imagery lined up with Natural Earth borders on the globe, in mercator, and
  across zoom levels.
- SDK (`src/maps.js`) in `sdk-demo.html`: construction, probes, body switch, bring-your-own
  GeoJSON + XYZ, place search, draw & measure (a polygon measured ~711,000 km², matching its bbox),
  VIIRS time animation, and the particle renderer on globe and mercator.
- `src/rasterformats.js`: 48 Node checks (PMTiles v3 header/directory/Hilbert id/gzip against a
  hand-built archive, GeoTIFF IFD parse and geo-corners, LZW/PackBits/predictor/Deflate decode). In
  the browser, a PMTiles raster archive drew its tiles on the globe and a GeoTIFF (EPSG:4326) placed
  on its footprint, both loaded straight through `addUserLayer`.
- Celestial sky: `src/celestial.js` passes 22 astronomy checks in Node (equinox/solstice Sun,
  subsolar point, planet distances, full Moon on 2026-01-03, precession, galactic centre). In the
  browser, Orion and Canis Major render in the correct places with coloured stars, and the day/night
  terminator shades the correct hemisphere (unshaded on the subsolar side, dark on the antisolar side).
- `/v1` gateway (curl): 401 without a key, 403 on a disallowed origin, 302 to the resolved upstream
  tile, 404 for an unknown tileset, and usage counted per key.
- `mcp-server.mjs` (scripted stdio client): initialize, tools/list, and all four tool calls.

Not tested (the build sandbox could not reach these hosts, so their first real probe happens in your browser):

- Every third-party endpoint: NASA GIBS (Blue Marble, VIIRS), EOX Sentinel-2 2016, Mapterhorn,
  OpenFreeMap, USGS earthquakes, NASA Trek (Moon, Mars). URL templates, max zooms and CORS support
  are from documentation and memory, not from a live response.
- Therefore also untested: imagery layers, hillshade, 3D terrain, street detail, earthquakes,
  the VIIRS date picker, and Moon and Mars with real tiles.
- Frame rate on a real GPU, Safari, Firefox, and mobile layouts.

If a probe fails for you, the manifest panel shows the HTTP status or error. Send me that text and
I can correct the entry.
