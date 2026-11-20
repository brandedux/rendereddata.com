#!/usr/bin/env node
// Generate catalog.json — the license-clear object catalog — from manifest.json (the live data
// sources) plus the bundled glTF shape models (which are deliberately NOT in the manifest, because
// GlobeMap probes every manifest entry on load and that would pull ~8 MB of meshes on every globe
// page). This is the "open catalog" from the monetization notes: every object here is self-hostable
// and license-clear. The metering boundary is marked per object (`metered` / `v1_tileset`) — those
// are the same sources the hosted /v1 gateway can proxy; a future hosted/premium tier (pre-cut CDN
// tiles, curated commercial datasets) would be added here with tier: "hosted".
//
//   node scripts/build-catalog.mjs          # writes catalog.json
//   node scripts/build-catalog.mjs --check   # verify catalog.json is up to date (CI/pre-commit)
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {TILESETS} from '../keys.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// id → "{body}/{tileset}" for the sources the /v1 gateway meters (inverse of keys.mjs TILESETS).
const METERED = Object.fromEntries(Object.entries(TILESETS).map(([path, id]) => [id, path]));

// The bundled NASA shape models — license-clear objects that live outside the manifest (see above).
// Provenance is tracked in shapes.html / README / docs/tracker.md.
const MODELS = [
    {id: 'model-ganymede', label: 'Ganymede shape model (NASA)', body: 'ganymede', file: 'data/models/ganymede.glb',
        source: 'NASA 3D Resources (Ganymede_1_5268.glb)'},
    {id: 'model-phobos', label: 'Phobos shape model (NASA)', body: 'phobos', file: 'data/models/phobos.glb',
        source: 'NASA 3D Resources (24878_Phobos_1_1000.glb)'},
    {id: 'model-deimos', label: 'Deimos shape model (NASA)', body: 'deimos', file: 'data/models/24879_Deimos_1_1000.glb',
        source: 'NASA 3D Resources (24879_Deimos_1_1000.glb)'}
];

function catalogObject(e) {
    const v1 = METERED[e.id];
    return {
        id: e.id,
        label: e.label,
        kind: e.kind,
        body: e.body,
        access: e.hosted === 'bundled' ? 'bundled' : 'third-party',   // where the open source lives
        tier: 'open',                                                  // all current objects are self-hostable
        metered: Boolean(v1),                                          // also proxiable via the hosted /v1 gateway
        ...(v1 ? {v1_tileset: v1} : {}),
        license: e.license,
        provenance: e.attribution || e.license,
        commercial: e.commercial,
        share_alike: Boolean(e.share_alike)
    };
}

function modelObject(m) {
    return {
        id: m.id, label: m.label, kind: 'model', body: m.body,
        access: 'bundled', tier: 'open', metered: false,
        url: m.file,
        license: 'NASA 3D Resources (not copyrighted in the US)',
        provenance: m.source,
        commercial: 'ok', share_alike: false
    };
}

async function build() {
    const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
    const objects = [...manifest.entries.map(catalogObject), ...MODELS.map(modelObject)];
    const open = objects.filter((o) => o.tier === 'open').length;
    const metered = objects.filter((o) => o.metered).length;
    return {
        name: 'rendered-data-catalog',
        note: 'License-clear, self-hostable objects. Generated from manifest.json + bundled shape models ' +
            'by scripts/build-catalog.mjs — do not edit by hand. tier "open" = free and self-hostable (all ' +
            'current objects); "metered" marks the sources the hosted /v1 gateway can proxy and bill. A future ' +
            'hosted/premium tier would add tier "hosted" entries here.',
        counts: {total: objects.length, open, metered},
        objects
    };
}

const catalog = await build();
const out = JSON.stringify(catalog, null, 2) + '\n';
const file = join(ROOT, 'catalog.json');

if (process.argv.includes('--check')) {
    let current = '';
    try { current = await readFile(file, 'utf8'); } catch { /* missing → stale */ }
    if (current !== out) {
        console.error('catalog.json is out of date — run: node scripts/build-catalog.mjs');
        process.exit(1);
    }
    console.log('catalog.json is up to date.');
} else {
    await writeFile(file, out);
    console.log(`Wrote catalog.json — ${catalog.counts.total} objects (${catalog.counts.open} open, ${catalog.counts.metered} metered).`);
}
