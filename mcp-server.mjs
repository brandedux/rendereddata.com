// Rendered Data Maps MCP server. A dependency-free Model Context Protocol server (JSON-RPC 2.0
// over stdio, newline-delimited) that lets an agent ask about the map's layers and licenses and
// get back style-ready answers. It reads the same manifest.json and features.json the site uses.
//
//   node mcp-server.mjs
//
// Tools: list_layers, get_layer_license, get_style_url, search_place.
// (sample_value, reading a value at a point/time, waits on the time-series pipeline.)
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const manifest = read('manifest.json');
const catalog = read('features.json');
const M = Object.fromEntries(manifest.entries.map((e) => [e.id, e]));

// Place index from the bundled Natural Earth names (self-hosted; no network).
let places = [];
try {
    const ne = read('data/ne_110m_admin_0_countries.geojson');
    places = ne.features.map((f) => {
        const p = f.properties;
        const center = Number.isFinite(p.LABEL_X) && Number.isFinite(p.LABEL_Y) ? [p.LABEL_X, p.LABEL_Y] : null;
        return p.NAME && center ? {name: p.NAME, center, rank: p.LABELRANK ?? 99} : null;
    }).filter(Boolean);
} catch { /* search_place will return [] */ }

// ------------------------------------------------------------------ tools
const TOOLS = {
    list_layers: {
        description: 'List every map layer/feature with its id, group, status (live or planned) and commercial-license flag.',
        inputSchema: {type: 'object', properties: {status: {type: 'string', enum: ['live', 'planned'], description: 'optional filter'}}},
        run: ({status}) => catalog.features
            .filter((f) => !status || f.status === status)
            .map((f) => ({id: f.id, name: f.name, group: f.group, status: f.status, commercial: f.license}))
    },
    get_layer_license: {
        description: 'Get the license, attribution, commercial flag and share-alike status for a layer id (from features.json or a manifest source id).',
        inputSchema: {type: 'object', properties: {layer: {type: 'string', description: 'a feature id or manifest source id'}}, required: ['layer']},
        run: ({layer}) => {
            const e = M[layer];
            if (e) return {id: layer, license: e.license, attribution: e.attribution, commercial: e.commercial, share_alike: !!e.share_alike, store: e.store};
            const f = catalog.features.find((x) => x.id === layer);
            if (f) return {id: layer, name: f.name, commercial: f.license, status: f.status, note: 'license flag from features.json; see the matching manifest source for full terms'};
            throw rpcError(-32602, `unknown layer: ${layer}`);
        }
    },
    get_style_url: {
        description: 'Get a ready-to-open playground deep link and the SDK call for a given body and base layer.',
        inputSchema: {type: 'object', properties: {
            body: {type: 'string', enum: ['earth', 'moon', 'mars'], default: 'earth'},
            base: {type: 'string', description: "a base layer id, e.g. 'base-open', 'bluemarble', 'mars-viking'"}
        }},
        run: ({body = 'earth', base}) => {
            const b = base || {earth: 'open', moon: 'moon-wac', mars: 'mars-viking'}[body];
            return {
                playground: `playground.html?body=${body}${base ? `&base=${base}` : ''}`,
                demo: 'sdk-demo.html',
                sdk: `new GlobeMap({ container: 'map', body: '${body}', base: '${b}' })`
            };
        }
    },
    search_place: {
        description: 'Search bundled place names (Natural Earth). Place-name grade, Earth only, fully local.',
        inputSchema: {type: 'object', properties: {
            query: {type: 'string'}, body: {type: 'string', default: 'earth'}, limit: {type: 'number', default: 8}
        }, required: ['query']},
        run: ({query, body = 'earth', limit = 8}) => {
            if (body !== 'earth') return [];
            const q = String(query).toLowerCase();
            return places
                .map((p) => ({p, i: p.name.toLowerCase().indexOf(q)}))
                .filter((x) => x.i >= 0)
                .sort((a, b) => (a.i - b.i) || (a.p.rank - b.p.rank))
                .slice(0, limit)
                .map((x) => ({name: x.p.name, center: x.p.center}));
        }
    }
};

