// Rendered Data Maps site: Product, Developers and Playground tabs.
// Everything shown is read at runtime from manifest.json and features.json; nothing is hardcoded twice.

import * as maplibregl from '../vendor/maplibre-gl/maplibre-gl.mjs';
import {createStarfield} from './starfield.js';

const ROOT = new URL('..', import.meta.url).href;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k !== null && k !== undefined) n.append(k);
    return n;
};
const getJSON = async (path) => (await fetch(ROOT + path, {cache: 'no-store'})).json();

const [manifest, catalog] = await Promise.all([getJSON('manifest.json'), getJSON('features.json')]);
const features = catalog.features;
const byId = Object.fromEntries(features.map((f) => [f.id, f]));

// ------------------------------------------------------------ small renderers
function tag(kind, text) { return el('span', {className: `gv-tag gv-tag--${kind}`, textContent: text}); }
const licenseTag = (flag) => tag(flag === 'ok' ? 'live' : flag, `commercial: ${flag}`);

/** Code block with comment lines dimmed. Text is set as textContent, never as HTML. */
function codeBlock(src) {
    const pre = el('pre', {className: 'gv-code'});
    src.split('\n').forEach((line, i, all) => {
        const at = line.indexOf('//');
        const isUrl = at > 0 && line[at - 1] === ':';
        if (at >= 0 && !isUrl) {
            pre.append(line.slice(0, at), el('span', {className: 'c', textContent: line.slice(at)}));
        } else pre.append(line);
        if (i < all.length - 1) pre.append('\n');
    });
    return pre;
}

// ------------------------------------------------------------ product tab
// The Product page is marketing: it sells outcomes, not an inventory. The exhaustive,
// honestly-tagged feature list lives in the Developers tab. Here we only fill the two pieces
// that are genuine proof: the live provenance table and the real SDK snippet.
function renderProduct() {
    $('ml-ver').textContent = maplibregl.getVersion();
    const e = manifest.entries;
    // Source manifest as a slow, seamless ticker: a static header over a row track that is
    // duplicated once and translated -50%, so it loops endlessly with about half the list in view.
    const headRow = el('div', {className: 'mf-row mf-head'},
        ...['Source', 'Served from', 'License', 'Commercial'].map((h) => el('span', {textContent: h})));
    const makeRow = (x) => el('div', {className: 'mf-row'},
        el('span', {className: 'mf-src', textContent: x.label}),
        el('span', {className: 'mf-host', textContent: x.hosted === 'bundled' ? 'this origin' : new URL(x.probe).host}),
        el('span', {textContent: x.license}),
        el('span', {}, licenseTag(x.commercial), x.store === 'quarantine' ? tag('review', 'quarantine') : null));
    const track = el('div', {className: 'mf-track', style: `--mf-dur:${e.length * 3.6}s`}, ...e.map(makeRow), ...e.map(makeRow));
    $('manifest-table').replaceChildren(headRow, el('div', {className: 'manifest-scroll'}, track));

    $('sdk-snippet').replaceWith(Object.assign(codeBlock(byId.sdk.code), {id: 'sdk-snippet', style: 'margin-top:12px'}));

    // Open-parts list: clone its items once so the track loops seamlessly (translateY -50%).
    const parts = $('parts-list');
    if (parts && !parts.dataset.looped) {
        const n = parts.children.length;
        for (const li of [...parts.children]) parts.appendChild(li.cloneNode(true));
        parts.style.setProperty('--mf-dur', `${n * 4.4}s`);
        parts.dataset.looped = '1';
    }
}

// The hero globe shows NASA Blue Marble satellite imagery (public domain, no key) over the bundled
// Natural Earth vectors. If the imagery is ever blocked, the raster simply does not draw and the
// stylized vector globe underneath shows instead, so the landing page never breaks.
let heroMap = null;
function startHero() {
    if (heroMap) return;
    const bm = manifest.entries.find((x) => x.id === 'gibs-bluemarble');
    heroMap = new maplibregl.Map({
        container: 'hero-globe',
        center: [-100, 25], zoom: 1.35, attributionControl: false, dragRotate: false,
        style: {
            version: 8, projection: {type: 'globe'},
            sky: {'atmosphere-blend': 1},
            sources: {
                ne: {type: 'geojson', data: ROOT + manifest.entries.find((x) => x.id === 'gv-open-basemap').url},
                bm: {type: 'raster', tiles: [bm.url], tileSize: 256, maxzoom: bm.maxzoom, attribution: bm.attribution}
            },
            layers: [
                {id: 'bg', type: 'background', paint: {'background-color': '#0a2540'}},
                {id: 'land', type: 'fill', source: 'ne', paint: {'fill-color': '#16302a'}},   // fallback if imagery is blocked
                {id: 'bluemarble', type: 'raster', source: 'bm', paint: {'raster-fade-duration': 500}},
                {id: 'borders', type: 'line', source: 'ne', paint: {'line-color': '#7fe6a6', 'line-opacity': 0.28, 'line-width': 0.5}}
            ]
        }
    });
    heroMap.scrollZoom.disable();
    heroMap.touchZoomRotate.disable();
    heroMap.doubleClickZoom.disable();
    heroMap.keyboard.disable();

    let spinning = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stop = () => { spinning = false; };
    for (const ev of ['mousedown', 'touchstart']) heroMap.getCanvas().addEventListener(ev, stop, {passive: true});
    let last = performance.now();
    const tick = (now) => {
        const dt = Math.min(100, now - last); last = now;
        if (spinning && !$('view-product').hidden && !document.hidden) {
            const c = heroMap.getCenter();
            heroMap.jumpTo({center: [c.lng - dt * 0.004, c.lat]});   // ~4°/s, prograde (surface drifts east)
        }
        if (spinning) requestAnimationFrame(tick);
    };
    heroMap.once('load', () => {
        requestAnimationFrame(tick);
        // A subtle real starfield behind the globe. The globe spins via jumpTo (which fires 'move'),
        // so the sky redraws each frame and stays fixed in space while the planet turns inside it.
        fetch(ROOT + 'data/stars.json', {cache: 'force-cache'}).then((r) => r.json()).catch(() => null).then((catalog) => {
            if (!heroMap) return;
            createStarfield(heroMap, {getBody: () => 'earth', catalog: catalog || undefined, magLimit: 5.5,
                milkyWay: true, constellations: false, planets: false, sun: false, moon: false, deepSky: false, starLabels: false});
        });
    });
}

