#!/usr/bin/env node
// Mint a public API key (gv_pk_…) for the hosted, metered /v1 gateway and append it to keys.json.
//
//   node scripts/mint-key.mjs "<label>" "<origin1,origin2|*>" [ratePerMin]
//
// Examples:
//   node scripts/mint-key.mjs "Acme Corp" "acme.com,www.acme.com" 120
//   node scripts/mint-key.mjs "Local dev" "*"            # defaults to 60/min
//
// Keys are PUBLIC identifiers (origin-allowlisted + rate-limited), not secrets — see keys.json's note.
// keys.json is git-ignored; this script creates it (with the standard note) if it doesn't exist yet.
// Phase 1 of docs/api-keys-plan.md: issue a working key today, no backend required — it validates
// against keys.json whenever the gateway (serve.mjs + keys.mjs) runs.
import {readFile, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS_FILE = join(ROOT, 'keys.json');
const NOTE = "API keys for the metered /v1 gateway served by serve.mjs. Public keys only, no secrets live here. origins '*' allows any caller; otherwise the request Origin (or Referer) host must contain one of the listed entries. rateLimitPerMin is enforced per key, per minute.";

const [, , label, originsArg, rateArg] = process.argv;

if (!label || !originsArg) {
    console.error('Usage: node scripts/mint-key.mjs "<label>" "<origin1,origin2|*>" [ratePerMin]');
    console.error('  e.g. node scripts/mint-key.mjs "Acme Corp" "acme.com,www.acme.com" 120');
    process.exit(1);
}

const origins = originsArg.split(',').map((o) => o.trim()).filter(Boolean);
if (!origins.length) { console.error('At least one origin is required (use "*" to allow any).'); process.exit(1); }

const rateLimitPerMin = rateArg === undefined ? 60 : Number(rateArg);
if (!Number.isInteger(rateLimitPerMin) || rateLimitPerMin <= 0) {
    console.error(`ratePerMin must be a positive integer (got "${rateArg}").`); process.exit(1);
}

// Load the existing store, or start a fresh one with the standard note.
let store = {note: NOTE, keys: []};
try {
    const parsed = JSON.parse(await readFile(KEYS_FILE, 'utf8'));
    if (Array.isArray(parsed.keys)) store = {note: parsed.note || NOTE, keys: parsed.keys};
} catch (e) {
    if (e.code !== 'ENOENT') { console.error(`Could not read keys.json: ${e.message}`); process.exit(1); }
}

const key = 'gv_pk_' + randomBytes(16).toString('hex');
if (store.keys.some((k) => k.key === key)) { console.error('Key collision (astronomically unlikely) — just run again.'); process.exit(1); }

store.keys.push({key, label, origins, rateLimitPerMin});
await writeFile(KEYS_FILE, JSON.stringify(store, null, 2) + '\n');

console.log(`Minted key for "${label}":\n`);
console.log(`  ${key}\n`);
console.log(`  origins:  ${origins.join(', ')}`);
console.log(`  rate:     ${rateLimitPerMin}/min`);
console.log(`\nAppended to ${KEYS_FILE}. It validates whenever the /v1 gateway is running.`);
console.log(`Try:  curl "http://localhost:3000/v1/usage?key=${key}"`);
