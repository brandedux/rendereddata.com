// Rendered Data Maps playground: MapLibre GL JS (vendored) plus open sources listed in manifest.json.
// No proprietary SDK, token, style, glyph, sprite or tile is used anywhere in this folder.

import * as maplibregl from '../vendor/maplibre-gl/maplibre-gl.mjs';
import {registerEquirectProtocol} from './eqproj.js';
import {createStarfield, createTerminator} from './starfield.js';
import {initBottomSheet} from './sheet.js';
import {ShapeModel} from './shapemodel.js';

const ROOT = new URL('..', import.meta.url).href;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) n.append(k);
    return n;
};
const abs = (u) => (/^https?:/.test(u) ? u : ROOT + u);

// ---------------------------------------------------------------- manifest
let manifest;
try {
    manifest = await (await fetch(ROOT + 'manifest.json', {cache: 'no-store'})).json();
} catch (err) {
    const f = $('fatal');
    f.style.display = 'grid';
    f.textContent = `Could not load manifest.json (${err}). Serve this folder over http (node serve.mjs); file:// will not work.`;
    throw err;
}
const M = Object.fromEntries(manifest.entries.map((e) => [e.id, e]));

// Bundled basemap data. One label point per country comes from Natural Earth's own
// LABEL_X / LABEL_Y fields, so names are placed once instead of once per tile.
let neData = null, neLabels = {type: 'FeatureCollection', features: []}, neError = null;
try {
    neData = await (await fetch(abs(M['gv-open-basemap'].url))).json();
    neLabels.features = neData.features
        .filter((f) => Number.isFinite(f.properties.LABEL_X) && Number.isFinite(f.properties.LABEL_Y))
        .map((f) => ({type: 'Feature', properties: {NAME: f.properties.NAME, rank: f.properties.LABELRANK},
            geometry: {type: 'Point', coordinates: [f.properties.LABEL_X, f.properties.LABEL_Y]}}));
} catch (err) {
    neError = err;
}
const probes = {}; // id -> {state, status, type, bytes, ms, error}

// ---------------------------------------------------------------- bodies
// Mean radii (km). MapLibre itself always assumes Earth; these are used only for the UI readout.
const BODIES = {
    earth: {label: 'Earth', radiusKm: 6371.0, bg: '#0a2540', sky: true,
        presets: [
            ['Whole globe', {center: [-100, 30], zoom: 2.15, pitch: 0, bearing: 0}],
            ['Lake Tahoe', {center: [-120.04, 39.09], zoom: 9.6, pitch: 55, bearing: 20}],
            ['Himalaya', {center: [86.92, 27.99], zoom: 9.2, pitch: 60, bearing: -30}],
            ['North Pole', {center: [0, 89.5], zoom: 2.2, pitch: 0, bearing: 0}],
            ['Antimeridian', {center: [180, 0], zoom: 2, pitch: 0, bearing: 0}]
        ]},
    moon: {label: 'Moon', radiusKm: 1737.4, bg: '#1a1a1c', sky: false,
        presets: [
            ['Whole globe', {center: [0, 10], zoom: 2.15, pitch: 0, bearing: 0}],
            ['Tycho', {center: [-11.36, -43.31], zoom: 5.5, pitch: 0, bearing: 0}],
            ['Copernicus', {center: [-20.08, 9.62], zoom: 5.5, pitch: 0, bearing: 0}],
            ['South polar limit', {center: [0, -84], zoom: 3, pitch: 0, bearing: 0}]
        ]},
    mars: {label: 'Mars', radiusKm: 3389.5, bg: '#2a1710', sky: false,
        presets: [
            ['Whole globe', {center: [-60, 0], zoom: 2.15, pitch: 0, bearing: 0}],
            ['Olympus Mons', {center: [-133.8, 18.65], zoom: 5, pitch: 0, bearing: 0}],
            ['Valles Marineris', {center: [-70, -13], zoom: 4.2, pitch: 0, bearing: 0}],
            ['Gale crater', {center: [137.8, -5.4], zoom: 6.5, pitch: 0, bearing: 0}]
        ]}
};

