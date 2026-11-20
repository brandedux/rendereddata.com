// Rendered Data Maps SDK.
//
// One import, one body option. This is the working package behind the "SDK" feature:
// it wraps the vendored MapLibre GL JS renderer, the source manifest, the live probes,
// the equirectangular protocol for other worlds, and a small catalogue of science layers.
//
//   import {GlobeMap} from './src/maps.js';
//
//   const map = new GlobeMap({container: 'map', body: 'earth', base: 'base-open'});
//   map.on('probe', (s) => console.log(s.id, s.state, s.commercial));
//   await map.ready;
//   await map.setBody('mars', {base: 'mars-viking'});
//   await map.addLayer('quakes');
//
// Nothing is requested unless it is in the manifest, and no third-party layer is drawn
// until its probe passes in the browser. Same rule as the playground, now behind one object.

import * as maplibregl from '../vendor/maplibre-gl/maplibre-gl.mjs';
import {registerEquirectProtocol, registerWorldProtocol} from './eqproj.js';
import {registerPMTilesProtocol, RangeSource, BlobSource, loadGeoTIFF, canvasToDataURL} from './rasterformats.js';
import * as Cel from './celestial.js';
import {createStarfield, createTerminator} from './starfield.js';
import {ShapeModel} from './shapemodel.js';
import {parseVector, bounds as bbox} from './vectorparse.js';

const ROOT = new URL('..', import.meta.url).href;
const abs = (u) => (/^https?:/.test(u) ? u : ROOT + u);
const today = () => new Date().toISOString().slice(0, 10);
const twoDaysAgo = () => new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);

// The renderer always assumes Earth's radius; radiusKm is a readout only. `home` is the
// opening camera, `bg` the void colour, `sky` whether a limb atmosphere is drawn.
export const BODIES = {
    earth: {label: 'Earth', radiusKm: 6371.0, bg: '#0a2540', sky: true, home: {center: [-100, 30], zoom: 1.6, pitch: 0, bearing: 0}},
    moon: {label: 'Moon', radiusKm: 1737.4, bg: '#1a1a1c', sky: false, home: {center: [0, 10], zoom: 1.6, pitch: 0, bearing: 0}},
    mars: {label: 'Mars', radiusKm: 3389.5, bg: '#2a1710', sky: false, home: {center: [-60, 0], zoom: 1.6, pitch: 0, bearing: 0}}
};

