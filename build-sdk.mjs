// build-sdk.mjs — assemble the downloadable, self-hostable Rendered Data Maps SDK bundle.
//
// The SDK is a library, NOT the whole site: it is src/maps.js (which exports GlobeMap, ShapeModel,
// maplibregl) plus the exact files it loads at runtime. This script copies that minimal tree into
// dist/rendereddata-maps-sdk/ — preserving the layout the module-relative loader expects (manifest,
// data, fonts and vendor as siblings of src/) — writes a bundle README and a standalone example page,
// and zips it. Re-run it after code changes so the download never goes stale. Node built-ins only.
//
//   node build-sdk.mjs
//
// Output: dist/rendereddata-maps-sdk/            (the bundle, ready to serve on any static host)
//         dist/rendereddata-maps-sdk-<ver>.zip   (the same, zipped — the download artifact)

import {cp, mkdir, rm, writeFile, readFile, stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const execFileP = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version || '0.0.0';
const NAME = 'rendereddata-maps-sdk';
const OUT = join(ROOT, 'dist', NAME);
// Stable, un-versioned zip name so the download link is a fixed URL: the Pages deploy copies this to the
// site root and the button links to it relatively as /rendereddata-maps-sdk.zip. (The version lives in
// the bundle's own README.md and in package.json.)
const ZIP = join(ROOT, 'dist', `${NAME}.zip`);

// The import graph + runtime loads, from the packaging audit. REQUIRED = the core path (an Earth globe
// with the bundled base, borders, place search and labels, fully offline). OPTIONAL = extra features:
// the celestial sky's body textures, the ShapeModel renderer's meshes, and the probe-only data files.
const REQUIRED = [
    'manifest.json',
    'src/maps.js', 'src/eqproj.js', 'src/rasterformats.js', 'src/celestial.js',
    'src/starfield.js', 'src/shapemodel.js', 'src/vectorparse.js',
    'vendor/maplibre-gl/maplibre-gl.mjs', 'vendor/maplibre-gl/maplibre-gl-worker.mjs',
    'vendor/maplibre-gl/maplibre-gl.css', 'vendor/maplibre-gl/LICENSE.txt',
    'data/ne_110m_admin_0_countries.geojson',
    'fonts/OFL.txt',
    'fonts/Noto Sans Regular/0-255.pbf', 'fonts/Noto Sans Regular/256-511.pbf',
    'fonts/Noto Sans Regular/512-767.pbf', 'fonts/Noto Sans Regular/768-1023.pbf',
    'fonts/Noto Sans Regular/1024-1279.pbf',
    'LICENSE',
];
const OPTIONAL = [
    // celestial sky body discs (addStarfield)
    'data/textures/earth.jpg', 'data/textures/moon.jpg', 'data/textures/mars.jpg',
    'data/textures/jupiter.jpg', 'data/textures/CREDITS.txt',
    // ShapeModel irregular bodies (NASA glTF) — note: the .usdz AR file is NOT used by the web SDK
    'data/models/phobos.glb', 'data/models/ganymede.glb', 'data/models/24879_Deimos_1_1000.glb',
    // probed-at-boot data (absent → a 'fail' probe, never breaks boot) + mesh feature names
    'data/stars.json', 'data/mars-nomenclature.geojson', 'data/moon-nomenclature.geojson',
    'data/rotation.json',
];

const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

async function copyList(list, {required}) {
    let total = 0, missing = [];
    for (const rel of list) {
        const srcPath = join(ROOT, rel);
        if (!existsSync(srcPath)) { missing.push(rel); continue; }
        await mkdir(dirname(join(OUT, rel)), {recursive: true});
        await cp(srcPath, join(OUT, rel));
        total += (await stat(srcPath)).size;
    }
    if (required && missing.length) {
        throw new Error(`Missing REQUIRED bundle files:\n  ${missing.join('\n  ')}`);
    }
    if (missing.length) console.warn(`  (skipped ${missing.length} optional file(s) not on disk: ${missing.join(', ')})`);
    return total;
}

const EXAMPLE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rendered Data Maps — SDK example</title>
<link rel="stylesheet" href="vendor/maplibre-gl/maplibre-gl.css">
<style>
  html, body { margin: 0; height: 100%; background: #05070d; }
  #map { position: absolute; inset: 0; }
</style>
</head>
<body>
<div id="map"></div>
<script type="module">
  // One import. One object. Everything else is a method call.
  import {GlobeMap} from './src/maps.js';

  const map = new GlobeMap({container: 'map', body: 'earth', base: 'base-open'});
  await map.ready;                       // manifest loaded, probes run, globe drawn

  // Switch worlds: ['earth','moon','mars'] — see README. Uncomment to try:
  // await map.setBody('mars', {base: 'mars-viking'});

  // Real astronomical sky for the current time:
  // map.addStarfield({constellations: true});
</script>
</body>
</html>
`;

const README = `# Rendered Data Maps — SDK bundle (v${VERSION})

A dependency-free, self-hostable maps SDK. No build step, no install step, no API key, no account.
This folder is the **library only** — not the marketing site. Drop it on any static host (or beside
your own app) and \`import {GlobeMap} from './src/maps.js'\`.

## Run the example

It must be served over HTTP (ES modules + \`fetch\` do not work from \`file://\`). Any static server:

\`\`\`
npx serve .      # or: python3 -m http.server
\`\`\`

Then open \`example.html\`.

## Use it

\`\`\`js
import {GlobeMap} from './src/maps.js';

const map = new GlobeMap({container: 'map', body: 'earth', base: 'base-open'});
await map.ready;
await map.setBody('mars', {base: 'mars-viking'});
\`\`\`

## Available bodies

- \`GlobeMap\` (round worlds): **earth, moon, mars**. \`map.bodies\`, \`map.basesFor(id)\`,
  \`map.overlaysFor(id)\` enumerate them at runtime.
- \`ShapeModel\` (irregular worlds): any NASA glTF \`.glb\` — bundled: \`data/models/phobos.glb\`,
  \`ganymede.glb\`, \`24879_Deimos_1_1000.glb\`.

Full API reference: see the project README.

## Layout — keep it intact

The loader resolves bundled assets relative to \`src/maps.js\`. **\`manifest.json\`, \`data/\`, \`fonts/\`
and \`vendor/\` must stay as siblings of \`src/\`.** You can host the whole folder at any sub-path
(e.g. \`https://cdn.example.com/rdm/\`); just serve the \`.mjs\`, \`.pbf\` and \`.geojson\` files with
permissive CORS if it is a different origin from your page.

## What needs the network

Offline out of the box: the Earth \`base-open\` basemap, country borders, place search, labels.
Over the network (third-party, probed live before they draw): Blue Marble / Sentinel-2 / VIIRS
imagery, hillshade & 3D terrain, OSM streets, live earthquakes, and the Moon/Mars NASA Trek mosaics.

## License

This SDK: see \`LICENSE\`. Vendored renderer: MapLibre GL JS, BSD-3-Clause (\`vendor/maplibre-gl/LICENSE.txt\`).
Fonts: Noto Sans, SIL OFL (\`fonts/OFL.txt\`). Bundled textures: see \`data/textures/CREDITS.txt\`.
`;

// ---- build ---------------------------------------------------------------
console.log(`Building ${NAME} v${VERSION} …`);
await rm(join(ROOT, 'dist'), {recursive: true, force: true});
await mkdir(OUT, {recursive: true});

const reqBytes = await copyList(REQUIRED, {required: true});
const optBytes = await copyList(OPTIONAL, {required: false});
await writeFile(join(OUT, 'example.html'), EXAMPLE);
await writeFile(join(OUT, 'README.md'), README);

console.log(`  core files:     ${bytes(reqBytes)}`);
console.log(`  optional files: ${bytes(optBytes)}`);

// Zip it (uses the system `zip`, present on macOS/Linux). If absent, leave the folder.
try {
    await execFileP('zip', ['-rq', ZIP, NAME], {cwd: join(ROOT, 'dist')});
    console.log(`  zipped:         dist/${NAME}.zip (${bytes((await stat(ZIP)).size)})`);
} catch {
    console.warn('  (zip CLI not found — bundle folder written, skipped the .zip)');
}
console.log(`Done → dist/${NAME}/`);