// Irregular bodies. These are NOT MapLibre globes: each is a NASA glTF shape model drawn as a real
// mesh by src/shapemodel.js, swapped into the stage in place of the MapLibre canvas. Longitudes are
// planetographic; Phobos (like Mars' moons) is west-positive. See shapes.html for the standalone demo.
const SHAPE = {
    ganymede: {label: 'Ganymede', model: 'data/models/ganymede.glb', radiusKm: 2634, northAxis: 'y', lon0: 0, lonDir: 1,
        // IAU gazetteer centres (planetographic, +West). Convention calibrated against Galileo Regio.
        features: [{name: 'Galileo Regio', lon: 127, lat: 45}, {name: 'Osiris', lon: 166.3, lat: -38}, {name: 'Tros', lon: 27.3, lat: 11}]},
    phobos: {label: 'Phobos', model: 'data/models/phobos.glb', radiusKm: [13.0, 11.4, 9.1], northAxis: 'y', lon0: 0, lonDir: -1,
        features: [{name: 'Stickney', lon: 49, lat: 1}, {name: 'Limtoc', lon: 54, lat: -11}, {name: 'Hall', lon: 21, lat: -80},
            {name: 'Roche', lon: 177, lat: 53}, {name: "D'Arrest", lon: 179, lat: -39}]}
};
const isShape = (b) => b in SHAPE;

const twoDaysAgo = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
const state = {body: 'earth', projection: 'globe', viirsDate: twoDaysAgo, shapeGraticule: true, labels: true,
    base: {earth: 'open', moon: 'moon-wac', mars: 'mars-viking'},
    overlays: {borders: true, osm: false, hillshade: false, terrain3d: false, quakes: false}};

// Celestial sky overlay (shared renderer; src/starfield.js). Attached on demand from the controls.
let sky = null, skyTerm = null, skyCatalog = null;

// ---------------------------------------------------------------- layer catalogue
// Each UI layer names its manifest entry and builds its MapLibre sources/layers on first use.
// `slot` is the anchor layer it is inserted beneath, which fixes draw order.
const raster = (id, slot) => ({
    slot,
    build: (e) => ({
        sources: {[id]: {type: 'raster', tiles: [e.url.replace('{date}', state.viirsDate)], tileSize: 256,
            maxzoom: e.maxzoom, attribution: e.attribution}},
        layers: [{id, type: 'raster', source: id}]
    })
});
const equirect = (id, mid) => ({
    slot: 'slot-base',
    build: (e) => ({
        sources: {[id]: {type: 'raster', tiles: [`gveq://${mid}/{z}/{x}/{y}`], tileSize: 256,
            maxzoom: e.maxEquirectZoom + 1, attribution: e.attribution}},
        layers: [{id, type: 'raster', source: id}]
    })
});

