// Dependency-free SQLite store for the /v1 gateway, using Node's built-in node:sqlite (Node >= 22.5).
// Holds API keys (with email-verification state and forward-looking `scopes` for future product
// entitlements — tiles today, data layers / weather later) and per-day usage counts. One file on disk;
// on a container host point DB_PATH at a mounted volume so it survives redeploys.
import {DatabaseSync} from 'node:sqlite';

const safeJson = (s, fallback) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : fallback; } catch { return fallback; } };

export function openDb(path) {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    db.exec(`
        CREATE TABLE IF NOT EXISTS api_keys (
            key                TEXT PRIMARY KEY,
            email              TEXT,
            label              TEXT,
            origins            TEXT NOT NULL DEFAULT '["*"]',   -- JSON array
            rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
            scopes             TEXT NOT NULL DEFAULT '["tiles"]', -- JSON array: what this key may access
            verified           INTEGER NOT NULL DEFAULT 0,      -- 0 until the email is confirmed
            verify_token       TEXT,
            verify_expires     INTEGER,                         -- epoch ms
            created_at         TEXT,
            verified_at        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_keys_email ON api_keys(email);
        CREATE INDEX IF NOT EXISTS idx_keys_token ON api_keys(verify_token);
        CREATE TABLE IF NOT EXISTS usage (
            key   TEXT NOT NULL,
            day   TEXT NOT NULL,                                -- YYYY-MM-DD (UTC)
            count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (key, day)
        );
    `);

    const stmt = {
        get:        db.prepare('SELECT * FROM api_keys WHERE key = ?'),
        byEmail:    db.prepare('SELECT * FROM api_keys WHERE email = ?'),
        byToken:    db.prepare('SELECT * FROM api_keys WHERE verify_token = ?'),
        insert:     db.prepare(`INSERT INTO api_keys (key, email, label, origins, rate_limit_per_min, scopes, verified, verify_token, verify_expires, created_at, verified_at)
                                VALUES (@key, @email, @label, @origins, @rate, @scopes, @verified, @token, @expires, @created, @verifiedAt)`),
        verify:     db.prepare("UPDATE api_keys SET verified = 1, verified_at = ?, verify_token = NULL, verify_expires = NULL WHERE key = ?"),
        bumpUsage:  db.prepare('INSERT INTO usage (key, day, count) VALUES (?, ?, 1) ON CONFLICT(key, day) DO UPDATE SET count = count + 1'),
        total:      db.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM usage WHERE key = ?'),
        days:       db.prepare('SELECT day, count FROM usage WHERE key = ? ORDER BY day'),
        count:      db.prepare('SELECT COUNT(*) AS n FROM api_keys'),
    };

    const hydrate = (row) => row && ({
        key: row.key, email: row.email, label: row.label,
        origins: safeJson(row.origins, ['*']), rateLimitPerMin: row.rate_limit_per_min,
        scopes: safeJson(row.scopes, ['tiles']), verified: !!row.verified,
        verifyExpires: row.verify_expires, created: row.created_at, verifiedAt: row.verified_at,
    });

    return {
        raw: db,
        getKey: (key) => hydrate(stmt.get.get(key)),
        findByEmail: (email) => hydrate(stmt.byEmail.get(email)),
        // Insert a key. rec: {key, email, label, origins[], rateLimitPerMin, scopes[], verified, verifyToken, verifyExpires, created}
        insertKey: (rec) => stmt.insert.run({
            key: rec.key, email: rec.email || null, label: rec.label || null,
            origins: JSON.stringify(rec.origins || ['*']), rate: rec.rateLimitPerMin ?? 60,
            scopes: JSON.stringify(rec.scopes || ['tiles']), verified: rec.verified ? 1 : 0,
            token: rec.verifyToken || null, expires: rec.verifyExpires || null,
            created: rec.created || new Date().toISOString(), verifiedAt: rec.verified ? (rec.created || new Date().toISOString()) : null,
        }),
        // Confirm an email by its token. Returns the activated key, {expired:true}, or null (bad token).
        verifyToken: (token, now = Date.now()) => {
            const row = stmt.byToken.get(token);
            if (!row) return null;
            if (row.verify_expires && row.verify_expires < now) return {expired: true};
            stmt.verify.run(new Date(now).toISOString(), row.key);
            return hydrate(stmt.get.get(row.key));
        },
        bumpUsage: (key, day) => stmt.bumpUsage.run(key, day),
        usage: (key) => {
            const total = stmt.total.get(key).total;
            const days = {};
            for (const r of stmt.days.all(key)) days[r.day] = r.count;
            return {total, days};
        },
        keyCount: () => stmt.count.get().n,
        close: () => db.close(),
    };
}
