# Rendered Data — Work Tracker

A running status log. Newest entry on top. For architecture and the ship-it guide, see
`docs/handoff.md` and `README.md`; this file is just "where are we right now."

---

## 2026-11-15 (evening) — True-scale moon systems, orbits, scientific accuracy, capture (post-v1)

**Uncommitted follow-ups on top of v1 (`0fce660`, not yet pushed). All verified in-browser.**

- **Moon views rebuilt as a true-scale 3D system.** The primary (Mars/Jupiter) is no longer faked in a
  rotation-only sky pass — it's a real object in the main pass at its **true distance and radius in
  moon-radii** (Mars 840 R / 303 R from Phobos → 42.4°; Jupiter 406 R / 27 R from Ganymede → 7.7°). It
  barely parallaxes as you orbit (correct) and recedes naturally as you pull back. Far plane + zoom-out
  range now scale to the system size (`_sceneFar`, per-body `_distMax`). The old parent scene-zoom hack
  is gone.
- **Real orbit rings.** New **"Orbital plane"** sky toggle. Each moon's orbit is a true-radius circle
  centred on its primary, passing through the moon — so zoomed in it reads as the plane edge-on through
  the body, and zoomed out it's a clean circle with the planet at its centre (fixes "Ganymede's orbit
  doesn't look right"). `Cel.orbitNormal()` derives the plane from the primary's IAU pole / the body's
  heliocentric elements; globe bodies draw it as an ecliptic-style great circle.
- **Deimos added as a sibling moon.** Loads the NASA mesh the user supplied (`data/models/24879_Deimos…glb`)
  and draws it in the Phobos scene at its true position on its real orbit, Sun-lit, **with its own orbit
  ring and axis rotation** — same functionality as Phobos/Mars. Pulled back, the Phobos view shows the
  whole Martian system: Mars centre, Phobos on the inner (teal) orbit, Deimos on the outer (blue) orbit.
  True apparent size is a sub-0.05° speck, so its on-screen size is floored for visibility (distance +
  direction stay true). Config via a `siblings` array — extensible to the Galilean moons for Ganymede.
- **Data-driven rotation.** `data/rotation.json` is the auditable matrix of sidereal periods, spin sense
  and IAU poles; added Jupiter's IAU elements to `celestial.js`. "Rotate on axis" now spins the moon,
  its primary, and sibling moons each on their **real pole at their true relative rate** (Mars 3.2× slower
  than Phobos; Jupiter 17× faster than Ganymede; all prograde, poles within ~0.05°).
- **Sun true-to-scale.** The Sun is sized by its real angular diameter per world (Earth/Moon ~0.53°,
  Mars/Phobos ~0.35°, Ganymede ~0.10°) in both renderers — ~5× smaller from Ganymede than from Earth.