const CATALOG = {
    open: {body: 'earth', group: 'base', manifest: 'gv-open-basemap', slot: 'slot-base',
        label: 'GV open basemap',
        build: () => ({sources: {}, layers: [
            {id: 'open-land', type: 'fill', source: 'ne', paint: {'fill-color': '#1c2b33'}}
        ]})},
    bluemarble: {body: 'earth', group: 'base', manifest: 'gibs-bluemarble', label: 'Blue Marble', ...raster('bluemarble', 'slot-base')},
    s2: {body: 'earth', group: 'base', manifest: 'eox-s2-2016', label: 'Sentinel-2 cloudless 2016', ...raster('s2', 'slot-base')},
    viirs: {body: 'earth', group: 'base', manifest: 'gibs-viirs', label: 'VIIRS true color (daily)', ...raster('viirs', 'slot-base')},

    borders: {body: 'earth', group: 'overlay', manifest: 'gv-open-basemap', slot: 'slot-labels',
        label: 'Borders and country labels',
        build: () => ({sources: {}, layers: [
            {id: 'borders-line', type: 'line', source: 'ne',
                paint: {'line-color': '#9fb4c4', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.4, 6, 1.2]}},
            {id: 'borders-label', type: 'symbol', source: 'ne-labels', maxzoom: 7,
                layout: {'text-field': ['get', 'NAME'], 'text-font': ['Noto Sans Regular'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 5, 14], 'text-max-width': 7,
                    'symbol-sort-key': ['get', 'rank']},
                paint: {'text-color': '#eef3f7', 'text-halo-color': 'rgba(8,11,16,.85)', 'text-halo-width': 1.4}}
        ]})},
    hillshade: {body: 'earth', group: 'overlay', manifest: 'mapterhorn-dem', slot: 'slot-overlay',
        label: 'Hillshade',
        build: (e) => ({sources: {dem: demSource(e)}, layers: [
            {id: 'hillshade', type: 'hillshade', source: 'dem',
                paint: {'hillshade-exaggeration': 0.6, 'hillshade-shadow-color': '#05080c', 'hillshade-highlight-color': '#ffffff'}}
        ]})},
    terrain3d: {body: 'earth', group: 'overlay', manifest: 'mapterhorn-dem', slot: 'slot-overlay',
        label: '3D terrain (pitch the map)', special: 'terrain',
        build: (e) => ({sources: {dem3d: demSource(e)}, layers: []})},
    osm: {body: 'earth', group: 'overlay', manifest: 'ofm-osm', slot: 'slot-overlay',
        label: 'Street detail (OSM)',
        build: (e) => ({sources: {osm: {type: 'vector', url: e.url, attribution: e.attribution}}, layers: [
            {id: 'osm-water', type: 'fill', source: 'osm', 'source-layer': 'water', minzoom: 5,
                paint: {'fill-color': '#0a2540'}},
            {id: 'osm-roads', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 5,
                filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'], true, false],
                layout: {'line-cap': 'round', 'line-join': 'round'},
                paint: {'line-color': ['match', ['get', 'class'], ['motorway', 'trunk'], '#e3b04b', ['primary', 'secondary'], '#c9d3dc', '#7d8b99'],
                    'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 5, 0.4, 12, 1.6, 16, 7]}},
            {id: 'osm-places', type: 'symbol', source: 'osm', 'source-layer': 'place', minzoom: 4,
                layout: {'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']],
                    'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-max-width': 8},
                paint: {'text-color': '#ffffff', 'text-halo-color': 'rgba(8,11,16,.9)', 'text-halo-width': 1.4}}
        ]})},
    quakes: {body: 'earth', group: 'overlay', manifest: 'usgs-quakes', slot: 'slot-data',
        label: 'Earthquakes, past day (live)',
        build: (e) => ({sources: {quakes: {type: 'geojson', data: e.url, attribution: e.attribution}}, layers: [
            {id: 'quakes', type: 'circle', source: 'quakes',
                paint: {'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 2.5, 3, 7, 18],
                    'circle-color': ['interpolate', ['linear'], ['get', 'mag'], 2.5, '#ffd166', 5, '#ef8354', 7, '#e2675f'],
                    'circle-opacity': 0.8, 'circle-stroke-color': '#080b10', 'circle-stroke-width': 1}}
        ]})},

    'moon-wac': {body: 'moon', group: 'base', manifest: 'trek-moon-wac', label: 'LRO WAC mosaic', ...equirect('moon-wac', 'trek-moon-wac')},
    'mars-viking': {body: 'mars', group: 'base', manifest: 'trek-mars-viking', label: 'Viking color mosaic', ...equirect('mars-viking', 'trek-mars-viking')},
    'mars-mola': {body: 'mars', group: 'base', manifest: 'trek-mars-mola', label: 'MOLA shaded relief', ...equirect('mars-mola', 'trek-mars-mola')}
};
function demSource(e) {
    return {type: 'raster-dem', tiles: [e.url], tileSize: e.tileSize, maxzoom: e.maxzoom, encoding: e.encoding, attribution: e.attribution};
}

// ---------------------------------------------------------------- map
const stats = {eqRequests: 0, eqErrors: 0};
registerEquirectProtocol(maplibregl, (id) => M[id], stats);

const SKY = {'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0]};
const hadHash = location.hash.length > 1;   // read before the map writes its own camera hash
const map = new maplibregl.Map({
    container: 'map',
    hash: true,
    center: [-100, 30],
    zoom: 2.15,
    maxPitch: 80,
    attributionControl: {compact: false},
    style: {
        version: 8,
        projection: {type: 'globe'},
        glyphs: ROOT + M['gv-glyphs'].url,
        sky: SKY,
        sources: {
            ne: {type: 'geojson', data: neData || {type: 'FeatureCollection', features: []}, attribution: M['gv-open-basemap'].attribution},
            'ne-labels': {type: 'geojson', data: neLabels}
        },
        layers: [
            {id: 'bg', type: 'background', paint: {'background-color': BODIES.earth.bg}},
            ...['slot-base', 'slot-overlay', 'slot-data', 'slot-labels'].map((id) => (
                {id, type: 'background', layout: {visibility: 'none'}}))
        ]
    }
});
window.gvMap = map; // for poking at it from the console
initBottomSheet($('side'));   // mobile: controls become a drag-up bottom sheet

// One "Feature labels" checkbox, wired to whichever renderer is active. On the globe, apply() owns
// symbol-layer visibility (and now factors in state.labels), so toggling just re-runs it — which keeps
// labels contextual to the current body. On a mesh, ShapeModel.setLabels() hides the pins + stems.
function labelsToggle() {
    const cb = el('input', {type: 'checkbox', id: 'l-labels', checked: state.labels});
    cb.addEventListener('change', () => {
        state.labels = cb.checked;
        if (isShape(state.body)) shapeModel?.setLabels(cb.checked); else apply();
    });
    return el('div', {className: 'row'}, cb, el('label', {htmlFor: 'l-labels'}, 'Feature labels'));
}

// Collapse / expand the sidebar (desktop), the way a chat app hides its rail. A floating button
// over the stage brings it back. The grid column eases to 0 via CSS; we repaint the map afterwards.
function initSidebarCollapse() {
    const app = $('app');
    const setCollapsed = (on) => {
        app.classList.toggle('side-collapsed', on);
        setTimeout(() => map.resize(), 240);   // let the width transition finish, then refit MapLibre
    };
    $('side-collapse')?.addEventListener('click', () => setCollapsed(true));
    $('side-expand')?.addEventListener('click', () => setCollapsed(false));
}
initSidebarCollapse();
map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), 'top-right');
const scale = new maplibregl.ScaleControl({unit: 'metric'});
let scaleOn = false;

