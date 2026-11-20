// Minimal, real key + metering gateway for the /v1 routes. Dependency-free.
//
//   GET /v1/tiles/{body}/{tileset}/{z}/{x}/{y}?key=gv_pk_...
//   GET /v1/usage?key=gv_pk_...
//
// Each request is checked against the key store (keys.json): the key must exist, the caller's
// origin must be allowed, and the key must be under its per-minute rate limit. Usage is counted
// per key and persisted to usage.json, so totals survive a server restart.
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// Which {body}/{tileset} maps to which manifest entry. Earth raster XYZ only; the planetary
// mosaics need reprojection (see src/eqproj.js) and are not a straight redirect.
export const TILESETS = {
    'earth/bluemarble': 'gibs-bluemarble',
    'earth/s2': 'eox-s2-2016',
    'earth/viirs': 'gibs-viirs'
};

const json = (res, code, body) => { res.writeHead(code, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(body, null, 2)); };
const twoDaysAgo = () => new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);

// opts.allowOrigin — CORS policy for the browser SDK (ALLOW_ORIGIN env, passed in by serve.mjs).
// Unset or '*' allows any caller; a comma-separated list reflects the request Origin when it matches,
// so several site origins can share one gateway. The key + origin allow-list + rate limit are the real
// access controls; CORS just lets the browser read cross-origin responses (e.g. GET /v1/usage via fetch).
export async function makeKeyGateway(root, {allowOrigin = ''} = {}) {
    const corsList = String(allowOrigin || '*').split(',').map((s) => s.trim()).filter(Boolean);
    const corsAny = corsList.includes('*');
    // Set CORS headers for this request via setHeader(), so they survive the later writeHead()
    // (which only sets content-type/cache-control/Location). Returns the resolved Allow-Origin, or ''.
    const setCors = (req, res) => {
        const origin = corsAny ? '*' : (req.headers.origin && corsList.includes(req.headers.origin) ? req.headers.origin : '');
        if (!origin) return '';
        res.setHeader('access-control-allow-origin', origin);
        if (origin !== '*') res.setHeader('vary', 'Origin');
        res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
        res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
        res.setHeader('access-control-max-age', '86400');
        return origin;
    };

    let keys = {}, manifest = {}, catalog = null;
    try {
        const cfg = JSON.parse(await readFile(join(root, 'keys.json'), 'utf8'));
        keys = Object.fromEntries(cfg.keys.map((k) => [k.key, k]));
    } catch { /* no keys.json → gateway rejects every request with 401 */ }
    try {
        const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
        manifest = Object.fromEntries(m.entries.map((e) => [e.id, e]));
    } catch { /* manifest missing → tile routes 404 */ }
    try {
        catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'));
    } catch { /* no catalog.json → /v1/catalog 404s (run scripts/build-catalog.mjs) */ }

    // Usage persists across restarts: totals and per-day counts are saved to usage.json.
    // The per-minute rate-limit window is ephemeral and intentionally not persisted.
    const usageFile = join(root, 'usage.json');
    const usage = new Map();   // key -> {total, window:{minute,count}, days:{YYYY-MM-DD:count}}
    try {
        const saved = JSON.parse(await readFile(usageFile, 'utf8'));
        for (const [k, v] of Object.entries(saved)) usage.set(k, {total: v.total || 0, window: {minute: 0, count: 0}, days: v.days || {}});
    } catch { /* no prior usage → start empty */ }

    let saveTimer = null, dirty = false;
    const flush = async () => {
        saveTimer = null; if (!dirty) return; dirty = false;
        const out = {};
        for (const [k, u] of usage) out[k] = {total: u.total, days: u.days};
        try { await writeFile(usageFile, JSON.stringify(out, null, 2)); } catch { /* best effort */ }
    };
    const scheduleSave = () => { dirty = true; if (!saveTimer) saveTimer = setTimeout(flush, 1500); };
    // Flush pending usage on a clean shutdown so the last few requests aren't lost.
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => { await flush(); process.exit(0); });

    const usageOf = (key) => {
        let u = usage.get(key);
        if (!u) usage.set(key, (u = {total: 0, window: {minute: 0, count: 0}, days: {}}));
        return u;
    };

    // Returns the key record after enforcing existence, origin allow-list and rate limit,
    // or sends the appropriate 401/403/429 and returns null.
    function authorize(req, res, url) {
        const key = url.searchParams.get('key');
        const k = keys[key];
        if (!k) { json(res, 401, {error: 'invalid or missing key', hint: 'pass ?key=gv_pk_...'}); return null; }

        const origin = req.headers.origin || (req.headers.referer ? safeOrigin(req.headers.referer) : '');
        const allowed = k.origins.includes('*') || (origin && k.origins.some((o) => origin.includes(o)));
        if (!allowed) { json(res, 403, {error: 'origin not allowed for this key', origin: origin || '(none)', allowed: k.origins}); return null; }

        const u = usageOf(key);
        const minute = Math.floor(Date.now() / 60000);
        if (u.window.minute !== minute) u.window = {minute, count: 0};
        if (u.window.count >= k.rateLimitPerMin) {
            res.setHeader('Retry-After', '60');
            json(res, 429, {error: 'rate limit exceeded', limitPerMin: k.rateLimitPerMin}); return null;
        }
        return {key, k, u};
    }

    function handle(req, res, url) {
        setCors(req, res);   // applies to every /v1 response below (JSON, the 302, and errors)
        // CORS preflight: browsers send OPTIONS before a cross-origin fetch with non-simple headers.
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
        const parts = url.pathname.split('/').filter(Boolean);   // ['v1', ...]
        if (parts[1] === 'catalog') {
            // The open, keyless catalog of license-clear objects (no auth, no metering).
            if (!catalog) { json(res, 404, {error: 'catalog not built', hint: 'run node scripts/build-catalog.mjs'}); return true; }
            res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'public, max-age=300'});
            res.end(JSON.stringify(catalog, null, 2));
            return true;
        }
        if (parts[1] === 'usage') {
            const auth = authorize(req, res, url);
            if (!auth) return true;
            const {k, u} = auth;
            json(res, 200, {key: auth.key, label: k.label, rateLimitPerMin: k.rateLimitPerMin,
                thisMinute: u.window.count, remainingThisMinute: Math.max(0, k.rateLimitPerMin - u.window.count),
                total: u.total, byDay: u.days, origins: k.origins});
            return true;
        }
        if (parts[1] === 'tiles') {
            const auth = authorize(req, res, url);
            if (!auth) return true;
            const [, , body, tileset, z, x, y] = parts;
            const id = TILESETS[`${body}/${tileset}`];
            const entry = id && manifest[id];
            if (!entry) { json(res, 404, {error: 'unknown tileset', available: Object.keys(TILESETS)}); return true; }
            const upstream = entry.url.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{date}', twoDaysAgo());

            // Count the (authorized) request, then hand the caller to the upstream tile.
            const {u} = auth, day = new Date().toISOString().slice(0, 10);
            u.total++; u.window.count++; u.days[day] = (u.days[day] || 0) + 1;
            scheduleSave();
            res.writeHead(302, {Location: upstream, 'cache-control': 'no-store',
                'x-gv-tileset': `${body}/${tileset}`, 'x-gv-usage-total': String(u.total)});
            res.end();
            return true;
        }
        return false;   // not a /v1 route we handle
    }

    return {handle, keyCount: Object.keys(keys).length};
}

function safeOrigin(referer) { try { return new URL(referer).origin; } catch { return ''; } }
