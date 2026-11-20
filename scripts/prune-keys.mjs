#!/usr/bin/env node
// One-off maintenance: remove test/debug keys from the gateway's SQLite DB (db.mjs). Targets keys from
// the @brandedux.com / @example.com test domains and any unverified keys; never touches admin keys
// (email NULL, seeded from GV_KEYS/keys.json). Dry-run by default — pass --yes to actually delete.
//
//   DB_PATH=/data/gateway.db node scripts/prune-keys.mjs          # preview
//   DB_PATH=/data/gateway.db node scripts/prune-keys.mjs --yes    # delete
import {DatabaseSync} from 'node:sqlite';

const path = process.env.DB_PATH || './data.db';
const apply = process.argv.includes('--yes');
const where = "email LIKE '%@brandedux.com' OR email LIKE '%@example.com' OR verified = 0";

const db = new DatabaseSync(path);
const rows = db.prepare(`SELECT key, email, verified FROM api_keys WHERE ${where}`).all();
console.log(`DB: ${path}`);
console.log(`${rows.length} key(s) match (test domains or unverified):`);
for (const r of rows) console.log(`  v=${r.verified} ${r.email || '(none)'} ${r.key.slice(0, 14)}…`);
if (!rows.length) { console.log('nothing to prune.'); process.exit(0); }
if (!apply) { console.log('\nDRY RUN — re-run with --yes to delete these and their usage rows.'); process.exit(0); }

const k = db.prepare(`DELETE FROM api_keys WHERE ${where}`).run().changes;
const u = db.prepare('DELETE FROM usage WHERE key NOT IN (SELECT key FROM api_keys)').run().changes;
console.log(`\nDeleted ${k} key(s) and ${u} orphaned usage row(s). Remaining keys: ${db.prepare('SELECT COUNT(*) n FROM api_keys').get().n}`);