// Deep links: playground.html?body=mars&base=mars-mola&on=hillshade,quakes&proj=mercator&date=2026-11-01#zoom/lat/lng
// The site's Developers tab uses these to open a feature directly. Camera comes from the URL hash.
const qp = new URLSearchParams(location.search);
if (BODIES[qp.get('body')] || SHAPE[qp.get('body')]) state.body = qp.get('body');
if (['globe', 'mercator'].includes(qp.get('proj'))) state.projection = qp.get('proj');
if (/^\d{4}-\d{2}-\d{2}$/.test(qp.get('date') || '')) state.viirsDate = qp.get('date');
{
    const b = qp.get('base');
    if (CATALOG[b]?.group === 'base') { state.body = CATALOG[b].body; state.base[state.body] = b; }
    for (const k of (qp.get('on') || '').split(',')) if (CATALOG[k]?.group === 'overlay') state.overlays[k] = true;
    if (!hadHash && state.body !== 'earth' && BODIES[state.body]) map.once('load', () => map.jumpTo(BODIES[state.body].presets[0][1]));
}

const built = new Set();
function ensureBuilt(key) {
    if (built.has(key)) return;
    const def = CATALOG[key];
    const {sources, layers} = def.build(M[def.manifest]);
    for (const [id, s] of Object.entries(sources)) if (!map.getSource(id)) map.addSource(id, s);
    for (const l of layers) map.addLayer(l, def.slot);
    def.layerIds = layers.map((l) => l.id);
    built.add(key);
}
const usable = (key) => probes[CATALOG[key].manifest]?.state === 'ok';
function isOn(key) {
    const def = CATALOG[key];
    if (def.body !== state.body || !usable(key)) return false;
    return def.group === 'base' ? state.base[state.body] === key : !!state.overlays[key];
}

let tChange = 0;
function apply() {
    tChange = performance.now();
    hud.idleMs = null;
    // A shape body is not a MapLibre globe; its renderer handles itself. Only refresh the controls.
    if (isShape(state.body)) { renderControls(); return; }
    for (const key of Object.keys(CATALOG)) {
        const on = isOn(key);
        if (on) ensureBuilt(key);
        if (!built.has(key)) continue;
        for (const id of CATALOG[key].layerIds) {
            // Text (symbol) layers are the "feature labels"; they also require the labels toggle to be on.
            // This keeps labels contextual — an Earth-only label layer never shows on Moon/Mars.
            const isLabel = map.getLayer(id)?.type === 'symbol';
            map.setLayoutProperty(id, 'visibility', on && (!isLabel || state.labels) ? 'visible' : 'none');
        }
    }
    map.setTerrain(isOn('terrain3d') ? {source: 'dem3d', exaggeration: 1.5} : null);
    const body = BODIES[state.body];
    map.setPaintProperty('bg', 'background-color', body.bg);
    map.setSky(body.sky && state.projection === 'globe' ? SKY : {'atmosphere-blend': 0});
    map.setProjection({type: state.projection});
    if ((state.body === 'earth') !== scaleOn) {
        scaleOn = state.body === 'earth';
        if (scaleOn) map.addControl(scale, 'bottom-right'); else map.removeControl(scale);
    }
    sky?.redraw();   // reflect body / projection change in the celestial overlay
    renderControls();
}

