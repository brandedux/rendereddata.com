// Zero-dependency static server for the POC. Usage: node serve.mjs [port]
// Also accepts Enterprise contact submissions at POST /api/contact and appends them to
// leads/enterprise.jsonl, which is kept out of the static root so it is never served back.
import {createServer} from 'node:http';
import {readFile, stat, mkdir, appendFile} from 'node:fs/promises';
import {extname, join, normalize, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sendMail, mailerFromEnv} from './mailer.mjs';
import {makeKeyGateway} from './keys.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.argv[2]) || 8787;
const leadsDir = join(root, 'leads');
const leadsFile = join(leadsDir, 'enterprise.jsonl');
const keysFile = join(root, 'keys.json');
const usageFile = join(root, 'usage.json');
// Where contact-form submissions are emailed, and the subject they arrive with. The recipient and
// subject are app config (overridable by env); the SMTP host/credentials stay secret, in env only.
const CONTACT_TO = process.env.CONTACT_TO || 'hello@sorcery.llc';
const CONTACT_SUBJECT = process.env.CONTACT_SUBJECT || 'Rendered Data Contact Form';
const mailer = mailerFromEnv({...process.env, CONTACT_TO});   // null until SMTP_HOST (+ creds) are set
const gateway = await makeKeyGateway(root);   // /v1 metered tiles + usage
const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json',
    '.pbf': 'application/x-protobuf', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.pmtiles': 'application/octet-stream', '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.glb': 'model/gltf-binary', '.usdz': 'model/vnd.usdz+zip',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

const json = (res, code, body) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };

// Read a request body with a hard size cap, so a bad client cannot exhaust memory.
function readBody(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(Object.assign(new Error('too large'), {code: 413})); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isFile = async (p) => { try { return (await stat(p)).isFile(); } catch { return false; } };

async function handleContact(req, res) {
    let data;
    try { data = JSON.parse(await readBody(req)); }
    catch (err) { return json(res, err.code === 413 ? 413 : 400, {ok: false, error: 'Could not read the submission.'}); }

    const lead = {
        name: str(data.name, 200), email: str(data.email, 200), company: str(data.company, 200),
        team: str(data.team, 40), message: str(data.message, 4000)
    };
    if (!lead.name || !lead.message) return json(res, 422, {ok: false, error: 'Name and message are required.'});
    if (!looksLikeEmail(lead.email)) return json(res, 422, {ok: false, error: 'A valid work email is required.'});

    const record = {...lead, at: new Date().toISOString(),
        ip: req.socket.remoteAddress || '', ua: str(req.headers['user-agent'], 300)};
    await mkdir(leadsDir, {recursive: true});
    await appendFile(leadsFile, JSON.stringify(record) + '\n');
    console.log(`[contact] ${record.at}  ${lead.name} <${lead.email}>${lead.company ? ` · ${lead.company}` : ''}`);

    // The lead is now safely stored; emailing is best-effort and never blocks the response.
    notify(record);
    return json(res, 200, {ok: true});
}

// Fire an email notification if SMTP is configured. Failures are logged, not surfaced:
// the submission already succeeded the moment the lead was written to disk.
async function notify(lead) {
    if (!mailer) { console.log('[contact] email not sent: SMTP not configured (set SMTP_HOST and CONTACT_TO)'); return; }
    const text = [
        'New contact from the Rendered Data website:', '',
        `Name:          ${lead.name}`,
        `Email:         ${lead.email}`,
        `Company:       ${lead.company || '(none)'}`,
        `Organization:  ${lead.team || '(none)'}`,
        `When:          ${lead.at}`, '',
        'Message:', lead.message, '',
        `(from ${lead.ip})`
    ].join('\n');
    try {
        // Reply-To is the person who filled in the form, so replying reaches them, not the inbox owner.
        await sendMail({...mailer, subject: CONTACT_SUBJECT, replyTo: lead.email, text});
        console.log(`[contact] email notification sent to ${[].concat(mailer.to).join(', ')}`);
    } catch (err) {
        console.error(`[contact] email notification FAILED (lead is still saved): ${err.message}`);
    }
}

createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://x');
        if (req.method === 'POST' && url.pathname === '/api/contact') return await handleContact(req, res);
        if (url.pathname.startsWith('/v1/') && gateway.handle(req, res, url)) return;
        if (req.method !== 'GET' && req.method !== 'HEAD') throw Object.assign(new Error('method'), {code: 405});

        let path = decodeURIComponent(url.pathname);
        if (path.endsWith('/')) path += 'index.html';
        let file = normalize(join(root, path));
        if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) throw Object.assign(new Error('forbidden'), {code: 403});
        if (file === leadsDir || file.startsWith(leadsDir + sep)) throw Object.assign(new Error('forbidden'), {code: 403}); // never serve stored leads
        if (file === keysFile || file === usageFile) throw Object.assign(new Error('forbidden'), {code: 403});             // never serve the key store or usage counts
        // Clean URLs, matching GitHub Pages: /thanks resolves to thanks.html when there is no exact file.
        if (!(await isFile(file)) && await isFile(file + '.html')) file += '.html';
        if (!(await isFile(file))) throw new Error('not a file');
        res.writeHead(200, {'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache'});
        res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (err) {
        const code = err.code === 403 ? 403 : err.code === 405 ? 405 : err.code === 413 ? 413 : 404;
        res.writeHead(code, {'content-type': 'text/plain'});
        res.end({403: 'forbidden', 405: 'method not allowed', 413: 'payload too large'}[code] || 'not found');
    }
}).listen(port, '127.0.0.1', () => console.log(`Rendered Data Maps POC: http://localhost:${port}/`));