// ------------------------------------------------------------------ JSON-RPC plumbing
function rpcError(code, message) { return Object.assign(new Error(message), {rpc: {code, message}}); }
const ok = (id, result) => ({jsonrpc: '2.0', id, result});
const err = (id, code, message) => ({jsonrpc: '2.0', id, error: {code, message}});

// Transport-agnostic: takes one JSON-RPC message, returns a response object (or null for
// notifications, which get no reply). Both the stdio and HTTP transports call this.
function dispatch(msg) {
    const {id, method, params} = msg;
    if (method === 'initialize') {
        return ok(id, {
            protocolVersion: params?.protocolVersion || '2024-11-05',
            capabilities: {tools: {}},
            serverInfo: {name: 'rendered-data-maps', version: '0.1.0'}
        });
    }
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return null; // no reply
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') {
        return ok(id, {tools: Object.entries(TOOLS).map(([name, t]) => ({name, description: t.description, inputSchema: t.inputSchema}))});
    }
    if (method === 'tools/call') {
        const tool = TOOLS[params?.name];
        if (!tool) return err(id, -32602, `unknown tool: ${params?.name}`);
        try {
            const out = tool.run(params.arguments || {});
            return ok(id, {content: [{type: 'text', text: JSON.stringify(out, null, 2)}]});
        } catch (e) {
            if (e.rpc) return err(id, e.rpc.code, e.rpc.message);
            return ok(id, {isError: true, content: [{type: 'text', text: String(e.message || e)}]});
        }
    }
    return id !== undefined ? err(id, -32601, `method not found: ${method}`) : null;
}

// Handle a single message or a JSON-RPC batch; returns the response(s) to send back.
function handlePayload(payload) {
    if (Array.isArray(payload)) return payload.map(dispatch).filter((r) => r !== null);
    return dispatch(payload);
}

// ------------------------------------------------------------------ transports
function startStdio() {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try { const r = dispatch(JSON.parse(line)); if (r) process.stdout.write(JSON.stringify(r) + '\n'); }
            catch { process.stderr.write(`[mcp] could not parse: ${line}\n`); }
        }
    });
    process.stderr.write('[mcp] rendered-data-maps MCP server ready on stdio\n');
}

// Minimal Streamable-HTTP transport: POST a JSON-RPC message (or batch) to /mcp and get the
// response as application/json, or as a single Server-Sent Event when the client asks for one.
// GET /mcp with Accept: text/event-stream opens a keepalive stream (no server-initiated messages).
async function startHttp(port) {
    const {createServer} = await import('node:http');
    createServer((req, res) => {
        if (req.url.split('?')[0] !== '/mcp') { res.writeHead(404).end('not found'); return; }
        const accept = req.headers.accept || '';
        if (req.method === 'GET') {
            if (!accept.includes('text/event-stream')) { res.writeHead(405).end('use POST, or GET with Accept: text/event-stream'); return; }
            res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive'});
            res.write(': connected\n\n');
            const ka = setInterval(() => res.write(': ping\n\n'), 15000);
            req.on('close', () => clearInterval(ka));
            return;
        }
        if (req.method !== 'POST') { res.writeHead(405).end('method not allowed'); return; }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
            let payload; try { payload = JSON.parse(body); }
            catch { res.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify(err(null, -32700, 'parse error'))); return; }
            const out = handlePayload(payload);
            if (out === null || (Array.isArray(out) && out.length === 0)) { res.writeHead(202).end(); return; }  // notifications only
            if (accept.includes('text/event-stream')) {
                res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store'});
                res.end(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
            } else {
                res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(out));
            }
        });
    }).listen(port, '127.0.0.1', () => process.stderr.write(`[mcp] rendered-data-maps MCP server ready on http://127.0.0.1:${port}/mcp\n`));
}

const httpArgIdx = process.argv.indexOf('--http');
const httpPort = Number(process.env.MCP_HTTP_PORT || (httpArgIdx !== -1 ? process.argv[httpArgIdx + 1] || 2091 : 0));
if (httpPort) startHttp(httpPort); else startStdio();