// ---------------------------------------------------------------- probes (manifest-first gate)
async function probeOne(e) {
    const url = abs(e.probe).replace('{date}', state.viirsDate);
    const p = (probes[e.id] = {state: 'pending', url});
    renderProbes();
    const t0 = performance.now();
    try {
        const res = await fetch(url, {mode: 'cors', cache: 'no-store'});
        const buf = await res.arrayBuffer();
        Object.assign(p, {state: res.ok ? 'ok' : 'fail', status: res.status, type: res.headers.get('content-type') || '?',
            bytes: buf.byteLength, ms: Math.round(performance.now() - t0)});
        if (!res.ok) p.error = `HTTP ${res.status}`;
    } catch (err) {
        Object.assign(p, {state: 'fail', ms: Math.round(performance.now() - t0),
            error: `${err.message || err} (unreachable, or the host sends no CORS header)`});
    }
    renderProbes();
}
async function runProbes() {
    await Promise.all(manifest.entries.map(probeOne));
    if (map.isStyleLoaded()) apply(); else map.once('load', apply);
}

// ---------------------------------------------------------------- UI
function tag(cls, text) { return el('span', {className: `tag ${cls}`, textContent: text}); }
function flags(e) {
    const f = document.createDocumentFragment();
    f.append(tag(e.hosted === 'bundled' ? 'bundled' : 'third', e.hosted === 'bundled' ? 'bundled' : new URL(abs(e.probe)).host));
    f.append(tag(e.commercial, `commercial: ${e.commercial}`));
    if (e.store === 'quarantine') f.append(tag('quarantine', 'share-alike quarantine'));
    return f;
}
function layerRow(key, type) {
    const def = CATALOG[key];
    const e = M[def.manifest];
    const p = probes[def.manifest];
    const ok = p?.state === 'ok';
    const input = el('input', {type, name: `g-${def.group}`, id: `l-${key}`, disabled: !ok,
        checked: ok && (def.group === 'base' ? state.base[state.body] === key : !!state.overlays[key])});
    input.addEventListener('change', () => {
        if (def.group === 'base') state.base[state.body] = key; else state.overlays[key] = input.checked;
        apply();
    });
    const label = el('label', {htmlFor: `l-${key}`}, def.label);
    const meta = el('span', {className: 'meta'});
    meta.append(flags(e));
    if (!ok) meta.append(el('span', {textContent: p?.state === 'pending' ? ' probing…' : ' unavailable: probe failed, see manifest below'}));
    label.append(meta);
    if (key === 'viirs' && ok) {
        const d = el('input', {type: 'date', value: state.viirsDate, max: new Date().toISOString().slice(0, 10)});
        d.addEventListener('change', () => {
            if (!d.value) return;
            state.viirsDate = d.value;
            if (built.has('viirs')) map.getSource('viirs').setTiles([M['gibs-viirs'].url.replace('{date}', state.viirsDate)]);
            apply();
        });
        label.append(el('span', {className: 'meta'}, d));
    }
    return el('div', {className: `row${ok ? '' : ' off'}`}, input, label);
}
function renderControls() {
    const allBodies = [...Object.entries(BODIES), ...Object.entries(SHAPE)];
    $('bodies').replaceChildren(...allBodies.map(([k, b]) => {
        const btn = el('button', {textContent: b.label});
        btn.setAttribute('aria-pressed', String(state.body === k));
        btn.addEventListener('click', () => {
            if (isShape(k)) { enterShape(k); return; }
            const fromShape = isShape(state.body);
            if (fromShape) exitShape();
            state.body = k; apply(); map.jumpTo(BODIES[k].presets[0][1]);
            // globe→globe keeps its sky (getBody is dynamic); shape→globe must re-attach the globe sky.
            if (fromShape && $('sky-toggle').checked) attachSky();
        });
        return btn;
    }));
    if (isShape(state.body)) return renderShapeControls();
    $('proj').replaceChildren(...['globe', 'mercator'].map((p) => {
        const btn = el('button', {textContent: p});
        btn.setAttribute('aria-pressed', String(state.projection === p));
        btn.addEventListener('click', () => { state.projection = p; apply(); });
        return btn;
    }));
    const keys = Object.keys(CATALOG).filter((k) => CATALOG[k].body === state.body);
    $('base').replaceChildren(...keys.filter((k) => CATALOG[k].group === 'base').map((k) => layerRow(k, 'radio')));
    const ov = keys.filter((k) => CATALOG[k].group === 'overlay').map((k) => layerRow(k, 'checkbox'));
    const b = BODIES[state.body];
    $('overlays').replaceChildren(labelsToggle(), ...(ov.length ? ov : [el('div', {className: 'note',
        textContent: `Earth-only overlays are disabled on ${b.label}. Mean radius ${b.radiusKm} km; the renderer still assumes Earth's radius, so no scale bar is shown and the polar caps beyond 85° are not drawn.`})]));
    $('presets').replaceChildren(...b.presets.map(([name, cam]) => {
        const btn = el('button', {textContent: name});
        btn.addEventListener('click', () => { tChange = performance.now(); hud.idleMs = null; map.flyTo({...cam, duration: 1800}); });
        return btn;
    }));
}