const SKY = {'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0]};

// Space backdrop shown in the void around the globe. MapLibre leaves the void transparent in globe
// mode, so this is just the map container's CSS background. Pass opts.background to override, or
// false to keep the container's own background.
const SPACE_BG = 'radial-gradient(ellipse at 50% 38%, #0c1522 0%, #070b14 42%, #02040a 72%, #000000 100%)';

// Each catalogue entry names the manifest source it needs and builds its MapLibre
// sources + layers on first use. `slot` is the anchor layer it is inserted beneath, which
// fixes draw order. `kind` is 'base' (mutually exclusive per body) or 'overlay'.
const CATALOG = {
    // --- Earth bases ---
    'base-open': {
        body: 'earth', kind: 'base', manifest: 'gv-open-basemap', slot: 'gv-slot-base',
        label: 'GV open basemap',
        build: () => ({sources: {}, layers: [{id: 'gv-open-land', type: 'fill', source: 'gv-ne', paint: {'fill-color': '#1c2b33'}}]})
    },
    bluemarble: {body: 'earth', kind: 'base', manifest: 'gibs-bluemarble', slot: 'gv-slot-base', label: 'Blue Marble', ...rasterLayer('bluemarble')},
    s2: {body: 'earth', kind: 'base', manifest: 'eox-s2-2016', slot: 'gv-slot-base', label: 'Sentinel-2 cloudless 2016', ...rasterLayer('s2')},
    viirs: {body: 'earth', kind: 'base', manifest: 'gibs-viirs', slot: 'gv-slot-base', label: 'VIIRS true color (daily)', ...rasterLayer('viirs')},

    // --- Earth overlays / science ---
    borders: {
        body: 'earth', kind: 'overlay', manifest: 'gv-open-basemap', slot: 'gv-slot-labels',
        label: 'Borders and country labels',
        build: () => ({sources: {}, layers: [
            {id: 'gv-borders-line', type: 'line', source: 'gv-ne',
                paint: {'line-color': '#9fb4c4', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.4, 6, 1.2]}},
            {id: 'gv-borders-label', type: 'symbol', source: 'gv-ne-labels', maxzoom: 7,
                layout: {'text-field': ['get', 'NAME'], 'text-font': ['Noto Sans Regular'],
                    'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 5, 14], 'text-max-width': 7, 'symbol-sort-key': ['get', 'rank']},
                paint: {'text-color': '#eef3f7', 'text-halo-color': 'rgba(8,11,16,.85)', 'text-halo-width': 1.4}}
        ]})
    },
    hillshade: {
        body: 'earth', kind: 'overlay', manifest: 'mapterhorn-dem', slot: 'gv-slot-overlay',
        label: 'Hillshade',
        build: (e) => ({sources: {'gv-dem': demSource(e)}, layers: [
            {id: 'gv-hillshade', type: 'hillshade', source: 'gv-dem',
                paint: {'hillshade-exaggeration': 0.6, 'hillshade-shadow-color': '#05080c', 'hillshade-highlight-color': '#ffffff'}}
        ]})
    },
    terrain3d: {
        body: 'earth', kind: 'overlay', manifest: 'mapterhorn-dem', slot: 'gv-slot-overlay', special: 'terrain',
        label: '3D terrain (pitch the map)',
        build: (e) => ({sources: {'gv-dem3d': demSource(e)}, layers: []})   // no draw layer; it drives setTerrain
    },
    osm: {
        body: 'earth', kind: 'overlay', manifest: 'ofm-osm', slot: 'gv-slot-overlay',
        label: 'Street detail (OSM · quarantined)',
        // Share-alike (ODbL) data: every layer is tagged gv:store=quarantine so a paid build strips it by rule.
        build: (e) => ({sources: {'gv-osm': {type: 'vector', url: e.url, attribution: e.attribution}}, layers: [
            {id: 'gv-osm-water', type: 'fill', source: 'gv-osm', 'source-layer': 'water', minzoom: 5,
                metadata: {'gv:store': 'quarantine'}, paint: {'fill-color': '#0a2540'}},
            {id: 'gv-osm-roads', type: 'line', source: 'gv-osm', 'source-layer': 'transportation', minzoom: 5,
                metadata: {'gv:store': 'quarantine'},
                filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'], true, false],
                layout: {'line-cap': 'round', 'line-join': 'round'},
                paint: {'line-color': ['match', ['get', 'class'], ['motorway', 'trunk'], '#e3b04b', ['primary', 'secondary'], '#c9d3dc', '#7d8b99'],
                    'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 5, 0.4, 12, 1.6, 16, 7]}},
            {id: 'gv-osm-places', type: 'symbol', source: 'gv-osm', 'source-layer': 'place', minzoom: 4,
                metadata: {'gv:store': 'quarantine'},
                layout: {'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']],
                    'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-max-width': 8},
                paint: {'text-color': '#ffffff', 'text-halo-color': 'rgba(8,11,16,.9)', 'text-halo-width': 1.4}}
        ]})
    },
    quakes: {
        body: 'earth', kind: 'overlay', manifest: 'usgs-quakes', slot: 'gv-slot-data',
        label: 'Earthquakes, past day (live)',
        build: (e) => ({sources: {'gv-quakes': {type: 'geojson', data: e.url, attribution: e.attribution}}, layers: [
            {id: 'gv-quakes', type: 'circle', source: 'gv-quakes',
                paint: {'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 2.5, 3, 7, 18],
                    'circle-color': ['interpolate', ['linear'], ['get', 'mag'], 2.5, '#ffd166', 5, '#ef8354', 7, '#e2675f'],
                    'circle-opacity': 0.85, 'circle-stroke-color': '#080b10', 'circle-stroke-width': 1}}
        ]})
    },

    // --- Planetary bases ---
    'moon-wac': {body: 'moon', kind: 'base', manifest: 'trek-moon-wac', slot: 'gv-slot-base', label: 'LRO WAC mosaic', ...equirectLayer('moon-wac', 'trek-moon-wac')},
    'mars-viking': {body: 'mars', kind: 'base', manifest: 'trek-mars-viking', slot: 'gv-slot-base', label: 'Viking color mosaic', ...equirectLayer('mars-viking', 'trek-mars-viking')},
    'mars-mola': {body: 'mars', kind: 'base', manifest: 'trek-mars-mola', slot: 'gv-slot-base', label: 'MOLA shaded relief', ...equirectLayer('mars-mola', 'trek-mars-mola')}
};

function rasterLayer(id) {
    // These three Earth bases (id = bluemarble|s2|viirs) are the ones the hosted /v1 gateway can meter.
    // With a hosted config, their tiles route through the gateway with a key; otherwise they hit the
    // upstream directly and keyless (the default — self-host stays free). Note: hosted VIIRS uses the
    // gateway's fixed date, so runtime date-scrubbing (setDate) only affects the direct path.
    return {build: (e, ctx) => {
        const h = ctx.hosted;
        const tile = h
            ? `${h.baseUrl}/v1/tiles/earth/${id}/{z}/{x}/{y}?key=${encodeURIComponent(h.key)}`
            : e.url.replace('{date}', ctx.date);
        return {
            sources: {[id]: {type: 'raster', tiles: [tile], tileSize: 256, maxzoom: e.maxzoom, attribution: e.attribution}},
            layers: [{id, type: 'raster', source: id}]
        };
    }};
}
function equirectLayer(id, mid) {
    return {build: (e) => ({
        sources: {[id]: {type: 'raster', tiles: [`gveq://${mid}/{z}/{x}/{y}`], tileSize: 256, maxzoom: e.maxEquirectZoom + 1, attribution: e.attribution}},
        layers: [{id, type: 'raster', source: id}]
    })};
}
function demSource(e) {
    return {type: 'raster-dem', tiles: [e.url], tileSize: e.tileSize, maxzoom: e.maxzoom, encoding: e.encoding, attribution: e.attribution};
}

// A page may hold more than one GlobeMap, but the gveq:// protocol is global, so register
// it once and look every source up through whichever map asks last. In practice all maps
// on a page share the one manifest, so this is safe.
let eqGetSource = () => undefined;
let eqRegistered = false;
const eqStats = {eqRequests: 0, eqErrors: 0};
function ensureEquirect(lookup) {
    eqGetSource = lookup;
    if (eqRegistered) return;
    registerEquirectProtocol(maplibregl, (id) => eqGetSource(id), eqStats);
    eqRegistered = true;
}

// The gvworld:// protocol (user-supplied planet textures) is also global; register it once.
let worldReg = null;
function ensureWorld() { if (!worldReg) worldReg = registerWorldProtocol(maplibregl); return worldReg; }

let pmtilesReg = null;
function ensurePMTiles() { if (!pmtilesReg) pmtilesReg = registerPMTilesProtocol(maplibregl); return pmtilesReg; }

/** Minimal event emitter: on(type, cb) / off(type, cb), returns an unsubscribe. */
class Emitter {
    #handlers = new Map();
    on(type, cb) {
        if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
        this.#handlers.get(type).add(cb);
        return () => this.off(type, cb);
    }
    off(type, cb) { this.#handlers.get(type)?.delete(cb); }
    emit(type, payload) { for (const cb of this.#handlers.get(type) || []) cb(payload); }
}

export class GlobeMap extends Emitter {
    /**
     * @param {object} opts
     * @param {string|HTMLElement} opts.container  map container id or element
     * @param {'earth'|'moon'|'mars'} [opts.body='earth']
     * @param {string} [opts.base]        a base layer id for that body (defaults per body)
     * @param {'globe'|'mercator'} [opts.projection='globe']
     * @param {string} [opts.manifestUrl]  override the manifest location
     * @param {string} [opts.date]         ISO day for time-aware layers (defaults to 2 days ago)
     * @param {boolean} [opts.controls=true] add navigation + scale controls
     * @param {string|false} [opts.background] CSS for the void behind the globe (default: deep-space
     *   gradient). Pass a CSS string to customise, or false to keep the container's own background.
     * @param {{baseUrl: string, key: string}} [opts.hosted] opt-in hosted tiles: route the metered Earth
     *   bases (Blue Marble / Sentinel-2 / VIIRS) through the /v1 gateway with a key, e.g.
     *   `{baseUrl: 'https://api.rendereddata.com', key: 'gv_pk_...'}`. Omit to keep every tile keyless
     *   and direct (the default — self-hosting never needs a key).
     */
    constructor(opts = {}) {
        super();
        if (!opts.container) throw new Error('GlobeMap: a container is required');
        this.body = BODIES[opts.body] ? opts.body : 'earth';
        this.projection = opts.projection === 'mercator' ? 'mercator' : 'globe';
        this.date = /^\d{4}-\d{2}-\d{2}$/.test(opts.date || '') ? opts.date : twoDaysAgo();
        this._base = opts.base || defaultBase(this.body);
        this._manifestUrl = opts.manifestUrl || 'manifest.json';
        this._controls = opts.controls !== false;
        this._labels = opts.labels !== false;   // place/feature text labels; toggle at runtime with setLabels()
        // Opt-in hosted tiles: only when BOTH a base URL and a key are given. Trailing slashes trimmed
        // so `${baseUrl}/v1/...` is well-formed. Unset → metered bases stay keyless + direct.
        this._hosted = (opts.hosted && opts.hosted.baseUrl && opts.hosted.key)
            ? {baseUrl: String(opts.hosted.baseUrl).replace(/\/+$/, ''), key: opts.hosted.key} : null;
        this.probes = {};          // manifest id -> {state, status, type, bytes, ms, error, commercial}
        this._built = new Set();   // catalogue keys whose sources/layers are added
        this._overlays = new Set();// catalogue keys the caller has turned on
        this._userLayers = new Map(); // user id -> {sourceId, layerIds, kind, license}
        this._userSeq = 0;
        this.map = null;           // the underlying maplibregl.Map, once constructed
        this.ready = this._boot(opts).then(() => this);
    }

    // The underlying renderer, for anything the SDK does not wrap yet.
    get maplibre() { return this.map; }
    get bodies() { return Object.keys(BODIES); }
    layersFor(body = this.body) { return Object.keys(CATALOG).filter((k) => CATALOG[k].body === body); }
    basesFor(body = this.body) { return this.layersFor(body).filter((k) => CATALOG[k].kind === 'base'); }
    overlaysFor(body = this.body) { return this.layersFor(body).filter((k) => CATALOG[k].kind === 'overlay'); }
    usable(key) { return this.probes[CATALOG[key]?.manifest]?.state === 'ok'; }

    async _boot(opts) {
        this._manifest = await (await fetch(abs(this._manifestUrl), {cache: 'no-store'})).json();
        this.M = Object.fromEntries(this._manifest.entries.map((e) => [e.id, e]));
        ensureEquirect((id) => this.M[id]);

        // Bundled Natural Earth data + one label point per country from its own LABEL_X/Y.
        const neEntry = this.M['gv-open-basemap'];
        this._ne = await (await fetch(abs(neEntry.url))).json();
        this._neLabels = {type: 'FeatureCollection', features: this._ne.features
            .filter((f) => Number.isFinite(f.properties.LABEL_X) && Number.isFinite(f.properties.LABEL_Y))
            .map((f) => ({type: 'Feature', properties: {NAME: f.properties.NAME, rank: f.properties.LABELRANK},
                geometry: {type: 'Point', coordinates: [f.properties.LABEL_X, f.properties.LABEL_Y]}}))};

        // Place-name search index from the bundled Natural Earth names (self-hosted, no third party).
        this._places = this._ne.features.map((f) => {
            const name = f.properties.NAME;
            const b = bbox(f.geometry);
            const center = (Number.isFinite(f.properties.LABEL_X) && Number.isFinite(f.properties.LABEL_Y))
                ? [f.properties.LABEL_X, f.properties.LABEL_Y]
                : (b ? [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2] : null);
            return name && center ? {name, center, bbox: b, rank: f.properties.LABELRANK ?? 99} : null;
        }).filter(Boolean);

        const b = BODIES[this.body];
        this.map = new maplibregl.Map(Object.assign({
            container: opts.container,
            hash: opts.hash || false,
            center: b.home.center, zoom: b.home.zoom, maxPitch: 80,
            attributionControl: {compact: false},
            style: {
                version: 8,
                projection: {type: this.projection},
                glyphs: abs(this.M['gv-glyphs'].url),
                sky: b.sky && this.projection === 'globe' ? SKY : {'atmosphere-blend': 0},
                sources: {
                    'gv-ne': {type: 'geojson', data: this._ne, attribution: neEntry.attribution},
                    'gv-ne-labels': {type: 'geojson', data: this._neLabels}
                },
                layers: [
                    {id: 'gv-bg', type: 'background', paint: {'background-color': b.bg}},
                    ...['gv-slot-base', 'gv-slot-overlay', 'gv-slot-data', 'gv-slot-labels'].map((id) =>
                        ({id, type: 'background', layout: {visibility: 'none'}}))
                ]
            }
        }, opts.mapOptions));

        if (this._controls) {
            this.map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), 'top-right');
            this._scale = new maplibregl.ScaleControl({unit: 'metric'});
        }
        // The void around the globe shows the container's CSS background; default it to deep space.
        if (opts.background !== false) this.map.getContainer().style.background = opts.background || SPACE_BG;
        this.map.on('error', (e) => this.emit('error', e?.error || e));

        await once(this.map, 'load');
        await this.reprobe();          // fills this.probes and gates layers
        this._applyBody();
        if (this.usable(this._base)) this._enable(this._base);   // _enable honors the labels flag
        this.emit('ready', this);
    }

    // ---- probes --------------------------------------------------------------
    async reprobe() {
        await Promise.all(this._manifest.entries.map((e) => this._probeOne(e)));
        return this.probes;
    }
    async _probeOne(e) {
        const url = abs(e.probe).replace('{date}', this.date);
        const p = (this.probes[e.id] = {id: e.id, label: e.label, commercial: e.commercial,
            share_alike: e.share_alike, license: e.license, state: 'pending', url});
        this.emit('probe', p);
        const t0 = performance.now();
        try {
            const res = await fetch(url, {mode: 'cors', cache: 'no-store'});
            const buf = await res.arrayBuffer();
            Object.assign(p, {state: res.ok ? 'ok' : 'fail', status: res.status,
                type: res.headers.get('content-type') || '?', bytes: buf.byteLength, ms: Math.round(performance.now() - t0)});
            if (!res.ok) p.error = `HTTP ${res.status}`;
        } catch (err) {
            Object.assign(p, {state: 'fail', ms: Math.round(performance.now() - t0),
                error: `${err.message || err} (unreachable, or the host sends no CORS header)`});
        }
        this.emit('probe', p);
        return p;
    }

    // ---- layers --------------------------------------------------------------
    _ensureBuilt(key) {
        if (this._built.has(key)) return;
        const def = CATALOG[key];
        const {sources, layers} = def.build(this.M[def.manifest], {date: this.date, hosted: this._hosted});
        for (const [id, s] of Object.entries(sources)) if (!this.map.getSource(id)) this.map.addSource(id, s);
        for (const l of layers) this.map.addLayer(l, def.slot);
        def.layerIds = layers.map((l) => l.id);
        def.sourceIds = Object.keys(sources);
        this._built.add(key);
    }
    _enable(key) {
        this._ensureBuilt(key);
        const def = CATALOG[key];
        for (const id of def.layerIds) this._setVis(id, true);   // _setVis keeps text hidden when labels are off
        if (def.special === 'terrain') this.map.setTerrain({source: def.sourceIds[0], exaggeration: 1.5});
    }
    _disable(key) {
        if (!this._built.has(key)) return;
        const def = CATALOG[key];
        for (const id of def.layerIds) this._setVis(id, false);
        if (def.special === 'terrain') this.map.setTerrain(null);
    }

    /**
     * Turn an overlay / science layer on (or off with {on:false}). Resolves to the layer's
     * manifest record, rejects if the source's probe has not passed, with no silent fallback.
     */
    async addLayer(key, {on = true} = {}) {
        await this.ready;
        const def = CATALOG[key];
        if (!def) throw new Error(`Unknown layer: ${key}`);
        if (def.kind !== 'overlay') throw new Error(`"${key}" is a base layer; use setBase()`);
        if (def.body !== this.body) throw new Error(`Layer "${key}" belongs to ${def.body}, current body is ${this.body}`);
        if (on && !this.usable(key)) throw new Error(`Layer "${key}" is unavailable: its source probe did not pass`);
        if (on) { this._overlays.add(key); this._enable(key); } else { this._overlays.delete(key); this._disable(key); }
        return this.M[def.manifest];
    }
    removeLayer(key) { return this.addLayer(key, {on: false}); }

    /**
     * Show or hide the map's text labels (country and place names) — the globe's equivalent of the
     * named feature labels on a ShapeModel, so one control can drive both renderers. Labels stay
     * contextual: a symbol layer only shows when its own layer-group is active for the current body,
     * so e.g. Earth's country labels never appear on the Moon or Mars.
     */
    setLabels(on = true) {
        this._labels = !!on;
        for (const key of this._built) {
            const def = CATALOG[key];
            const shown = def.body === this.body &&
                (def.kind === 'base' ? this._base === key : this._overlays.has(key));
            for (const id of def.layerIds) this._setVis(id, shown);
        }
        this.emit('labels', this._labels);
        return this;
    }
    /** Whether the map's text labels are currently shown. */
    get labels() { return this._labels; }
    // Set a layer's visibility from its group's "shown" state, hiding text (symbol) layers when labels are off.
    _setVis(id, shown) {
        if (!this.map.getLayer(id)) return;
        const isLabel = this.map.getLayer(id).type === 'symbol';
        this.map.setLayoutProperty(id, 'visibility', shown && (!isLabel || this._labels) ? 'visible' : 'none');
    }

    /** Switch the active base layer for the current body. */
    async setBase(key) {
        await this.ready;
        const def = CATALOG[key];
        if (!def || def.kind !== 'base') throw new Error(`Unknown base: ${key}`);
        if (def.body !== this.body) throw new Error(`Base "${key}" belongs to ${def.body}, current body is ${this.body}`);
        if (!this.usable(key)) throw new Error(`Base "${key}" is unavailable: its source probe did not pass`);
        for (const other of this.basesFor()) if (other !== key) this._disable(other);
        this._base = key;
        this._enable(key);
        return this;
    }

    /** Switch worlds. Disables everything body-specific and flies the camera home. */
    async setBody(body, {base, fly = true} = {}) {
        await this.ready;
        if (!BODIES[body]) throw new Error(`Unknown body: ${body}`);
        for (const key of this.layersFor(this.body)) this._disable(key);
        this._overlays.clear();
        this.body = body;
        this._base = base || defaultBase(body);
        this._applyBody();
        if (this.usable(this._base)) this._enable(this._base);
        if (fly) this.map.jumpTo(BODIES[body].home);
        this.emit('body', body);
        return this;
    }

    /** 'globe' or 'mercator'. */
    async setProjection(type) {
        await this.ready;
        if (!['globe', 'mercator'].includes(type)) throw new Error(`Unknown projection: ${type}`);
        this.projection = type;
        this._applyBody();
        this._starfield?.redraw();   // globe-only; clears itself in mercator
        return this;
    }

    /** For time-aware layers (VIIRS): set the ISO day and re-point live tiles. */
    async setDate(day) {
        await this.ready;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('setDate expects YYYY-MM-DD');
        this.date = day;
        if (this._built.has('viirs')) this.map.getSource('viirs').setTiles([this.M['gibs-viirs'].url.replace('{date}', day)]);
        return this;
    }

    // ---- bring your own --------------------------------------------------------
    /**
     * Add a user-supplied layer, handled entirely in the browser. Nothing is uploaded.
     * Accepts a File/Blob or parsed object of GeoJSON, KML or GPX, a URL to one of those, an
     * XYZ raster tile template (a URL containing {z}/{x}/{y}), a PMTiles archive (.pmtiles,
     * vector or raster), or a GeoTIFF/COG (.tif/.tiff). KML and GPX are parsed to GeoJSON with
     * the browser's own DOMParser. Resolves to a descriptor with a probe result and an explicit
     * license note; rejects if the input cannot be read.
     */
    async addUserLayer(input, {id, fit = true} = {}) {
        await this.ready;
        const key = id || `user-${++this._userSeq}`;
        if (this._userLayers.has(key)) this.removeUserLayer(key);

        if (typeof input === 'string') {
            const url = input.trim();
            if (/\{z\}/i.test(url) && /\{x\}/i.test(url) && /\{y\}/i.test(url)) return this._addUserRaster(key, url);
            if (/\.pmtiles(\?|#|$)/i.test(url)) return this.addPMTiles(url, {id: key, fit});
            if (/\.tiff?(\?|#|$)/i.test(url)) return this.addGeoTIFF(url, {id: key, fit});
            if (/\.(png|jpe?g|webp)(\?|#|$)/i.test(url)) return this.addUserWorld(url, {id: key});   // whole-planet texture
            const res = await fetch(url, {cache: 'no-store'});
            if (!res.ok) throw new Error(`Could not fetch layer: HTTP ${res.status}`);
            const data = parseVector(url, await res.text());
            if (!data) throw new Error(`${url}: could not read as GeoJSON, KML or GPX.`);
            return this._addUserGeoJSON(key, data, {fit, origin: url});
        }
        if (input && typeof input.text === 'function') {           // File / Blob
            const name = input.name || 'file';
            if (/\.pmtiles$/i.test(name)) return this.addPMTiles(input, {id: key, fit});
            if (/\.tiff?$/i.test(name)) return this.addGeoTIFF(input, {id: key, fit});
            if ((input.type && input.type.startsWith('image/')) || /\.(png|jpe?g|webp)$/i.test(name)) return this.addUserWorld(input, {id: key});
            const data = parseVector(name, await input.text());
            if (!data) throw new Error(`${name}: could not read as GeoJSON, KML or GPX.`);
            return this._addUserGeoJSON(key, data, {fit, origin: name});
        }
        if (input && typeof input === 'object' && input.type) return this._addUserGeoJSON(key, input, {fit, origin: 'object'});
        throw new Error('addUserLayer expects a GeoJSON/KML/GPX File, a GeoJSON object, a file URL, or an {z}/{x}/{y} tile template');
    }

    _addUserGeoJSON(key, data, {fit, origin}) {
        const sourceId = `gv-${key}`;
        this.map.addSource(sourceId, {type: 'geojson', data});
        const layerIds = [`${key}-fill`, `${key}-line`, `${key}-circle`];
        this.map.addLayer({id: layerIds[0], type: 'fill', source: sourceId, filter: ['==', ['geometry-type'], 'Polygon'],
            paint: {'fill-color': '#22c55e', 'fill-opacity': 0.25}}, 'gv-slot-data');
        this.map.addLayer({id: layerIds[1], type: 'line', source: sourceId, filter: ['match', ['geometry-type'], ['LineString', 'Polygon'], true, false],
            paint: {'line-color': '#4ade80', 'line-width': 1.6}}, 'gv-slot-data');
        this.map.addLayer({id: layerIds[2], type: 'circle', source: sourceId, filter: ['==', ['geometry-type'], 'Point'],
            paint: {'circle-radius': 5, 'circle-color': '#22c55e', 'circle-stroke-color': '#06110a', 'circle-stroke-width': 1.5}}, 'gv-slot-data');
        const desc = {id: key, kind: 'geojson', sourceId, layerIds, origin,
            license: 'user-supplied, license unknown', probe: {state: 'ok', source: 'read in the browser'}};
        this._userLayers.set(key, desc);
        const b = bbox(data);
        if (fit && b) this.map.fitBounds(b, {padding: 48, maxZoom: 9, duration: 900});
        this.emit('userlayer', desc);
        return desc;
    }

    _addUserRaster(key, url) {
        const sourceId = `gv-${key}`;
        this.map.addSource(sourceId, {type: 'raster', tiles: [url], tileSize: 256});
        const layerIds = [key];
        this.map.addLayer({id: key, type: 'raster', source: sourceId, paint: {'raster-opacity': 0.9}}, 'gv-slot-overlay');
        const desc = {id: key, kind: 'raster', sourceId, layerIds, origin: url,
            license: 'user-supplied, license unknown', probe: {state: 'ok', source: 'tile template'}};
        this._userLayers.set(key, desc);
        this.emit('userlayer', desc);
        return desc;
    }

    /**
     * Add a PMTiles archive (a single-file tile set, vector MVT or raster), read in the browser
     * over HTTP range requests or straight from a dropped File. Nothing is uploaded. The v3 header
     * tells us the tile type, zoom range and footprint; vector archives get generic fill/line/circle
     * layers per vector_layer, raster archives a raster layer.
     * @param input a .pmtiles URL or a File/Blob
     * @returns descriptor {id, kind:'pmtiles', tileType, sourceId, layerIds, bounds, license}
     */
    async addPMTiles(input, {id, fit = true} = {}) {
        await this.ready;
        const key = id || `user-${++this._userSeq}`;
        if (this._userLayers.has(key)) this.removeUserLayer(key);
        const reg = ensurePMTiles();
        const origin = typeof input === 'string' ? input.trim() : (input.name || 'file.pmtiles');
        const source = typeof input === 'string' ? new RangeSource(origin) : new BlobSource(input);
        const arc = reg.add(key, source);
        const h = await arc.header();
        const meta = await arc.metadata().catch(() => ({}));
        const sourceId = `gv-${key}`;
        const tilesUrl = `pmtiles://${key}/{z}/{x}/{y}`;
        const layerIds = [];

        if (h.tileType === 'mvt') {
            this.map.addSource(sourceId, {type: 'vector', tiles: [tilesUrl], minzoom: h.minZoom, maxzoom: h.maxZoom});
            const vlayers = meta.vector_layers?.length ? meta.vector_layers : [{id: 'default'}];
            const palette = ['#22c55e', '#38bdf8', '#f59e0b', '#a78bfa', '#f472b6', '#34d399'];
            vlayers.forEach((vl, i) => {
                const c = palette[i % palette.length];
                const fill = `${key}-${vl.id}-fill`, line = `${key}-${vl.id}-line`, circ = `${key}-${vl.id}-circle`;
                this.map.addLayer({id: fill, type: 'fill', source: sourceId, 'source-layer': vl.id, filter: ['==', ['geometry-type'], 'Polygon'], paint: {'fill-color': c, 'fill-opacity': 0.18}}, 'gv-slot-data');
                this.map.addLayer({id: line, type: 'line', source: sourceId, 'source-layer': vl.id, filter: ['match', ['geometry-type'], ['LineString', 'Polygon'], true, false], paint: {'line-color': c, 'line-width': 1.2}}, 'gv-slot-data');
                this.map.addLayer({id: circ, type: 'circle', source: sourceId, 'source-layer': vl.id, filter: ['==', ['geometry-type'], 'Point'], paint: {'circle-radius': 3.5, 'circle-color': c, 'circle-stroke-color': '#06110a', 'circle-stroke-width': 1}}, 'gv-slot-data');
                layerIds.push(fill, line, circ);
            });
        } else if (['png', 'jpeg', 'webp'].includes(h.tileType)) {
            this.map.addSource(sourceId, {type: 'raster', tiles: [tilesUrl], tileSize: 256, minzoom: h.minZoom, maxzoom: h.maxZoom});
            this.map.addLayer({id: `${key}-raster`, type: 'raster', source: sourceId, paint: {'raster-opacity': 0.95}}, 'gv-slot-overlay');
            layerIds.push(`${key}-raster`);
        } else {
            reg.remove(key);
            throw new Error(`PMTiles tile type "${h.tileType}" is not drawable (expected mvt, png, jpeg or webp)`);
        }

        const bounds = [[h.minLon, h.minLat], [h.maxLon, h.maxLat]];
        const desc = {id: key, kind: 'pmtiles', tileType: h.tileType, sourceId, layerIds, origin, bounds,
            minZoom: h.minZoom, maxZoom: h.maxZoom, license: 'user-supplied, license unknown',
            probe: {state: 'ok', source: typeof input === 'string' ? 'range requests' : 'dropped file'},
            cleanup: () => reg.remove(key)};
        this._userLayers.set(key, desc);
        if (fit && isFinite(h.minLon)) this.map.fitBounds(bounds, {padding: 48, maxZoom: Math.min(9, h.maxZoom), duration: 900});
        this.emit('userlayer', desc);
        return desc;
    }

    /**
     * Add a GeoTIFF / Cloud-Optimized GeoTIFF, decoded in the browser. Nothing is uploaded. We read
     * the IFDs (classic and BigTIFF), decode none/Deflate/LZW/PackBits, read the GeoKeys for the
     * footprint and CRS, and place the image on the globe with a MapLibre image source. EPSG:4326 and
     * EPSG:3857 are handled directly; reproject other CRSs first (gdalwarp -t_srs EPSG:4326).
     * @param input a .tif/.tiff URL or a File/Blob
     * @returns descriptor {id, kind:'geotiff', sourceId, layerIds, crs, epsg, corners, size, license}
     */
    async addGeoTIFF(input, {id, fit = true} = {}) {
        await this.ready;
        const key = id || `user-${++this._userSeq}`;
        if (this._userLayers.has(key)) this.removeUserLayer(key);
        const origin = typeof input === 'string' ? input.trim() : (input.name || 'file.tif');
        let buffer;
        if (typeof input === 'string') {
            const res = await fetch(origin, {cache: 'no-store'});
            if (!res.ok) throw new Error(`Could not fetch GeoTIFF: HTTP ${res.status}`);
            buffer = await res.arrayBuffer();
        } else {
            buffer = await input.arrayBuffer();
        }
        const g = await loadGeoTIFF(buffer);
        const url = await canvasToDataURL(g.canvas);
        const sourceId = `gv-${key}`;
        this.map.addSource(sourceId, {type: 'image', url, coordinates: g.corners});
        this.map.addLayer({id: `${key}-image`, type: 'raster', source: sourceId, paint: {'raster-opacity': 0.9, 'raster-fade-duration': 0}}, 'gv-slot-overlay');
        const desc = {id: key, kind: 'geotiff', sourceId, layerIds: [`${key}-image`], origin,
            crs: g.crs, epsg: g.epsg, corners: g.corners, bands: g.bands, bits: g.bits,
            size: [g.width, g.height], render: [g.renderWidth, g.renderHeight], overview: g.overview,
            license: 'user-supplied, license unknown', probe: {state: 'ok', source: `GeoTIFF ${g.crs}`}};
        this._userLayers.set(key, desc);
        if (fit) {
            const lons = g.corners.map((c) => c[0]), lats = g.corners.map((c) => c[1]);
            this.map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {padding: 48, maxZoom: 9, duration: 900});
        }
        this.emit('userlayer', desc);
        return desc;
    }

    removeUserLayer(key) {
        const d = this._userLayers.get(key);
        if (!d) return false;
        for (const id of d.layerIds) if (this.map.getLayer(id)) this.map.removeLayer(id);
        if (this.map.getSource(d.sourceId)) this.map.removeSource(d.sourceId);
        d.cleanup?.();
        this._userLayers.delete(key);
        return true;
    }
    userLayers() { return [...this._userLayers.values()]; }

    /**
     * Load a whole-planet equirectangular image (plate carree, 2:1, lon -180..180 x lat +90..-90)
     * as the globe's surface, wrapped on the sphere in the browser with no tile server. Lets a
     * modeller build an imaginary world (speculation, games, anything), export the texture, and map
     * it here. Accepts a File/Blob, an image URL, or an ImageBitmap/canvas/<img>. Use
     * GlobeMap.sphereTemplate() to generate a guide to paint on.
     * @returns {{id, sourceId, kind, width, height}}
     */
    async addUserWorld(input, {id = 'user-world'} = {}) {
        await this.ready;
        const reg = ensureWorld();
        let bitmap;
        if (typeof input === 'string') {
            const res = await fetch(input, {cache: 'no-store'});
            if (!res.ok) throw new Error(`Could not fetch world image: HTTP ${res.status}`);
            bitmap = await createImageBitmap(await res.blob());
        } else if (input instanceof Blob || (input && typeof input.arrayBuffer === 'function')) {
            bitmap = await createImageBitmap(input);
        } else if (input && (input.width != null) && (input instanceof ImageBitmap || typeof input.getContext === 'function' || input.tagName === 'IMG')) {
            bitmap = input;
        } else {
            throw new Error('addUserWorld expects an equirectangular image: a File/Blob, an image URL, or an ImageBitmap/canvas/img');
        }
        const src = `gv-world-${id}`;
        if (this.map.getLayer(src)) this.map.removeLayer(src);
        if (this.map.getSource(src)) this.map.removeSource(src);
        reg.set(id, bitmap);
        const w = bitmap.width || 2048;
        const maxzoom = Math.min(7, Math.max(2, Math.round(Math.log2(w / 512)) + 1));
        this.map.addSource(src, {type: 'raster', tiles: [`gvworld://${id}/{z}/{x}/{y}`], tileSize: 256, maxzoom});
        this.map.addLayer({id: src, type: 'raster', source: src}, 'gv-slot-overlay');   // over the base, under overlays
        const desc = {id, sourceId: src, kind: 'world', width: bitmap.width, height: bitmap.height};
        (this._userWorlds || (this._userWorlds = new Map())).set(id, desc);
        this.emit('userworld', desc);
        return desc;
    }
    removeUserWorld(id = 'user-world') {
        const src = `gv-world-${id}`;
        if (this.map.getLayer(src)) this.map.removeLayer(src);
        if (this.map.getSource(src)) this.map.removeSource(src);
        ensureWorld().remove(id);
        this._userWorlds?.delete(id);
        return true;
    }
    userWorlds() { return [...(this._userWorlds?.values() || [])]; }

    /**
     * Generate an equirectangular "paint your planet" template (a canvas) with a labelled lat/lng
     * graticule, equator and prime meridian. Export it, paint a world over it, and load the result
     * with addUserWorld(). Default 2048x1024 (2:1).
     */
    static sphereTemplate({width = 2048, height = Math.round(width / 2), step = 30, water = '#10243a'} = {}) {
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        const ctx = c.getContext('2d');
        ctx.fillStyle = water; ctx.fillRect(0, 0, width, height);
        const fs = Math.max(10, Math.round(height / 64));
        ctx.font = `${fs}px monospace`; ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.fillStyle = 'rgba(255,255,255,.5)';
        for (let lon = -180; lon <= 180; lon += step) {
            const x = ((lon + 180) / 360) * width;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
            ctx.fillText(`${lon}`, Math.min(width - fs * 3, x + 3), fs + 2);
        }
        for (let lat = 90; lat >= -90; lat -= step) {
            const y = ((90 - lat) / 180) * height;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
            ctx.fillText(`${lat}`, 3, Math.max(fs, y - 3));
        }
        ctx.strokeStyle = 'rgba(126,230,166,.5)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();   // equator
        ctx.beginPath(); ctx.moveTo(width / 2, 0); ctx.lineTo(width / 2, height); ctx.stroke();     // prime meridian
        ctx.fillStyle = 'rgba(255,255,255,.6)';
        ctx.fillText('Equirectangular (plate carree), 2:1. Paint your world, then GlobeMap.addUserWorld(image).', 8, height - 8);
        return c;
    }

    // ---- place search ----------------------------------------------------------
    /**
     * Search bundled place names (currently Natural Earth countries). Place-name grade, not
     * address grade, and fully self-hosted, so no request leaves the page. Returns ranked matches
     * [{name, center:[lng,lat], bbox}]. Earth only.
     */
    search(query, {limit = 8} = {}) {
        const q = String(query || '').trim().toLowerCase();
        if (!q || this.body !== 'earth') return [];
        const scored = [];
        for (const p of this._places) {
            const name = p.name.toLowerCase();
            const i = name.indexOf(q);
            if (i < 0) continue;
            // exact < starts-with < word-start < substring, then by Natural Earth label rank
            const score = (name === q ? 0 : i === 0 ? 1 : name.includes(' ' + q) ? 2 : 3) * 100 + (p.rank || 0);
            scored.push({...p, score});
        }
        return scored.sort((a, b) => a.score - b.score).slice(0, limit)
            .map(({score, ...p}) => p);
    }

    /** Fly to a search result (or any {center, bbox}). */
    flyToPlace(place) {
        if (!place) return this;
        if (place.bbox) this.map.fitBounds(place.bbox, {padding: 64, maxZoom: 6, duration: 1200});
        else this.map.flyTo({center: place.center, zoom: 4, duration: 1200});
        return this;
    }

    // ---- draw & measure --------------------------------------------------------
    /**
     * Start an interactive drawing session on the map. Click to add vertices; for lines and
     * polygons double-click or press Enter to finish, Escape to cancel. Measures geodesic
     * length (km) for lines and spherical area (km²) for polygons. Returns a controller:
     *   draw.start(mode) · draw.clear() · draw.stop() · draw.on('finish', cb) · draw.features
     */
    draw({mode = 'linestring'} = {}) {
        if (this._draw) { this._draw.start(mode); return this._draw; }
        this._ensureDrawLayers();
        const self = this, map = this.map;
        const finished = {type: 'FeatureCollection', features: []};
        const listeners = {finish: new Set()};
        let active = mode, verts = [], drawing = false;

        const measure = (geom) => geom.type === 'LineString'
            ? {length_km: +(lineLength(geom.coordinates) / 1000).toFixed(3)}
            : {area_km2: +(ringArea(geom.coordinates[0]) / 1e6).toFixed(3), length_km: +(lineLength(geom.coordinates[0]) / 1000).toFixed(3)};

        const live = () => {
            const pts = {type: 'FeatureCollection', features: verts.map((c, i) =>
                ({type: 'Feature', properties: {i}, geometry: {type: 'Point', coordinates: c}}))};
            let line = {type: 'FeatureCollection', features: []};
            const labels = [];
            if (verts.length >= 2) {
                const coords = active === 'polygon' ? [...verts, verts[0]] : verts;
                const geom = active === 'polygon'
                    ? {type: 'Polygon', coordinates: [coords]} : {type: 'LineString', coordinates: coords};
                line = {type: 'Feature', geometry: geom, properties: {}};
                const m = measure(geom);
                const text = active === 'polygon' ? `${fmt(m.area_km2)} km²` : `${fmt(m.length_km)} km`;
                labels.push({type: 'Feature', properties: {text}, geometry: {type: 'Point', coordinates: verts[verts.length - 1]}});
            }
            map.getSource('gv-draw-line').setData(line);
            map.getSource('gv-draw-pts').setData(pts);
            map.getSource('gv-draw-label').setData({type: 'FeatureCollection', features: labels});
        };
        const commit = () => {
            if (active === 'point' && verts.length) {
                finished.features.push({type: 'Feature', properties: {mode: 'point'}, geometry: {type: 'Point', coordinates: verts[0]}});
            } else if (active === 'linestring' && verts.length >= 2) {
                const geom = {type: 'LineString', coordinates: verts.slice()};
                finished.features.push({type: 'Feature', properties: {mode: 'line', ...measure(geom)}, geometry: geom});
            } else if (active === 'polygon' && verts.length >= 3) {
                const geom = {type: 'Polygon', coordinates: [[...verts, verts[0]]]};
                finished.features.push({type: 'Feature', properties: {mode: 'polygon', ...measure(geom)}, geometry: geom});
            } else { reset(); return; }
            const f = finished.features[finished.features.length - 1];
            map.getSource('gv-draw-done').setData(finished);
            for (const cb of listeners.finish) cb(f);
            reset();
        };
        const reset = () => { verts = []; drawing = false; live(); };

        const onClick = (e) => {
            verts.push([e.lngLat.lng, e.lngLat.lat]); drawing = true;
            if (active === 'point') return commit();
            live();
        };
        const onDbl = (e) => { if (drawing) { e.preventDefault(); commit(); } };
        const onKey = (e) => {
            if (e.key === 'Enter' && drawing) commit();
            else if (e.key === 'Escape') reset();
        };

        map.on('click', onClick);
        map.on('dblclick', onDbl);
        window.addEventListener('keydown', onKey);
        map.getCanvas().style.cursor = 'crosshair';

        this._draw = {
            get features() { return finished.features.slice(); },
            start(m) { active = m || active; reset(); return this; },
            clear() { finished.features = []; map.getSource('gv-draw-done').setData(finished); reset(); return this; },
            stop() {
                map.off('click', onClick); map.off('dblclick', onDbl); window.removeEventListener('keydown', onKey);
                map.getCanvas().style.cursor = ''; reset(); self._draw = null;
            },
            on(ev, cb) { listeners[ev]?.add(cb); return this; }
        };
        this._draw.start(mode);
        this.emit('draw', this._draw);
        return this._draw;
    }

    _ensureDrawLayers() {
        if (this._built.has('__draw')) return;
        const empty = () => ({type: 'FeatureCollection', features: []});
        for (const id of ['gv-draw-done', 'gv-draw-line', 'gv-draw-pts', 'gv-draw-label']) this.map.addSource(id, {type: 'geojson', data: empty()});
        this.map.addLayer({id: 'gv-draw-done-fill', type: 'fill', source: 'gv-draw-done', filter: ['==', ['geometry-type'], 'Polygon'],
            paint: {'fill-color': '#38bdf8', 'fill-opacity': 0.18}});
        this.map.addLayer({id: 'gv-draw-done-line', type: 'line', source: 'gv-draw-done', filter: ['match', ['geometry-type'], ['LineString', 'Polygon'], true, false],
            paint: {'line-color': '#38bdf8', 'line-width': 2}});
        this.map.addLayer({id: 'gv-draw-done-pt', type: 'circle', source: 'gv-draw-done', filter: ['==', ['geometry-type'], 'Point'],
            paint: {'circle-radius': 5, 'circle-color': '#38bdf8', 'circle-stroke-color': '#06121a', 'circle-stroke-width': 1.5}});
        this.map.addLayer({id: 'gv-draw-line', type: 'line', source: 'gv-draw-line',
            paint: {'line-color': '#7dd3fc', 'line-width': 1.6, 'line-dasharray': [2, 1]}});
        this.map.addLayer({id: 'gv-draw-pts', type: 'circle', source: 'gv-draw-pts',
            paint: {'circle-radius': 4, 'circle-color': '#e0f2fe', 'circle-stroke-color': '#06121a', 'circle-stroke-width': 1.5}});
        this.map.addLayer({id: 'gv-draw-label', type: 'symbol', source: 'gv-draw-label',
            layout: {'text-field': ['get', 'text'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, -1.2], 'text-anchor': 'bottom'},
            paint: {'text-color': '#e0f2fe', 'text-halo-color': 'rgba(6,18,26,.9)', 'text-halo-width': 1.4}});
        this._built.add('__draw');
    }

    // ---- time-series animation -------------------------------------------------
    /** ISO days available for a time-aware layer (VIIRS daily), newest last. */
    timesteps(layerKey = 'viirs', {days = 7} = {}) {
        if (layerKey !== 'viirs') return [];
        const out = [];
        for (let i = days; i >= 2; i--) out.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)); // VIIRS has ~1 day latency
        return out;
    }
    /** Point a time-aware layer at one timestep. */
    async setLayerTime(layerKey, day) { if (layerKey === 'viirs') return this.setDate(day); return this; }
    /**
     * Step a time-aware layer through its timesteps. Returns a controller {stop()}.
     * onStep(day, index) fires on each frame. Requires the layer's base to be enabled.
     */
    playTimesteps(layerKey = 'viirs', {days = 7, intervalMs = 900, loop = true, onStep} = {}) {
        const steps = this.timesteps(layerKey, {days});
        let i = 0, stopped = false;
        const tick = async () => {
            if (stopped || !steps.length) return;
            const day = steps[i];
            await this.setLayerTime(layerKey, day);
            onStep?.(day, i);
            i++;
            if (i >= steps.length) { if (!loop) { stopped = true; return; } i = 0; }
            this._timeTimer = setTimeout(tick, intervalMs);
        };
        clearTimeout(this._timeTimer);
        tick();
        return {stop: () => { stopped = true; clearTimeout(this._timeTimer); }};
    }

    // ---- wind / current particles ----------------------------------------------
    /**
     * Animate a flowing particle field over the map. Works on both the globe and mercator,
     * because particles live in geographic coordinates and are projected each frame.
     *
     * IMPORTANT: the default field is an ILLUSTRATIVE analytic flow, not a weather forecast.
     * Pass your own `field(lng, lat) => [u, v]` (degrees/second) to drive it from real data.
     * Returns a controller { stop() }.
     */
    addParticles({count = 2000, color = '#bfe9ff', field = defaultFlowField, speed = 1, trail = 0.14} = {}) {
        this.removeParticles();
        const map = this.map;
        const canvas = document.createElement('canvas');
        canvas.className = 'gv-particles';
        canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2;';
        map.getCanvasContainer().appendChild(canvas);
        const ctx = canvas.getContext('2d');
        const dpr = Math.min(2, window.devicePixelRatio || 1);

        const randPos = () => ({lng: Math.random() * 360 - 180, lat: Math.random() * 150 - 75, age: Math.random() * 100 | 0});
        let particles = Array.from({length: count}, randPos);

        const fit = () => {
            const c = map.getCanvas();
            canvas.width = c.width; canvas.height = c.height;
            canvas.style.width = c.style.width || c.clientWidth + 'px';
            canvas.style.height = c.style.height || c.clientHeight + 'px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        };
        fit();

        let raf = 0, last = performance.now(), stopped = false, moving = false;
        const onMoveStart = () => { moving = true; ctx.clearRect(0, 0, canvas.width, canvas.height); };
        const onMoveEnd = () => { moving = false; };
        map.on('movestart', onMoveStart);
        map.on('moveend', onMoveEnd);
        map.on('resize', fit);

        const w = () => canvas.width / dpr, h = () => canvas.height / dpr;
        const frame = (now) => {
            if (stopped) return;
            const dt = Math.min(0.05, (now - last) / 1000); last = now;
            // Fade existing trails toward transparent (destination-out on a transparent canvas).
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = `rgba(0,0,0,${trail})`;
            ctx.fillRect(0, 0, w(), h());
            ctx.globalCompositeOperation = 'source-over';
            if (!moving) {
                ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
                for (const p of particles) {
                    const [u, v] = field(p.lng, p.lat);
                    const nlng = p.lng + u * speed * dt, nlat = Math.max(-85, Math.min(85, p.lat + v * speed * dt));
                    const a = map.project([p.lng, p.lat]), b = map.project([nlng, nlat]);
                    if (++p.age > 120 || Math.hypot(b.x - a.x, b.y - a.y) > 40) { Object.assign(p, randPos()); continue; }
                    p.lng = nlng > 180 ? nlng - 360 : nlng < -180 ? nlng + 360 : nlng; p.lat = nlat;
                    if (a.x >= 0 && a.x <= w() && a.y >= 0 && a.y <= h()) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
                }
                ctx.stroke();
            }
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);

        this._particles = {stop: () => {
            stopped = true; cancelAnimationFrame(raf);
            map.off('movestart', onMoveStart); map.off('moveend', onMoveEnd); map.off('resize', fit);
            canvas.remove(); this._particles = null;
        }};
        this.emit('particles', this._particles);
        return this._particles;
    }
    removeParticles() { this._particles?.stop(); }

    // ---- celestial sky (delegates to the shared src/starfield.js renderer) ------
    /**
     * Draw the real celestial sky around the current body: catalogue stars coloured by B-V, the
     * Milky Way, Sun/Moon/planets by ephemeris, constellations, labels, an RA/Dec grid and the
     * ecliptic. Oriented by the body's IAU pole + prime meridian for `time`, projected to the globe
     * and occluded by the planet. See src/starfield.js and src/celestial.js.
     * @param {object} [opts] time, magLimit, catalog, and layer flags (stars, milkyWay, planets,
     *   sun, moon, deepSky, constellations, starLabels, grid, ecliptic). By default the other
     *   reachable worlds (Earth, Moon, Mars) show up as clickable travel hotspots in the sky, which
     *   fly to that body via travelTo(); pass hotspots:false to disable, or your own onTravel.
     */
    async addStarfield(opts = {}) {
        await this.ready;
        this.removeStarfield();
        const {hotspots = true, ...rest} = opts;
        const defaults = hotspots
            ? {navigable: Object.keys(BODIES), onTravel: (body) => this.travelTo(body)}
            : {};
        this._starfield = createStarfield(this.map, {getBody: () => this.body, ...defaults, ...rest});
        this.emit('starfield', this._starfield);
        return this._starfield;
    }
    removeStarfield() { this._starfield?.stop(); this._starfield = null; }

    /**
     * Fly to another body by clicking it in the sky: a short zoom-in toward the target, then the
     * model swaps to that world and the camera eases out to its home view. No-op for an unknown body
     * or the one already shown. Emits 'travel' then 'body'.
     */
    async travelTo(body) {
        await this.ready;
        if (!BODIES[body] || body === this.body) return this;
        this.emit('travel', body);
        const z = this.map.getZoom();
        this.map.easeTo({zoom: Math.min(z + 1.6, 5), duration: 620, easing: (t) => t * (2 - t)});   // approach
        await new Promise((r) => setTimeout(r, 600));
        await this.setBody(body, {fly: false});                                                      // swap world
        const home = BODIES[body].home;
        this.map.jumpTo({...home, zoom: home.zoom + 1.9});                                           // arrive close
        this.map.easeTo({...home, duration: 1100, easing: (t) => 1 - Math.pow(1 - t, 3)});           // then pull back
        this._starfield?.redraw();
        return this;
    }

    /** Shade the real night side of the body (day/night terminator). */
    async addTerminator(opts = {}) {
        await this.ready;
        this.removeTerminator();
        this._terminator = createTerminator(this.map, {getBody: () => this.body, beforeId: 'gv-slot-data', ...opts});
        return this._terminator;
    }
    removeTerminator() { this._terminator?.stop(); this._terminator = null; }

    _applyBody() {
        const b = BODIES[this.body];
        this.map.setPaintProperty('gv-bg', 'background-color', b.bg);
        this.map.setProjection({type: this.projection});
        this.map.setSky(b.sky && this.projection === 'globe' ? SKY : {'atmosphere-blend': 0});
        if (this._scale) {
            const want = this.body === 'earth';
            if (want && !this._scaleOn) { this.map.addControl(this._scale, 'bottom-right'); this._scaleOn = true; }
            else if (!want && this._scaleOn) { this.map.removeControl(this._scale); this._scaleOn = false; }
        }
    }

    // Thin passthroughs so callers rarely need .maplibre directly.
    flyTo(opts) { this.map.flyTo(opts); return this; }
    jumpTo(opts) { this.map.jumpTo(opts); return this; }
    resize() { this.map?.resize(); return this; }
    remove() { this.map?.remove(); this.map = null; }

    static version() { return maplibregl.getVersion(); }
}

function defaultBase(body) {
    return {earth: 'base-open', moon: 'moon-wac', mars: 'mars-viking'}[body];
}

// GeoJSON/KML/GPX parsing and bbox live in src/vectorparse.js, shared with the mesh renderer
// (ShapeModel) so bring-your-own-data reads the same on any surface. `bbox` is `bounds`, imported above.

const R_EARTH = 6371008.8;   // mean Earth radius (m); the renderer always assumes Earth
const rad = (d) => (d * Math.PI) / 180;

// Great-circle distance (m) between two [lng, lat] points.
function haversine([lng1, lat1], [lng2, lat2]) {
    const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}
function lineLength(coords) {
    let m = 0;
    for (let i = 1; i < coords.length; i++) m += haversine(coords[i - 1], coords[i]);
    return m;
}
// Spherical polygon area (m²) of a closed ring, via the shoelace formula on the sphere.
function ringArea(ring) {
    if (ring.length < 4) return 0;
    let total = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const [lng1, lat1] = ring[i], [lng2, lat2] = ring[i + 1];
        total += rad(lng2 - lng1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
    }
    return Math.abs((total * R_EARTH * R_EARTH) / 2);
}
const fmt = (n) => (n >= 1000 ? Math.round(n).toLocaleString() : n >= 1 ? n.toFixed(1) : n.toFixed(3));

// ILLUSTRATIVE flow field (degrees/second), NOT real weather. Mimics banded zonal winds
// (easterlies in the tropics, westerlies in the mid-latitudes) with a little swirl, so the
// particle renderer has something plausible to move until it is wired to real GFS data.
function defaultFlowField(lng, lat) {
    const band = Math.sin(rad(lat * 3));                 // alternating E/W bands by latitude
    const swirl = Math.cos(rad(lng * 2 + lat));
    const u = 9 * band + 2.5 * swirl;
    const v = 2.2 * Math.sin(rad(lng * 2)) * Math.cos(rad(lat));
    return [u, v];
}
function once(emitter, type) {
    return new Promise((resolve) => emitter.once(type, resolve));
}

export {maplibregl, ShapeModel};
export default GlobeMap;
