// Equirectangular -> Web Mercator tile reprojection, done in the browser.
//
// Planetary mosaics (NASA Trek) are cut as equirectangular tiles: 2 columns x 1 row at
// level 0. MapLibre draws Web Mercator tiles. This registers a `gveq://` protocol that
// builds each Mercator tile on a canvas from the equirectangular tiles that cover it, so
// the same globe renderer can show any body without a tile server in between.
//
//   tiles: ['gveq://<source-id>/{z}/{x}/{y}']
//
// Longitude is linear in both grids, so only rows are resampled (one strip per output row).
// Nothing exists above 85.05 degrees latitude in Web Mercator: the polar caps are a known
// limitation of this approach.

const OUT = 256;
const CACHE_MAX = 96;

/** Latitude (degrees) of a Web Mercator y fraction (0 = top, 1 = bottom). */
export function mercatorYToLat(yFrac) {
    return (Math.atan(Math.sinh(Math.PI * (1 - 2 * yFrac))) * 180) / Math.PI;
}

/** Which equirectangular level and tiles a Mercator tile needs. Pure, used by the tests. */
export function planTile(z, x, y, maxEqZoom) {
    const ze = Math.max(0, Math.min(maxEqZoom, z - 1));
    const n = 2 ** z;
    const cols = 2 ** (ze + 1);
    const rows = 2 ** ze;
    const lonW = (x / n) * 360 - 180;
    const lonE = ((x + 1) / n) * 360 - 180;
    const latN = mercatorYToLat(y / n);
    const latS = mercatorYToLat((y + 1) / n);
    // Positions in units of equirectangular tiles.
    const u0 = ((lonW + 180) / 360) * cols;
    const u1 = ((lonE + 180) / 360) * cols;
    const v0 = ((90 - latN) / 180) * rows;
    const v1 = ((90 - latS) / 180) * rows;
    const eps = 1e-9;
    return {
        ze, cols, rows, u0, u1, v0, v1,
        c0: Math.max(0, Math.floor(u0 + eps)),
        c1: Math.min(cols - 1, Math.floor(u1 - eps)),
        r0: Math.max(0, Math.floor(v0 + eps)),
        r1: Math.min(rows - 1, Math.floor(v1 - eps))
    };
}

/**
 * @param maplibregl the maplibre-gl module
 * @param getSource (id) => {url, maxEquirectZoom} | undefined; url has {z} {row} {col}
 * @param stats optional {eqRequests, eqErrors} counters
 */
export function registerEquirectProtocol(maplibregl, getSource, stats = {}) {
    const cache = new Map();

    function loadEq(url, signal) {
        let p = cache.get(url);
        if (p) return p;
        stats.eqRequests = (stats.eqRequests || 0) + 1;
        p = fetch(url, {mode: 'cors', signal})
            .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
                return res.blob();
            })
            .then((blob) => createImageBitmap(blob))
            .catch((err) => {
                cache.delete(url);
                stats.eqErrors = (stats.eqErrors || 0) + 1;
                throw err;
            });
        cache.set(url, p);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return p;
    }

    maplibregl.addProtocol('gveq', async (params, abortController) => {
        const m = /^gveq:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url);
        if (!m) throw new Error(`Bad gveq url: ${params.url}`);
        const src = getSource(m[1]);
        if (!src) throw new Error(`gveq source not in manifest: ${m[1]}`);
        const z = +m[2], x = +m[3], y = +m[4];
        const plan = planTile(z, x, y, src.maxEquirectZoom);

        const jobs = [];
        for (let r = plan.r0; r <= plan.r1; r++) {
            for (let c = plan.c0; c <= plan.c1; c++) {
                const url = src.url.replace('{z}', plan.ze).replace('{row}', r).replace('{col}', c);
                jobs.push(loadEq(url, abortController.signal).then((bmp) => ({r, c, bmp})));
            }
        }
        const tiles = await Promise.all(jobs);
        const S = tiles[0].bmp.width;

        // Stitch the covering equirectangular tiles into one strip source.
        const stitched = new OffscreenCanvas((plan.c1 - plan.c0 + 1) * S, (plan.r1 - plan.r0 + 1) * S);
        const sctx = stitched.getContext('2d');
        for (const t of tiles) sctx.drawImage(t.bmp, (t.c - plan.c0) * S, (t.r - plan.r0) * S);

        const out = new OffscreenCanvas(OUT, OUT);
        const octx = out.getContext('2d');
        const sx = (plan.u0 - plan.c0) * S;
        const sw = (plan.u1 - plan.u0) * S;
        const n = 2 ** z;
        for (let j = 0; j < OUT; j++) {
            const lat = mercatorYToLat((y + (j + 0.5) / OUT) / n);
            const v = ((90 - lat) / 180) * plan.rows;
            let sy = Math.floor((v - plan.r0) * S);
            if (sy < 0) sy = 0;
            if (sy > stitched.height - 1) sy = stitched.height - 1;
            octx.drawImage(stitched, sx, sy, sw, 1, 0, j, OUT, 1);
        }
        return {data: await createImageBitmap(out)};
    });
}

/**
 * Register a `gvworld://` protocol that wraps a single whole-planet equirectangular image onto the
 * globe by resampling it into Web Mercator tiles in the browser. The image is plate carree: x spans
 * longitude -180..180, y spans latitude +90..-90, aspect 2:1. This is how a modeller's own planet
 * texture (for speculation, games, anything) loads with no tile server.
 *
 *   tiles: ['gvworld://<id>/{z}/{x}/{y}']
 *
 * Returns {set, has, remove} to register images by id (an ImageBitmap, canvas, or <img>).
 */
export function registerWorldProtocol(maplibregl) {
    const worlds = new Map();
    maplibregl.addProtocol('gvworld', async (params) => {
        const m = /^gvworld:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url);
        if (!m) throw new Error(`Bad gvworld url: ${params.url}`);
        const img = worlds.get(m[1]);
        if (!img) throw new Error(`gvworld image not loaded: ${m[1]}`);
        const z = +m[2], x = +m[3], y = +m[4], OUT = 256, n = 2 ** z;
        const lonW = (x / n) * 360 - 180, lonE = ((x + 1) / n) * 360 - 180;
        const out = new OffscreenCanvas(OUT, OUT);
        const octx = out.getContext('2d');
        const sx = ((lonW + 180) / 360) * img.width;         // longitude is linear in equirectangular
        const sw = ((lonE - lonW) / 360) * img.width;
        for (let j = 0; j < OUT; j++) {                       // resample one source row per output row
            const lat = mercatorYToLat((y + (j + 0.5) / OUT) / n);
            let sy = Math.floor(((90 - lat) / 180) * img.height);
            if (sy < 0) sy = 0;
            if (sy > img.height - 1) sy = img.height - 1;
            octx.drawImage(img, sx, sy, sw, 1, 0, j, OUT, 1);
        }
        return {data: await createImageBitmap(out)};
    });
    return {
        set: (id, bitmap) => worlds.set(id, bitmap),
        has: (id) => worlds.has(id),
        remove: (id) => worlds.delete(id)
    };
}