// ---------------------------------------------------------------- shape bodies (irregular)
let shapeModel = null;
const shapeDims = (cfg) => Array.isArray(cfg.radiusKm) ? `${cfg.radiusKm.join(' × ')} km (triaxial)` : `${cfg.radiusKm} km mean radius`;
// A demo dataset (a box, a traverse line, and points) to show GeoJSON draping onto the mesh surface.
const sampleGeoJSON = () => ({type: 'FeatureCollection', features: [
    {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [[[-40, -25], [40, -25], [40, 25], [-40, 25], [-40, -25]]]}},
    {type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: [[-90, 0], [-40, 35], [0, -15], [60, 25], [110, -25]]}},
    ...[[0, 0], [30, 30], [-30, -30], [75, 10]].map((c) => ({type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: c}})),
]});

function renderShapeControls() {
    const cfg = SHAPE[state.body];
    $('proj').replaceChildren(el('div', {className: 'note', textContent: 'Projection does not apply to a 3D shape model.'}));
    $('base').replaceChildren(el('div', {className: 'row'},
        el('span', {className: 'meta', textContent: 'NASA shape model (glTF), drawn as a real mesh.'})));
    const grat = el('input', {type: 'checkbox', id: 'l-grat', checked: state.shapeGraticule});
    grat.addEventListener('change', () => { state.shapeGraticule = grat.checked; shapeModel?.setGraticule(grat.checked); });
    // Bring your own data: drape GeoJSON/KML/GPX onto the real mesh surface.
    const file = el('input', {type: 'file', id: 'shape-byo', accept: '.geojson,.json,.kml,.gpx'});
    file.addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (f) { try { await shapeModel?.addUserLayer(f); } catch (err) { $('cam').textContent = `Could not read ${f.name}:\n${err.message}`; } }
        e.target.value = '';
    });
    const sample = el('button', {textContent: 'Drape sample data'});
    sample.addEventListener('click', () => shapeModel?.addUserLayer(sampleGeoJSON(), {fit: false}));
    const clearBtn = el('button', {textContent: 'Clear'});
    clearBtn.addEventListener('click', () => { for (const l of shapeModel?.userLayers() || []) shapeModel.removeUserLayer(l.id); });
    $('overlays').replaceChildren(
        el('div', {className: 'row'}, grat, el('label', {htmlFor: 'l-grat'}, 'Lon/lat graticule')),
        labelsToggle(),
        el('div', {className: 'note', style: 'margin-top:8px'}, 'Your data: drape GeoJSON / KML / GPX on the real surface. Read in the browser, nothing uploaded.'),
        el('div', {className: 'row'}, file),
        el('div', {className: 'seg', style: 'margin-top:6px'}, sample, clearBtn),
        el('div', {className: 'note', textContent: `${cfg.label}: ${shapeDims(cfg)}. A separate WebGL canvas, not the MapLibre globe; the base, overlay and projection controls above are globe-only (the sky and your-own-data work here too).`})
    );
    $('presets').replaceChildren(...cfg.features.map((f) => {
        const btn = el('button', {textContent: f.name});
        btn.addEventListener('click', () => shapeModel?.flyTo({lon: f.lon, lat: f.lat, dist: 2.4}));
        return btn;
    }));
}

async function enterShape(key) {
    detachSky();                               // stop the sky on the previous surface (globe or mesh)
    state.body = key;
    $('map').style.visibility = 'hidden';      // keep MapLibre alive, just hidden behind the shape canvas
    $('shape').style.display = 'block';
    if (shapeModel) { shapeModel.remove(); shapeModel = null; }
    const cfg = SHAPE[key];
    renderControls();
    $('cam').textContent = `body: ${cfg.label}\nshape: ${Array.isArray(cfg.radiusKm) ? 'irregular' : 'round'}\nsize: ${shapeDims(cfg)}\nsource: NASA 3D Resources (glTF)`;
    tChange = performance.now(); hud.idleMs = null;
    shapeModel = new ShapeModel({container: 'shape', body: key, model: cfg.model, label: cfg.label, radiusKm: cfg.radiusKm,
        graticule: state.shapeGraticule, labels: state.labels, northAxis: cfg.northAxis, lon0: cfg.lon0, lonDir: cfg.lonDir, features: cfg.features,
        dist: cfg.dist, autorotate: false});   // the globe bodies here don't auto-spin; keep the playground consistent
    window.gvShape = shapeModel;   // for poking at it from the console
    shapeModel.on('select', (f) => { $('cam').textContent = `${f.name}\nlon ${f.lon}°, lat ${f.lat}°`; });
    try {
        await shapeModel.ready; hud.idleMs = Math.round(performance.now() - tChange);
        if ($('sky-toggle').checked) await attachSky();   // the sky works on the mesh too
    } catch { /* ShapeModel shows its own fatal message */ }
}