- **Planet night-side + Mars-visibility.** Soft terminator + raised night floor on the planet shader, so a
  "new"-phase primary reads as a dim silhouetted disc, not a void (Mars cycles through phases every 7.65 h
  from Phobos — it wasn't a bug, just near-"new").
- **Snapshot + video capture.** A **camera button** (PNG) and a **video button** (5-second clip) stack
  under the +/- control on both renderers (`preserveDrawingBuffer` enabled; globe repaints are pumped so
  `captureStream` gets frames). Clips record **MP4/H.264 where the browser supports it** (Safari, recent
  Chrome), falling back to WebM/VP9 — the format AI editors want, no transcoder. Snapshots compose in
  **Display-P3** and export a tagged, wide-gamut PNG with a gentle saturation/contrast lift so they match
  the screen instead of reading flat. Space backdrop gradient baked in so sky-off shots aren't flat black.
- **Earth spin direction fixed.** Both the home-page hero globe and the playground spun **retrograde**
  (increasing centre longitude scrolls the surface west); flipped both to prograde (surface drifts east),
  verified against North America.
- **UI polish.** Dark-themed the zoom/compass/snapshot controls (black panels, white icons); nav labels
  **"Product" → "Maps"** and **"Developers" → "Documentation"**; tightened the landing-nav padding so the
  logo/CTA align with the content below; the Developers sidebar's right divider now spans full height even
  with every group collapsed; camera icon sized to match the +/- glyphs.
- **Docs:** new **`docs/api-keys-plan.md`** — simplest path for metered API keys: GitHub Pages for
  everything static, Railway only for the one dynamic piece (the `/v1` gateway, since `serve.mjs` already
  runs there unchanged); Phase 1 issues keys with a local mint script, no backend. Nothing left to generate
  keys today — the gateway only validates/meters, so that's the open build item.

## 2026-11-15 (later) — Named features + one marker everywhere + scene zoom (post-v1)

**Uncommitted follow-ups on top of v1 (`0fce660`, not yet pushed). All verified in-browser.**

- **Named features on Mars & the Moon.** Curated IAU/USGS nomenclature bundled as
  `data/{mars,moon}-nomenclature.geojson` (18/19 features: Olympus Mons, Valles Marineris, the Tharsis
  Montes, Hellas/Argyre/…, the maria, Tycho, Copernicus, Apollo 11, …), registered in the manifest with
  IAU/USGS attribution so they're license-tagged + probe-gated. On by default; coords verified against
  the basemaps (labels land on the right craters/volcanoes).
- **One marker component across ALL bodies.** Dropped the globe's MapLibre symbol/circle/pill-image
  layers entirely; the globe now renders each named feature with `maplibregl.Marker` wrapping the **same
  DOM pin** (`.gv-shape-pin`/`.gv-shape-label`/`.gv-shape-dot`) the mesh uses. So a marker is pixel-for-
  pixel identical on Earth/Moon/Mars globes and the Phobos/Ganymede meshes — same dark pill, round blue
  dot, font, glow, and far-side hiding (`opacityWhenCovered:'0'`).
- **Consistent interactivity.** Globe pins are now interactive like the mesh: identical `:hover` (label
  turns accent-blue) and a click action. Both renderers route clicks through **one shared
  `focusFeature()`** — today it zooms to the marker; a details popup/modal later is a few lines there and
  applies everywhere at once.
- **Labels are contextual + unified control.** The single **Feature labels** toggle drives named-feature
  markers on every body; Earth's country labels never bleed onto Moon/Mars. (`GlobeMap.setLabels` and the
  playground's `apply()` made label visibility context-aware.)
- **Mesh navigation + scene zoom.** Added a MapLibre-styled **+/- control** to the mesh scene
  (`ShapeModel.zoomBy`, eased), and the parent planet now **scales with the zoom** — zooming out from a
  moon also zooms out from Mars/Jupiter, so the whole scene zooms together.
- **Rename + housekeeping:** base-layer id `gv-base-open` → `base-open`; `keys.json`/`leads/` untracked.
- **Bugs fixed:** feature stems hid with labels; a `display:''` that silently dropped the mesh pin's
  flex layout (collapsing the dot into a sliver); the leftover green dot-glow unified to the blue accent.

## 2026-11-15 — v1: parent planets, contact form, labels toggle, sidebar collapse

**Tagging v1. Everything below shipped and was verified in-browser today.**

- **Parent planet in a moon's sky.** `ShapeModel` now draws the primary a moon orbits — **Mars over Phobos,
  Jupiter over Ganymede** — as a Sun-lit globe pinned over the sub-primary point at its true apparent size
  (Mars fills ~42°, Jupiter ~7.7°), occluded by the moon's near side as you orbit. New `progPlanet` shader +
  UV sphere; Sun direction from `Cel.sunDirForBody` (extended to phobos/ganymede). Soft terminator, ambient
  floor so the night side reads as a dim disc. The initial camera now aims at the parent so it's framed on
  load (was hiding behind the far side).
- **Real Mars texture.** Stitched the Viking colour mosaic from `trek.nasa.gov` (the same NASA source the
  globe streams) into `data/textures/mars.jpg` (2048×1024); the planet shader samples it equirectangularly.
  Jupiter stays procedural bands (no cleanly-licensed PD map found).
- **Consistent framing on load** across all five bodies (globe zoom ↔ mesh camera distance tuned to match).
- **Feature-labels toggle — new SDK capability, both renderers.** `ShapeModel.setLabels()` hides/shows the
  named feature pins; `GlobeMap.setLabels()` toggles every symbol (text) layer and stays sticky for layers
  added later. Playground has one "Feature labels" checkbox wired to whichever renderer is active (the
  playground globe is raw MapLibre, so it toggles symbol layers directly). Verified on Earth (country labels)
  and Phobos (5 pins).
- **Playground sidebar collapse/expand**, chat-app style: a panel button by the title collapses the grid
  column to 0; a floating button over the stage brings it back; MapLibre refits; the HUD shifts clear.
- **Contact form, rebuilt for static hosting.** Decision (with user): host on **GitHub Pages** (free, custom
  domain via CNAME), so the form posts to **Web3Forms** (no server) → emails **hello@sorcery.llc**, subject
  leads with the enquiry type. On success it redirects to a branded **`/thanks`** page (`thanks.html`;
  `serve.mjs` now resolves clean URLs locally). Added **inline validation** (name/email/message with real
  messages + focus), a **honeypot**, and a hidden **`enquiry_type`** field set from each CTA's `data-cta`
  ("Enterprise" vs "General") so both CTAs share one dialog but each lead says where it came from. The old
  Zoho-SMTP server path (`api/contact.js`, `mailer.mjs`, `serve.mjs`'s `/api/contact`) is kept as a
  self-host alternative, unused by the Pages deploy.
- **Security/hygiene:** `keys.json` and `leads/enterprise.jsonl` git-untracked and added to `.gitignore` +
  `.vercelignore` (a static host would otherwise serve them).
- **Rename:** base-layer id `gv-base-open` → `base-open` across the repo (dropping the legacy GlobalVibe
  prefix from the public API/snippet).

## 2026-11-14 (later) — Drape-your-own-data on meshes (unify step 2)

**Shipped — `addUserLayer` now works on mesh bodies, like the globe.**
- **Shared parser:** extracted GeoJSON/KML/GPX parsing + `bounds()` into **`src/vectorparse.js`**; both
  `src/maps.js` (GlobeMap) and `src/shapemodel.js` import it — one reader for every surface. `maps.js`'s
  local copies removed (regression-checked: sdk-demo BYO still drapes the bundled countries GeoJSON).
- **`src/shapemodel.js`** gained `addUserLayer / removeUserLayer / userLayers`. GeoJSON (object / File /
  URL, incl. KML/GPX) is draped onto the real surface: lines/polygon-outlines are densified and each
  vertex projected to the mesh via the dir→radius grid; points become round sprites. Depth-tested, so the
  body occludes the far side. Coords read as the body's planetographic lon/lat; optional fit flies to the
  centroid. Colour configurable (`toRgb`), default emerald.
- **Playground:** shape-mode controls now have a "Your data" block — a file picker, "Drape sample data"
  (a demo box + traverse + points), and "Clear". Note updated (sky + your-own-data work on meshes now).
- **Verified in-browser:** sample GeoJSON drapes on Phobos and hugs the terrain, occluded correctly;
  globe BYO unregressed. No console errors.
- **Polygon fill ✅ (follow-up, done):** `_fillPolygon` tessellates the polygon's lon/lat bbox into a grid,
  keeps cells whose centre is inside via even-odd ray-casting over all rings (so **concave shapes + holes**
  work), and projects each cell to the mesh as two translucent triangles under the outline, depth-tested so
  the far side is occluded. Layer lifts raised (fill 1.012 / lines 1.018 / points 1.024) so the fill clears
  Phobos's local relief instead of craters poking through. Verified on Phobos — clean translucent fill, terrain
  visible through it. (Fill follows the smoothed dir→radius grid, not the exact mesh; fine at these lifts.)
- **Still open:** raster/image overlays on meshes.

## 2026-11-14 (later) — Celestial sky on the mesh bodies (unify step 1)

**Decision (with user):** the SDK is heading toward a **unified surface model** — a body is a surface
(sphere OR mesh) and data drapes the same way on all of them. First capability ported to the mesh
renderer: the **celestial sky**.

**Shipped — the real sky now works on Ganymede & Phobos, like Moon/Mars:**
- **Shared orientation** moved into `src/celestial.js`: exported `iauElements(body,d,T)` (earth/moon/mars
  + **ganymede/phobos** IAU poles) and `celestialToBody()`. `src/starfield.js` (globe sky) refactored to
  consume them — one source of truth, no behaviour change. Also extended `observerHelio`/`skyBodies` so
  the Sun/planets are placed from Ganymede (≈ Jupiter) and Phobos (≈ Mars), skipping each moon's primary.
- **`src/shapemodel.js`** gained a full sky: `addStarfield/removeStarfield/setSkyTime/setSkyFlag`. Stars
  (B-V colour, mag size), Milky Way, constellations, RA/Dec grid, ecliptic, Sun/planets — all built from
  the shared engine, oriented to the body's pole, drawn as an infinity **skybox** (view rotation only, no
  parallax) that the opaque body **occludes** via the depth buffer. New star point-sprite shader.
- **`src/poc.js`**: the "Show the sky" toggle + sub-options now work on shape bodies. `attachSky()` routes
  to `map` (globe) or `shapeModel.addStarfield` (mesh); sky survives globe↔mesh and mesh↔mesh switches.
- **Bugs found & fixed in-browser:** unset `u_alpha` (stars invisible); transparent canvas washing out
  additive glow → clear to opaque black when the sky is on.
- **Verified:** Phobos ✓, Ganymede ✓ (different pole + Jupiter sun), Earth globe ✓ (no regression from the
  starfield refactor). No console errors.

**Not ported (honest scope):** the day/night **terminator** on the mesh (sun-lit shading) and sky **labels**
— follow-ups. Globe-only map features (tiles, projection, overlays, particles, draw, place search) remain
globe-only by nature. Next unify capability per the user's pick after the sky: drape-your-own-data on meshes.

## 2026-11-14

### Shipped — Apple-blue accent, collapsible dev groups, social image

- **Accent → Apple system blue.** User rejected the green (too bright) and a turquoise trial; settled on
  Apple dark-mode blue. `--gv-accent: #0a84ff`, `--gv-accent-hi: #409cff`, `--gv-accent-btn: #0a84ff`,
  `--gv-ink-on-accent: #fff` (white button text, Apple-style), aurora gradient now starts blue. Cohesive
  with the blue Earth. `design/tokens.css` only (cascades everywhere via the accent tokens).
- **Developers sidebar groups collapse/expand** (NOT a full accordion — kept the master-detail layout and
  detail panel exactly as before). Each group heading is a `<details>`/`<summary>` with an **animated +/−**
  (vertical bar rotates into the horizontal = minus) instead of a chevron. `src/site.js` `renderDevNav`
  (collapsible groups) + `index.html` CSS. Open by default.
- **Social preview image.** `og-image.png` (1200×630): logo + wordmark + "Build planetary maps for any
  world" + tagline + "No key · No signup · Open source", blue accent, globe wireframe motif. Built from an
  SVG via `rsvg-convert`. OG + Twitter meta tags in `index.html` head (og:image relative — set absolute in
  production).

### Strategy note — monetization, object catalog, API keys (discussion)

**Model = open-core + hosted services** (already in the pricing section). The moat IS "no key,
self-hostable, license-clear" — monetization must not break that for free/self-host users.
- **Open catalog (free, keyless):** the manifest/`catalog.json` of self-hostable, license-clear objects
  (Natural Earth, NASA public-domain imagery, the glTF shape models). Growth + credibility engine.
- **Hosted/premium catalog (paid, metered):** pre-cut high-res tiles on a CDN, curated/cleared commercial
  datasets, more bodies/models, time-series pipelines, SLA → Team (usage-based) + Enterprise (support,
  private deploy, license-clean builds). Also feeds the MCP server (agents query license-clear layers).
- **API key? Self-host = NO (the whole point). Hosted services = YES**, and the infra already exists:
  `keys.mjs` + `keys.json` (`gv_pk_…` public keys) + the `/v1` gateway with per-key metering
  (`/v1/tiles`, `/v1/usage`). The key is a billing boundary on *our servers*, never a gate on the software.
- **Proposed next step:** formalize `catalog.json` (extend the manifest): per-object id, kind
  (body/basemap/overlay/dem/model), provenance, license, commercial flag, hosted-vs-bundled, tier. Open
  entries free/self-host; hosted entries require a `gv_pk` key via `/v1`. Not yet built.

### Shipped — softer CTA green

The solid green CTAs (`.gv-btn--solid`, e.g. "Open the playground", "Contact sales", "Open in
playground") were neon `--gv-accent` (#22c55e) filling large slabs and glared on the dark page (and
*brightened* to #4ade80 on hover). Added `--gv-accent-btn` (#15924a) / `--gv-accent-btn-hi` (#1aa957)
and pointed the solid fill + outline-hover fill at them; kept dark ink label (≈4.9:1 AA). Bright
`--gv-accent` stays for thin accents (links, labels, tab underline). `design/tokens.css` only.
Not touched: the in-app **selected-toggle** green (playground body/projection buttons, selected tabs)
still uses the bright accent — tone those too if they also read as harsh.

### Accounting — session ledger & documentation status

Everything shipped this session and where it's documented:

| Deliverable | Code / assets | Documented in |
|---|---|---|
| `package.json` reconstruction | `package.json` | tracker |
| Full-width nav (all 3 tabs) | `design/tokens.css` (`.gv-nav .gv-wrap`) | tracker |
| **Irregular bodies — `ShapeModel`** | `src/shapemodel.js`, `shapes.html`, `data/models/*.glb`, export in `src/maps.js` | **README** (parts table + "Irregular bodies" subsection), **handoff** (one-liner, dir map, concepts, §2.2 API, quick ref), **features.json** ("Irregular bodies" feature → `shapes.html` demo), tracker |
| Ganymede & Phobos in the **playground** | `src/poc.js`, `playground.html` | handoff (concepts note), features.json, tracker |
| Gesture consistency + Ganymede IAU calibration | `src/shapemodel.js`, `src/poc.js`, `shapes.html` | tracker |
| R·D logo in nav | `design/logo.png`, `index.html`, `design/tokens.css`; lab at `design/logo.html` | tracker |
| Favicon set | `favicon.ico`, `favicon-16/32.png`, `apple-touch-icon.png`, `icon-192/512.png`, `site.webmanifest`; links in all page heads; MIME in `serve.mjs` | tracker |

**Doc audit result:** README ✅ and handoff ✅ now both cover the shape-model renderer / irregular
bodies (handoff was stale — updated this pass: §1.1, §1.2 dir map, §1.3 concepts, §2.2 `ShapeModel`
API block, §6 quick reference). features.json has the feature. Logo/favicon are site chrome — tracked
here, intentionally not in README/handoff. **Open:** og/social preview image (not built).

### Done today

- **Reconstructed `package.json`** — the original was deleted (not `package-lock.json` as intended).
  The lockfile was empty (`"packages": {}`), so nothing could be recovered from it. Rebuilt from the
  source instead: scanned every import → **100% Node built-ins, zero third-party deps**, matching the
  README's "no install, no build step." Result is metadata + run scripts only (`start`/`serve`/`mcp`),
  `type: module`, `engines.node >=18`. Validated as JSON.
- **Nav bar full-width** — the sticky site nav was boxed into the centered 1200px content band, so on
  wide screens it floated in the middle while views below went edge-to-edge. Added `max-width: none`
  to `.gv-nav .gv-wrap` in `design/tokens.css` so the nav spans 100% width **consistently on all three
  tabs** (Product / Developers / Playground). Verified in-browser on each tab. Rolled back an earlier
  over-scoped attempt (a playground-only slim bar) — single global rule now.

### Shipped — R·D monogram logo ✅ (2026-11-14, latest)

Added an **R·D monogram** to the left of "Rendered Data" in the nav. Took several tries to read the
reference (`~/Downloads/rd-logo.jpg`) right:
1. Hand-drawn solid-D + knocked-out-R paths — rejected ("looks awful").
2. Real font glyphs (Inter Tight 900 R in front of D) — rejected ("doesn't look like the example; the R
   is not black"). The reference is **not** two overlapped font glyphs.
3. **Final:** the reference is a **geometric monogram** — a shared vertical stem, the R's bowl *closed by
   the D's own outer curve* with its counter as a negative-space slot, a straight diagonal leg, and the
   **D = the shared outer curve**. Rebuilt it as clean stroke-based SVG paths (one weight, thin
   negative-space channels), confirmed against the reference side-by-side in `design/logo.html` (ref
   image copied to `design/rd-logo-reference.jpg`).

**Final asset:** the user supplied their finished monogram — first as `design/logo.png`, then as a clean
**vector** (`design/logo.svg`, single path, 325×424). The nav now **inlines the SVG** in `.gv-logo`
(`index.html`) with `fill="currentColor"` so it's crisp at any size and inherits the ink colour (white on
the dark nav); sized 26px via `.gv-logo-mark` in `design/tokens.css`. The PNG was deleted. (Earlier
exploratory SVG monograms + white badge were dropped in favour of the user's own art.)

Then dropped the badge for a plain white monogram, and finally swapped in the user's own PNG
(`design/logo.png`) at 28px — `<img>` in `.gv-logo`.

**Favicon ✅:** now generated from the **vector** via `rsvg-convert` (crisper per-size). Root
`favicon.svg` (dark `#080b0e` rounded square + white mark) is the primary icon for modern browsers;
plus `favicon.ico` (16/32/48), `favicon-16/32.png`, `apple-touch-icon.png` (180, square for iOS),
`icon-192/512.png`, and `site.webmanifest`. Heads link the SVG first, then `.ico`/png fallbacks, on
every page. `.png/.ico/.webmanifest/.svg` MIME types in `serve.mjs`. All serve 200. og/social image
still open if wanted.

### Shipped — Gesture consistency + Ganymede calibration ✅ (2026-11-14, later still)

- **Drag gestures now match the MapLibre globe.** The shape renderer's vertical drag was inverted
  (orbit-camera style); fixed to "grab the surface" — `pitch += dy` in `src/shapemodel.js` so dragging
  down tips the north/top into view, exactly like Mars. Verified side-by-side in-browser: on Mars,
  drag-down took the camera 0°→73°N and drag-right moved the centre west; Phobos now does the same
  (north pole rotates up on drag-down; Stickney/Limtoc move right on drag-right). Horizontal (`yaw -= dx`)
  was already correct.
- **Auto-rotate off in the playground** (`autorotate: false` in `poc.js` enterShape) so shape bodies
  behave like the static globe bodies there; the standalone `shapes.html` showcase keeps its spin.
- **Ganymede feature pins calibrated** against the IAU Gazetteer (planetographic, +West) instead of my
  earlier guesses: Galileo Regio 45°N/127°W (was 35/150), Osiris −38/166.3, Tros 11/27.3. Convention
  confirmed (northAxis y, lonDir +1, lon0 0): Galileo Regio's pin sits at its catalog centre on the dark
  ancient terrain; Osiris lands in the southern bright-ray region. Phobos was already verified. Synced
  in both `src/poc.js` and `shapes.html`.
  - Honest limit: Ganymede pins are now authoritative-coordinate-accurate, but I can't ground-truth them
    to sub-degree by eye (no pixel overlay); Galileo Regio is 4439 km across (~96° of arc) so it sprawls
    around its centre pin.

**Follow-up:** the two shape bodies' config (model/radii/features/calibration) is duplicated in
`src/poc.js` and `shapes.html` — worth hoisting into one shared module (e.g. `src/shapebodies.js`) so
calibration can't drift between the playground and the demo.

### Shipped — Ganymede & Phobos wired into the playground ✅ (2026-11-14, later)

The two shape bodies are now selectable in `playground.html` itself, alongside Earth/Moon/Mars. On
selecting one, `src/poc.js` hides the MapLibre canvas and swaps in a `ShapeModel` on a `#shape`
canvas; the side controls switch to shape mode (projection → "N/A", basemap → "NASA shape model",
overlays → graticule toggle + dimensions, Jump-to → feature fly-tos, sky toggle disabled), the HUD
reports the WebGL renderer + model-load time, and the camera panel shows the physical readout.
Switching back to a globe body tears the ShapeModel down and restores MapLibre.

Verified in-browser (no console errors): Earth→Phobos→Ganymede→Earth round-trips cleanly, shape↔shape
switches, and the `?body=phobos` deep link opens straight into shape mode. Files touched: `src/poc.js`
(SHAPE config, isShape, enterShape/exitShape, renderShapeControls, HUD + deep-link guards),
`playground.html` (`#shape` container + pin CSS).

**Follow-up ideas:** feature-pin calibration for Ganymede; a shaded-relief overlay from mesh radius;
optionally surface the playground deep links from the Developers feature too.

### Shipped — SDK enhancement: irregular (non-spherical) bodies ✅

Working end-to-end and verified in-browser (no console errors). Phobos renders as a genuinely
irregular mesh with the NASA texture, a geometry-derived graticule draped over the real lumps, and
feature pins that cull on the far side; calibration confirmed against real geography (**Stickney on
the giant crater, Limtoc beside it, Hall at the south pole**). Ganymede renders round and textured.
`shapes.html` demo + a "Irregular bodies" Developers feature (with an "Open the live demo" button)
are live. See the detail below.

### (history) SDK enhancement: irregular (non-spherical) bodies

**Goal:** show the mapping engine is not limited to spheres. Ganymede = a big round world; **Phobos =
the irregular-shape showcase** (~27×22×18 km lump, Stickney crater nearly half its width).

**Key architectural finding:** `GlobeMap` (src/maps.js) draws every world on MapLibre's mathematical
sphere — you cannot put a lumpy mesh on it. Both NASA assets are **glTF meshes**, so the right move is
one new capability: a second, smaller renderer that draws the actual shape model, with map data draped
on the real surface.

**Decisions locked in (with the user):**
- Render engine: **dependency-free WebGL** (no three.js) — write our own `.glb` loader + renderer, to
  keep the project's self-hosted / "read every line" ethos.
- Map overlay scope: **lon/lat graticule + named feature pins** (e.g. Stickney), not just the bare model.

**Data pulled** (NASA, free to use, committed under `data/models/`):
| Body | File | Size | Source | Shape |
|---|---|---|---|---|
| Ganymede | `ganymede.glb` | 3.9 MB | assets.science.nasa.gov (`Ganymede_1_5268.glb`) | near-sphere, r≈2634 km |
| Phobos | `phobos.glb` | 3.7 MB | assets.science.nasa.gov (`24878_Phobos_1_1000.glb`) | irregular, ~27×22×18 km |

- Both are single-mesh triangle glTF 2.0 with POSITION/NORMAL/TEXCOORD_0 + one embedded PNG baseColor.
- Ganymede texture: clean 2:1 equirectangular. Phobos texture: a **custom atlas** (equirect panel +
  two circular polar insets) → confirms graticule/pins must come from mesh **geometry**, not the texture.

**Built so far:**
- [x] `src/shapemodel.js` — dependency-free `.glb` parser (container + accessors + embedded texture),
  WebGL renderer (textured mesh, directional + ambient light), orbit/zoom/auto-spin, a geometry-derived
  lon/lat graticule draped on the surface via a dir→radius grid, DOM feature pins with a far-side cull,
  and a small column-major mat4 lib. Exports `ShapeModel`.

**Done:**
- [x] Hardened `parseGLB` accessor reads against typed-array byte-alignment; cleaned dead graticule code.
- [x] Exported `ShapeModel` from `src/maps.js` (public SDK surface).
- [x] Built `shapes.html` (sibling demo): Ganymede ⇄ Phobos toggle, graticule toggle, clickable feature
  list + lon/lat readout, SDK-call log — house style.
- [x] **Calibrated** Phobos (`northAxis:'y'`, `lon0:0`, `lonDir:-1`, west-positive) — Stickney/Limtoc/Hall
  verified against real geography in-browser.
- [x] Added a Developers feature entry ("Irregular bodies: 3D shape models") with a `demo` link to
  `shapes.html`; made the status chip `demo`-aware ("Live demo" vs "Live in playground").
- [x] README subsection + parts-table rows (`src/shapemodel.js`, `shapes.html`, `data/models/`).
- [x] `.glb`/`.usdz` MIME types added to `serve.mjs`.

**Deliberately skipped / follow-ups:**
- Did **not** add the two GLBs to `manifest.json`: `GlobeMap._boot()` probes every manifest entry with a
  full GET, so that would download ~8 MB of models on every *globe* page load. Provenance is instead
  documented in `shapes.html`, the README and the feature entry; `ShapeModel` runs its own probe.
- Ganymede feature coordinates (Galileo Regio / Osiris / Tros) are approximate — not calibration-verified
  the way Phobos was. Worth a pass if we lean on Ganymede features.
- Possible next: wire these as selectable "bodies" inside the playground (swap the MapLibre canvas for the
  ShapeModel canvas), and a shaded-relief/elevation overlay from the mesh radius itself.

### Open question (raised, not yet actioned) — NASA *Eyes on the Solar System*

User asked what we can borrow from https://eyes.nasa.gov/apps/solar-system/ (models, tiles, orbit
data) while staying open-source, ideally reverse-engineering how it gets object data.

**Position to discuss before acting:** steer toward the **documented, license-clear open sources** that
Eyes itself is built on rather than scraping its private app endpoints — scraping undocumented
endpoints conflicts with this project's whole "license-clear, read every line, probe every source"
principle (and raises ToS questions). Clean equivalents:
- **Orbits / ephemerides:** JPL Horizons API + SPICE/NAIF kernels (public, documented). Best path to
  real orbit data.
- **Models:** NASA 3D Resources (already using for Ganymede/Phobos).
- **Imagery tiles:** NASA Trek (already wired), USGS Astrogeology, NASA GIBS.

Decision pending from user on scope/approach.

---

## Conventions for this file

- Date-stamped sections, newest on top. Convert relative dates to absolute (today = 2026-11-14).
- `[x]`/`[ ]` checkboxes for the active workstream so the next session can resume fast.
