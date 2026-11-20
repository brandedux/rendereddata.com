// Metered key gateway for the /v1 routes. Dependency-free; keys + usage live in a SQLite database
// (db.mjs, Node's built-in node:sqlite — needs Node >= 22.5). Self-serve keys require email
// verification before they work; admin keys from keys.json / GV_KEYS are seeded pre-verified.
//
//   GET  /v1/tiles/{body}/{tileset}/{z}/{x}/{y}?key=gv_pk_...   302 -> upstream tile, metered
//   GET  /v1/usage?key=gv_pk_...                                { total, thisMinute, ... }
//   GET  /v1/catalog                                           keyless license-clear object catalog
//   POST /v1/keys   { email, label?, origins? }                self-serve: mint + email a verify link
//   GET  /v1/verify?token=...                                  confirm an email, activate the key
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {openDb} from './db.mjs';

// Which {body}/{tileset} maps to which manifest entry. Earth raster XYZ only; the planetary
// mosaics need reprojection (see src/eqproj.js) and are not a straight redirect.
export const TILESETS = {
    'earth/bluemarble': 'gibs-bluemarble',
    'earth/s2': 'eox-s2-2016',
    'earth/viirs': 'gibs-viirs'
};

const json = (res, code, body) => { res.writeHead(code, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(body, null, 2)); };
const twoDaysAgo = () => new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// opts: allowOrigin (CORS), keysJson (GV_KEYS seed), dbPath, mailer (from mailerFromEnv, for verify
// emails), mailFrom/mailSubject, publicUrl (base for verify links), verifyRedirect (post-verify page).
export async function makeKeyGateway(root, opts = {}) {
    const {allowOrigin = '', keysJson = '', dbPath = '', sender = null,
        mailSubject = 'Verify your Rendered Data API key', publicUrl = '', verifyRedirect = '/keys'} = opts;

    const corsList = String(allowOrigin || '*').split(',').map((s) => s.trim()).filter(Boolean);
    const corsAny = corsList.includes('*');
    // CORS headers via setHeader() so they survive the later writeHead(). Returns the resolved origin or ''.
    const setCors = (req, res) => {
        const origin = corsAny ? '*' : (req.headers.origin && corsList.includes(req.headers.origin) ? req.headers.origin : '');
        if (!origin) return '';
        res.setHeader('access-control-allow-origin', origin);
        if (origin !== '*') res.setHeader('vary', 'Origin');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
        res.setHeader('access-control-max-age', '86400');
        return origin;
    };

    const db = openDb(dbPath || join(root, 'data.db'));

    // Seed admin / pre-provisioned keys (keys.json file + GV_KEYS env) into the DB as VERIFIED, once.
    const seed = [];
    try { const cfg = JSON.parse(await readFile(join(root, 'keys.json'), 'utf8')); if (Array.isArray(cfg.keys)) seed.push(...cfg.keys); } catch { /* none */ }
    if (keysJson) { try { const p = JSON.parse(keysJson); seed.push(...(Array.isArray(p) ? p : (p.keys || []))); } catch (e) { console.error('GV_KEYS: could not parse:', e.message); } }
    for (const k of seed) {
        if (!k || !k.key || db.getKey(k.key)) continue;
        db.insertKey({key: k.key, email: k.email || null, label: k.label || 'seed', origins: k.origins || ['*'],
            rateLimitPerMin: k.rateLimitPerMin || 60, scopes: k.scopes || ['tiles'], verified: true, created: new Date().toISOString()});
    }

    let manifest = {}, catalog = null;
    try { const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')); manifest = Object.fromEntries(m.entries.map((e) => [e.id, e])); } catch { /* tiles 404 */ }
    try { catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8')); } catch { /* /v1/catalog 404 */ }

    // Per-minute rate-limit window is ephemeral (not worth persisting); usage totals live in the DB.
    const windows = new Map();   // key -> {minute, count}
    const mintHits = new Map();  // ip -> [timestamps] for the self-serve mint cap

    // Enforce existence, email-verification, origin allow-list and rate limit, or send the right error.
    // enforceOrigin=false for read-only management calls (usage report): the key itself is the credential,
    // so the owner can check it from anywhere; the origin allow-list only gates tile serving.
    function authorize(req, res, url, enforceOrigin = true) {
        const key = url.searchParams.get('key');
        const k = key && db.getKey(key);
        if (!k) { json(res, 401, {error: 'invalid or missing key', hint: 'pass ?key=gv_pk_...'}); return null; }
        if (!k.verified) { json(res, 403, {error: 'email not verified — check your inbox for the verification link'}); return null; }
        if (enforceOrigin) {
            const origin = req.headers.origin || (req.headers.referer ? safeOrigin(req.headers.referer) : '');
            const allowed = k.origins.includes('*') || (origin && k.origins.some((o) => origin.includes(o)));
            if (!allowed) { json(res, 403, {error: 'origin not allowed for this key', origin: origin || '(none)', allowed: k.origins}); return null; }
        }
        const minute = Math.floor(Date.now() / 60000);
        let w = windows.get(key);
        if (!w || w.minute !== minute) windows.set(key, (w = {minute, count: 0}));
        if (w.count >= k.rateLimitPerMin) { res.setHeader('Retry-After', '60'); json(res, 429, {error: 'rate limit exceeded', limitPerMin: k.rateLimitPerMin}); return null; }
        return {key, k, w};
    }

    const mintAllowed = (ip) => {
        const now = Date.now(), arr = (mintHits.get(ip) || []).filter((t) => t > now - 3600000);
        if (arr.length >= 5) { mintHits.set(ip, arr); return false; }   // max 5 key requests / IP / hour
        arr.push(now); mintHits.set(ip, arr); return true;
    };

    // Send the verification email (or, if SMTP isn't configured, log the link so it's never lost).
    async function sendVerification(email, key, link) {
        const text = [
            'Confirm your email to activate your Rendered Data API key.', '',
            `Verify: ${link}`, '',
            `Your key: ${key}`,
            'It starts working the moment you click the link above. The link expires in 24 hours.', '',
            "If you didn't request this, you can ignore this email."
        ].join('\n');
        if (!sender) { console.log(`[v1] no email transport configured — verification link for ${email}: ${link}`); return; }
        try { await sender.send({to: email, subject: mailSubject, text}); console.log(`[v1] verification email sent to ${email} via ${sender.kind}`); }
        catch (e) { console.error(`[v1] verification email FAILED for ${email} (${sender.kind}; key still pending): ${e.message} — link: ${link}`); }
    }

    async function mintKeyFromRequest(req, res) {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, {error: 'invalid or too-large JSON body'}); }
        if (body.botcheck) return json(res, 200, {ok: true});   // honeypot: pretend success, drop the bot
        const email = String(body.email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return json(res, 422, {error: 'a valid email is required'});
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (!mintAllowed(ip)) return json(res, 429, {error: 'too many key requests from your network; try again later'});
        const existing = db.findByEmail(email);
        if (existing && existing.verified) return json(res, 409, {error: 'a verified key already exists for this email — contact us to recover it'});
        const origins = (Array.isArray(body.origins) ? body.origins : String(body.origins || '*').split(',')).map((s) => String(s).trim()).filter(Boolean);
        const key = 'gv_pk_' + randomBytes(16).toString('hex');
        const token = randomBytes(20).toString('hex');
        db.insertKey({key, email, label: String(body.label || email).slice(0, 80), origins: origins.length ? origins : ['*'],
            rateLimitPerMin: 60, scopes: ['tiles'], verified: false, verifyToken: token, verifyExpires: Date.now() + 864e5, created: new Date().toISOString()});
        const base = (publicUrl || `https://${req.headers.host}`).replace(/\/+$/, '');
        await sendVerification(email, key, `${base}/v1/verify?token=${token}`);
        console.log(`[v1] key requested for ${email} (pending verification)`);
        json(res, 202, {status: 'pending', key, email,
            message: 'Check your email for a verification link. Your key activates once you confirm.'});
    }

    function verify(req, res, url) {
        const token = url.searchParams.get('token') || '';
        const r = db.verifyToken(token);
        const back = (publicUrl ? '' : '') + verifyRedirect;   // relative redirect to the site
        if (!r) { res.writeHead(302, {Location: `${back}?verified=invalid`}); res.end(); return; }
        if (r.expired) { res.writeHead(302, {Location: `${back}?verified=expired`}); res.end(); return; }
        console.log(`[v1] key verified for ${r.email}`);
        res.writeHead(302, {Location: `${back}?verified=1`}); res.end();
    }

    function handle(req, res, url) {
        setCors(req, res);
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
        const parts = url.pathname.split('/').filter(Boolean);   // ['v1', ...]
        if (parts[1] === 'catalog') {
            if (!catalog) { json(res, 404, {error: 'catalog not built', hint: 'run node scripts/build-catalog.mjs'}); return true; }
            res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'public, max-age=300'});
            res.end(JSON.stringify(catalog, null, 2));
            return true;
        }
        if (parts[1] === 'keys') {
            if (req.method !== 'POST') { json(res, 405, {error: 'POST an {email, label, origins} body to request a key'}); return true; }
            mintKeyFromRequest(req, res);   // async
            return true;
        }
        if (parts[1] === 'verify') { verify(req, res, url); return true; }
        if (parts[1] === 'usage') {
            const auth = authorize(req, res, url, false);   // read-only report: not origin-gated
            if (!auth) return true;
            const {k, w} = auth, u = db.usage(auth.key);
            json(res, 200, {key: auth.key, label: k.label, scopes: k.scopes, rateLimitPerMin: k.rateLimitPerMin,
                thisMinute: w.count, remainingThisMinute: Math.max(0, k.rateLimitPerMin - w.count),
                today: u.days[today()] || 0, total: u.total, byDay: u.days, origins: k.origins});
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
            auth.w.count++;
            db.bumpUsage(auth.key, today());
            res.writeHead(302, {Location: upstream, 'cache-control': 'no-store', 'x-gv-tileset': `${body}/${tileset}`});
            res.end();
            return true;
        }
        return false;   // not a /v1 route we handle
    }

    return {handle, keyCount: db.keyCount()};
}

function safeOrigin(referer) { try { return new URL(referer).origin; } catch { return ''; } }

// Read a request body with a hard size cap, so a bad client cannot exhaust memory.
function readBody(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