function exitShape() {
    detachSky();
    shapeModel?.remove(); shapeModel = null;
    $('shape').style.display = 'none';
    $('map').style.visibility = '';
    map.resize();
    showCam();
}

function renderProbes() {
    $('probes').replaceChildren(...manifest.entries.map((e) => {
        const p = probes[e.id] || {state: 'pending'};
        const head = el('span', {className: 'name'}, tag(p.state === 'ok' ? 'ok' : p.state === 'fail' ? 'fail' : 'pending',
            p.state === 'ok' ? `${p.status}` : p.state), e.label);
        const meta = el('span', {className: 'meta'});
        meta.append(flags(e), e.license);
        const detail = el('div', {className: 'detail', textContent: p.state === 'ok'
            ? `${p.type} · ${p.bytes.toLocaleString()} B · ${p.ms} ms · build check: ${e.verified}`
            : p.state === 'fail' ? p.error : 'probing…'});
        return el('div', {className: 'probe'}, head, meta, detail);
    }));
}

// ---------------------------------------------------------------- HUD, hosts, camera, errors
const hud = {fps: 0, frames: 0, idleMs: null, firstIdle: null};
const hosts = new Map(); // host -> {n, ms}
new PerformanceObserver((list) => {
    for (const r of list.getEntries()) {
        let h; try { h = new URL(r.name).host; } catch { continue; }
        const rec = hosts.get(h) || {n: 0, ms: 0};
        rec.n++; rec.ms += r.duration; hosts.set(h, rec);
    }
}).observe({type: 'resource', buffered: true});

map.on('render', () => { hud.frames++; });
map.on('idle', () => {
    hud.idleMs = Math.round(performance.now() - tChange);
    if (hud.firstIdle === null) hud.firstIdle = Math.round(performance.now());
});
setInterval(() => {
    hud.fps = hud.frames; hud.frames = 0;
    let n = 0; for (const r of hosts.values()) n += r.n;
    const rows = [
        ['renderer', isShape(state.body) ? 'ShapeModel (WebGL, dependency-free)' : `MapLibre GL JS ${maplibregl.getVersion()}`],
        ['body / projection', `${state.body} / ${isShape(state.body) ? 'shape model' : state.projection}`],
        ['frames last second', hud.fps ? String(hud.fps) : 'idle'],
        ['settle after last change', isShape(state.body)
            ? (shapeModel?.probe?.ms != null ? `${shapeModel.probe.ms} ms (model load)` : 'loading…')
            : (hud.idleMs === null ? 'loading…' : `${hud.idleMs} ms`)],
        ['first idle after page load', hud.firstIdle === null ? '…' : `${hud.firstIdle} ms`],
        ['network requests', String(n)],
        ['reprojected source tiles', `${stats.eqRequests} (${stats.eqErrors} failed)`]
    ];
    $('hudt').replaceChildren(...rows.map(([a, b]) => el('tr', {}, el('td', {textContent: a}), el('td', {textContent: b}))));
    $('hosts').replaceChildren(...[...hosts.entries()].sort((a, b) => b[1].n - a[1].n).map(([h, r]) =>
        el('tr', {}, el('td', {textContent: h === location.host ? `${h} (bundled)` : h}),
            el('td', {textContent: `${r.n} req · avg ${Math.round(r.ms / r.n)} ms`}))));
}, 1000);

function camText() {
    const c = map.getCenter();
    return `center: [${c.lng.toFixed(5)}, ${c.lat.toFixed(5)}],\nzoom: ${map.getZoom().toFixed(2)},\nbearing: ${map.getBearing().toFixed(1)},\npitch: ${map.getPitch().toFixed(1)}`;
}
const showCam = () => { $('cam').textContent = camText(); };
map.on('move', showCam);
$('copycam').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(camText()); $('copycam').textContent = 'Copied'; }
    catch { $('copycam').textContent = 'Copy blocked, select the text above'; }
    setTimeout(() => { $('copycam').textContent = 'Copy camera'; }, 1500);
});

const seenErr = new Set();
map.on('error', (e) => {
    const msg = e?.error?.message || String(e?.error || e);
    if (seenErr.has(msg)) return;
    seenErr.add(msg);
    const box = el('div', {className: 'err', textContent: `${e.sourceId ? `[${e.sourceId}] ` : ''}${msg}`});
    $('errors').prepend(box);
    while ($('errors').children.length > 4) $('errors').lastChild.remove();
    setTimeout(() => { box.remove(); seenErr.delete(msg); }, 12000);
});

