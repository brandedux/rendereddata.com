# API keys — workplan (simplest path)

**Goal:** let people generate a `gv_pk_…` key for the **hosted, metered** tile service.
**Principle (unchanged):** self-hosting stays **keyless** — a key is a billing boundary on *our* servers, never a gate on the software. Keys only exist for `/v1` hosted tiles.

## The one hard fact
A key only *does* something if a server validates + meters it. **GitHub Pages is static and cannot meter.** So:

- **Everything static → GitHub Pages** (the site, the docs, a "get a key" page, the keyless self-host SDK).
- **The one dynamic piece — the `/v1` gateway + key generation → Railway.** This is the "if a must," and for a live metered API it *is* a must. It's also the simplest backend: **`serve.mjs` + `keys.mjs` already run on Node as-is, so Railway needs no rewrite** (Cloudflare Workers would).

## What already exists
- `keys.mjs` — validates keys (origin allowlist + per-minute rate limit) and meters usage. Routes: `GET /v1/tiles/…`, `GET /v1/usage`.
- `keys.json` — flat key store `{key, label, origins, rateLimitPerMin}` (git-ignored, hand-edited).
- `serve.mjs` — wires the gateway at `/v1/`.
- **Missing:** anything that *creates* a key, and a place to run the gateway.

## Decide first (1 decision, blocks nothing else)
**Who can get a key?** Pick one:
- **A. Admin-issued** (simplest) — you mint keys; users "request access" via the existing Web3Forms contact form.
- **B. Self-serve** — a public form mints instantly (needs light abuse control: one key per email, captcha/honeypot).

Recommendation: **ship A first, add B later.** A needs no new backend logic beyond a script.

---

## Phase 1 — Manual issuance (GitHub-only, no backend yet)
Get keys *generating* and documented without standing up a server. Good enough until hosted tiles actually go live.

- [ ] **`scripts/mint-key.mjs`** — `node scripts/mint-key.mjs "<label>" "<origin1,origin2>" <ratePerMin>`: generates `gv_pk_` + `crypto.randomBytes(16)` hex, appends an entry to `keys.json`, prints the key. (~20 lines.)
- [ ] **"Request API access"** on the site — reuse the existing contact form (`src/site.js` / Web3Forms) with an `enquiry_type: "api-key"` hidden field. You mint with the script and email the key back.
- [ ] **Docs** — short `/v1` usage snippet (pass `?key=gv_pk_…`) in the README / developers page.

**Deliverable:** you can issue a working key today; it validates against `keys.json` whenever the gateway runs (locally now, Railway next).

---

## Phase 2 — Live metered gateway (Railway, required for real hosted tiles)
- [ ] **Deploy `serve.mjs` to Railway** — Node service, start command `node serve.mjs`, `PORT` from env. No code rewrite.
- [ ] **Railway volume** mounted at the app dir so `keys.json` + `usage.json` **persist across deploys** (otherwise generated keys/usage reset on each deploy).
- [ ] **Custom domain** — `api.rendereddata.com` → Railway (the static site stays on GitHub Pages at `rendereddata.com`).
- [ ] **CORS** on `/v1/*` so the browser SDK can call it cross-origin.
- [ ] Point the SDK's hosted-tile calls at `https://api.rendereddata.com/v1/…`.

**Deliverable:** keys issued in Phase 1 now gate + meter real hosted tiles.

---

## Phase 3 — Self-serve generation (only if you want option B)
- [ ] **`POST /v1/keys`** in `keys.mjs` — body `{email, label, origins}`; mints + appends to the volume `keys.json`; returns the key. Gate it: one key per email, honeypot, per-IP rate limit. (Reuses Phase 1's mint logic.)
- [ ] **`/keys` dashboard page** (static, on GitHub Pages) — calls `POST /v1/keys` to generate, and `GET /v1/usage` to show the key's usage (the read side already exists).
- [ ] Optional: email the key via the existing mailer instead of returning it in the response.

---

## What does NOT change
- Self-host path stays **keyless** — no key, no signup, runs offline. Only `/v1` hosted tiles ever require a key.
- `keys.json` holds **public** keys (`gv_pk_…`), safe by origin-allowlist + rate-limit; no secrets in the repo.

## Open decisions
1. Gating policy **A vs B** (above).
2. Is the hosted tile service actually launching now? If not, **Phase 1 alone** is enough — don't deploy Railway until there's a paid tile to meter.
3. Free-tier limits per key (rate/day) and what tilesets are hosted-only vs free/self-host.