// ------------------------------------------------------------ developers tab
let current = features[0].id;

function renderDevNav() {
    const frag = document.createDocumentFragment();
    let firstShown = true;
    for (const g of catalog.groups) {
        const items = features.filter((f) => f.group === g.id);
        if (!items.length) continue;
        // Collapsible <details> per group: only the first group (and the current feature's
        // group) is open by default; the rest start collapsed.
        const group = el('details', {className: 'dev-group'});
        group.open = firstShown || items.some((f) => f.id === current);
        firstShown = false;
        group.append(el('summary', {className: 'dev-group-head'}, el('span', {textContent: g.name})));
        for (const f of items) {
            const b = el('button', {}, el('span', {textContent: f.name}));
            b.setAttribute('aria-current', String(f.id === current));
            b.addEventListener('click', () => { location.hash = `#developers/${f.id}`; });
            group.append(b);
        }
        frag.append(group);
    }
    $('dev-list').replaceChildren(frag);
}

function renderDevDetail() {
    const f = byId[current];
    const g = catalog.groups.find((x) => x.id === f.group);
    const facts = el('dl', {className: 'facts'});
    for (const [k, v] of [['How it is built', f.built], ['Parity', f.parity], ['Test status', f.tested]]) {
        facts.append(el('dt', {textContent: k}), el('dd', {textContent: v}));
    }
    const actions = el('div', {className: 'row'});
    if (f.demo) {
        actions.append(el('a', {className: 'gv-btn gv-btn--sm gv-btn--solid', href: ROOT + f.demo, target: '_blank', rel: 'noopener', textContent: 'Open the live demo'}));
    } else if (f.status === 'live') {
        const open = el('a', {className: 'gv-btn gv-btn--sm gv-btn--solid', href: '#playground', textContent: 'Open in playground'});
        open.addEventListener('click', () => { pendingPlayground = f.playground || ''; });
        actions.append(open);
    }
    // Just the license tag (the project's point); a "Planned" tag only when it isn't built yet.
    const metaRow = el('div', {className: 'row'});
    if (f.status !== 'live') metaRow.append(tag('planned', 'Planned'));
    metaRow.append(licenseTag(f.license));
    $('dev-detail').replaceChildren(
        el('p', {className: 'gv-label', textContent: g.name}),
        el('h1', {className: 'gv-h2', textContent: f.name}),
        metaRow,
        el('p', {className: 'gv-lede', textContent: f.summary}),
        facts,
        el('p', {className: 'gv-eyebrow', textContent: f.status === 'live' ? 'Working code' : 'Proposed API · not built'}),
        codeBlock(f.code),
        actions
    );
}

// ------------------------------------------------------------ playground tab
let pendingPlayground = null;   // query + hash requested by "Open in playground"
let loadedPlayground = null;
function showPlayground() {
    const want = pendingPlayground ?? loadedPlayground ?? '';
    pendingPlayground = null;
    if (want !== loadedPlayground) {
        loadedPlayground = want;
        $('pg-frame').src = `${ROOT}playground.html${want}`;
    }
}