// ---------------------------------------------------------------- celestial sky controls
const skyFlags = () => ({
    milkyWay: $('sky-milky').checked, constellations: $('sky-const').checked,
    sun: $('sky-bodies').checked, moon: $('sky-bodies').checked, planets: $('sky-bodies').checked,
    starLabels: $('sky-labels').checked, grid: $('sky-grid').checked, ecliptic: $('sky-ecl').checked
});
const skyTime = () => ($('sky-time').value ? new Date($('sky-time').value) : new Date());
async function loadSkyCatalog() {
    if (skyCatalog) return skyCatalog;
    try { skyCatalog = await (await fetch(ROOT + 'data/stars.json', {cache: 'no-store'})).json(); } catch { skyCatalog = null; }
    return skyCatalog;
}
// Click a reachable world in the sky to fly to it: zoom in, swap the body, ease out to its view.
function travelTo(body) {
    if (!BODIES[body] || body === state.body) return;
    const z = map.getZoom();
    map.easeTo({zoom: Math.min(z + 1.6, 5), duration: 620, easing: (t) => t * (2 - t)});
    setTimeout(() => {
        state.body = body; apply();
        const home = BODIES[body].presets[0][1];
        map.jumpTo({...home, zoom: (home.zoom ?? 1.6) + 1.9});
        map.easeTo({...home, duration: 1100, easing: (t) => 1 - Math.pow(1 - t, 3)});
        renderControls();
        sky?.redraw();
    }, 600);
}
// Attach the celestial sky to whichever surface is active — the MapLibre globe or the ShapeModel mesh.
// Both expose the same control surface (set / setTime / stop) so the sub-toggles below are uniform.
async function attachSky() {
    const cat = await loadSkyCatalog();
    if (isShape(state.body)) {
        shapeModel?.addStarfield({catalog: cat || undefined, time: skyTime(), ...skyFlags()});
        sky = {set: (k, v) => shapeModel?.setSkyFlag(k, v), setTime: (t) => shapeModel?.setSkyTime(t),
            redraw: () => {}, stop: () => shapeModel?.removeStarfield()};
    } else {
        sky = createStarfield(map, {getBody: () => state.body, catalog: cat || undefined, time: skyTime(),
            navigable: Object.keys(BODIES), onTravel: travelTo, ...skyFlags()});
        if ($('sky-term').checked) skyTerm = createTerminator(map, {getBody: () => state.body, beforeId: 'slot-data', time: skyTime()});
    }
}
function detachSky() { sky?.stop(); sky = null; skyTerm?.stop(); skyTerm = null; }

$('sky-toggle').addEventListener('change', async (e) => {
    if (e.target.checked) { $('sky-opts').style.display = 'block'; await attachSky(); }
    else { $('sky-opts').style.display = 'none'; detachSky(); }
});
for (const [id, key] of [['sky-milky', 'milkyWay'], ['sky-const', 'constellations'], ['sky-labels', 'starLabels'], ['sky-grid', 'grid'], ['sky-ecl', 'ecliptic']])
    $(id).addEventListener('change', (ev) => sky?.set(key, ev.target.checked));
$('sky-bodies').addEventListener('change', (ev) => { for (const k of ['sun', 'moon', 'planets']) sky?.set(k, ev.target.checked); });
$('sky-term').addEventListener('change', (ev) => {
    if (isShape(state.body)) return;   // the day/night terminator is a globe layer; mesh bodies skip it for now
    if (ev.target.checked) { if (!skyTerm) skyTerm = createTerminator(map, {getBody: () => state.body, beforeId: 'slot-data', time: skyTime()}); }
    else { skyTerm?.stop(); skyTerm = null; }
});
$('sky-now').addEventListener('click', () => { $('sky-time').value = ''; sky?.setTime(new Date()); skyTerm?.setTime(new Date()); });
$('sky-time').addEventListener('change', () => { const t = skyTime(); sky?.setTime(t); skyTerm?.setTime(t); });

if (neError) map.fire('error', {error: new Error(`Bundled basemap failed to load: ${neError.message}`), sourceId: 'ne'});
$('reprobe').addEventListener('click', runProbes);
$('ver').textContent = `MapLibre GL JS ${maplibregl.getVersion()}.`;
renderControls();
renderProbes();
showCam();
runProbes();
if (isShape(state.body)) enterShape(state.body);   // deep link opened straight onto a shape body