// ------------------------------------------------------------ router
const VIEWS = ['product', 'developers', 'playground'];
function route() {
    const [view, sub] = location.hash.replace(/^#/, '').split('/');
    const active = VIEWS.includes(view) ? view : 'product';
    for (const v of VIEWS) {
        $(`view-${v}`).hidden = v !== active;
        $(`tab-${v}`).setAttribute('aria-selected', String(v === active));
        $(`tab-${v}`).tabIndex = v === active ? 0 : -1;
    }
    if (active === 'product') startHero();
    if (active === 'developers') {
        if (byId[sub]) current = sub;
        renderDevNav(); renderDevDetail();
    }
    if (active === 'playground') showPlayground();
    if (!(active === 'product' && view && !VIEWS.includes(view))) window.scrollTo(0, 0);
    heroMap?.resize();
}
for (const t of document.querySelectorAll('[data-go]')) {
    t.addEventListener('click', () => { location.hash = `#${t.dataset.go}`; });
}
document.querySelector('.gv-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = VIEWS.indexOf(document.activeElement?.dataset.go);
    if (i < 0) return;
    const next = VIEWS[(i + (e.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
    location.hash = `#${next}`; $(`tab-${next}`).focus();
});
addEventListener('hashchange', route);

// ------------------------------------------------------------ contact form
// Every "Contact sales" / "Talk to sales" button on the page opens the same dialog, so both give an
// identical experience; the only difference is a hidden enquiry_type field (e.g. "Enterprise") set from
// the clicked button's data-cta, so each lead says which CTA it came from. Submissions go to Web3Forms —
// a static-host-friendly relay that needs no server, so this works on plain GitHub Pages. The access key
// is a public, per-form identifier (safe to ship in client code): it only routes the message to the
// registered inbox (hello@sorcery.llc) and cannot read past submissions. Web3Forms sets the email's
// Reply-To from the `email` field so replies reach the sender.
const WEB3FORMS_KEY = 'b79112b2-5f07-461a-a428-4caaa46cb8cd';

function wireContactForm() {
    const dialog = $('contact-dialog');
    const form = $('contact-form');
    if (!dialog || !form || typeof dialog.showModal !== 'function') return;
    const status = $('cf-status');
    const submit = $('cf-submit');
    const validated = ['name', 'email', 'message'];

    // Inline per-field errors: the <small class="cf-err"> sits inside each field's <label>.
    const setError = (input, msg) => {
        const label = input?.closest('label'); if (!label) return;
        const err = label.querySelector('.cf-err');
        label.classList.toggle('invalid', !!msg);
        if (err) { err.textContent = msg || ''; err.hidden = !msg; }
    };
    const clearErrors = () => validated.forEach((n) => setError(form.elements[n], ''));

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validate = () => {
        clearErrors();
        let firstBad = null;
        const fail = (input, msg) => { setError(input, msg); firstBad = firstBad || input; };
        const f = form.elements;
        if (!f.name.value.trim()) fail(f.name, 'Please tell us your name.');
        const email = f.email.value.trim();
        if (!email) fail(f.email, 'An email is required so we can reply.');
        else if (!EMAIL_RE.test(email)) fail(f.email, 'That email address doesn’t look right.');
        const message = f.message.value.trim();
        if (!message) fail(f.message, 'Let us know what you’re building.');
        else if (message.length < 10) fail(f.message, 'A little more detail helps — at least 10 characters.');
        if (firstBad) { firstBad.focus(); return false; }
        return true;
    };
    // Clear a field's error as soon as the visitor starts fixing it.
    validated.forEach((n) => form.elements[n]?.addEventListener('input', () => setError(form.elements[n], '')));

    const open = (e) => {
        dialog.removeAttribute('data-sent');
        status.className = 'cf-status'; status.textContent = '';
        form.reset(); clearErrors(); submit.disabled = false; submit.textContent = 'Send';
        $('cf-cta').value = e?.currentTarget?.dataset.cta || 'Website';   // which CTA opened the form
        dialog.showModal();
        form.elements.name?.focus();
    };
    const close = () => dialog.close();

    for (const b of document.querySelectorAll('[data-contact]')) b.addEventListener('click', open);
    for (const b of dialog.querySelectorAll('[data-close]')) b.addEventListener('click', close);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });   // backdrop closes

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!validate()) return;
        const data = Object.fromEntries(new FormData(form));
        if (data.botcheck) { close(); return; }          // honeypot tripped: silently drop the bot
        submit.disabled = true; submit.textContent = 'Sending…';
        status.className = 'cf-status'; status.textContent = '';
        try {
            const enquiry = data.enquiry_type || 'Website';
            const res = await fetch('https://api.web3forms.com/submit', {
                method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json'},
                body: JSON.stringify({
                    access_key: WEB3FORMS_KEY,
                    // Lead the subject with the enquiry type so Enterprise leads are obvious in the inbox.
                    subject: `Rendered Data — ${enquiry} enquiry`,
                    from_name: 'Rendered Data website',
                    name: data.name.trim(),
                    email: data.email.trim(),            // becomes the email's Reply-To
                    enquiry_type: enquiry,               // "Enterprise" | "General" | "Website"
                    company: data.company?.trim() || '—',
                    organization: data.team || '—',      // the "Organization size" select
                    message: data.message.trim(),
                    page: location.pathname + location.hash
                })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.success) throw new Error(body.message || `Request failed (${res.status})`);
            window.location.assign('/thanks');          // land on the thank-you page (thanks.html)
            return;
        } catch (err) {
            submit.disabled = false; submit.textContent = 'Send';
            status.className = 'cf-status err';
            status.textContent = `${err.message}. You can also email hello@sorcery.llc.`;
        }
    });
}
wireContactForm();

renderProduct();
route();
