// Shared celestial-sky renderer. Draws the real sky (from src/celestial.js) around a MapLibre
// globe, and a real day/night terminator, matching the globe's camera and occluded by the planet.
// Used by both the SDK (src/maps.js) and the standalone playground (src/poc.js), so the
// astronomy lives in one place.
//
//   const sky = createStarfield(map, {getBody: () => state.body, catalog, time, grid: true});
//   const term = createTerminator(map, {getBody: () => state.body, beforeId: 'slot-data'});

import * as Cel from './celestial.js';

// Bundled body textures (earth.jpg / moon.jpg) live at data/textures/* beside the SDK's src/ folder.
// Resolve them against THIS module's URL, not the page, so they load when the SDK is hosted at a sub-path.
const DEFAULT_ROOT = new URL('..', import.meta.url).href;

const rad = (d) => (d * Math.PI) / 180;
const V = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm: (a) => Math.hypot(a[0], a[1], a[2]),
    unit: (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }
};
const vecLL = (lngDeg, latDeg) => { const la = rad(latDeg), lo = rad(lngDeg); return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]; };
const llVec = (v) => [Math.atan2(v[1], v[0]) * 180 / Math.PI, Math.asin(Math.max(-1, Math.min(1, v[2]))) * 180 / Math.PI];
const rotZ = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]; };
const rotX = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]; };
function rotAxis(v, k, a) {
    const c = Math.cos(a), s = Math.sin(a);
    const kv = V.cross(k, v), kd = V.dot(k, v);
    return V.add(V.add(V.scale(v, c), V.scale(kv, s)), V.scale(k, kd * (1 - c)));
}
// t∈[0,1] → points on the unit great circle whose plane has the given normal (two orthonormal in-plane axes).
function greatCircleFn(normal) {
    const n = V.unit(normal);
    let u = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    u = V.unit(V.cross(u, n)); const w = V.cross(n, u);
    return (t) => { const a = 2 * Math.PI * t, c = Math.cos(a), s = Math.sin(a);
        return [u[0] * c + w[0] * s, u[1] * c + w[1] * s, u[2] * c + w[2] * s]; };
}
const hexToRgb = (hex) => { const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)].join(','); };
// Draw a resolved body (the Moon from Earth, Earth from the Moon) at (X,Y) radius r, with its lit phase —
// k = illuminated fraction (0 new … 1 full); the lit limb faces litAngle (toward the Sun). A faint glow +
// an earthshine-dim full disc read underneath, then the bright lune on top (two-arc terminator ellipse).
function drawPhasedDisc(ctx, X, Y, r, k, litAngle, rgb, tex) {
    k = Math.max(0, Math.min(1, k));
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(X, Y, r * 0.6, X, Y, r * 2.3);
    g.addColorStop(0, `rgba(${rgb},0.22)`); g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(X, Y, r * 2.3, 0, 2 * Math.PI); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    const b = r * (1 - 2 * k);                               // terminator semi-minor axis (signed by phase)
    if (tex) {
        ctx.save();                                          // real surface map clipped to the disc
        ctx.beginPath(); ctx.arc(X, Y, r, 0, 2 * Math.PI); ctx.clip();
        ctx.drawImage(tex, X - r, Y - r, 2 * r, 2 * r);
        ctx.restore();
        ctx.save();                                          // darken the night side (the unlit lune)
        ctx.translate(X, Y); ctx.rotate(litAngle);
        ctx.fillStyle = 'rgba(2,5,12,0.82)';
        ctx.beginPath();
        ctx.arc(0, 0, r, Math.PI / 2, -Math.PI / 2, false);  // the −X (night) limb
        ctx.ellipse(0, 0, Math.abs(b), r, 0, -Math.PI / 2, Math.PI / 2, b < 0);
        ctx.closePath(); ctx.fill();
        ctx.restore();
        return;
    }
    ctx.save();
    ctx.translate(X, Y); ctx.rotate(litAngle);
    ctx.fillStyle = `rgba(${rgb},0.15)`;                      // earthshine: the whole disc faintly visible
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = `rgb(${rgb})`;                           // lit lune, bulging toward +X (the Sun)
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);      // the +X (lit) limb
    ctx.ellipse(0, 0, Math.abs(b), r, 0, Math.PI / 2, -Math.PI / 2, b > 0);
    ctx.closePath(); ctx.fill();
    ctx.restore();
}

// One shared stylesheet for the clickable travel hotspots (pulse ring + hover label).
function ensureHotspotStyle() {
    if (typeof document === 'undefined' || document.getElementById('gv-hotspot-style')) return;
    const st = document.createElement('style');
    st.id = 'gv-hotspot-style';
    st.textContent = `
.gv-hotspot{position:absolute;transform:translate(-50%,-50%);width:36px;height:36px;margin:0;padding:0;border:0;background:none;pointer-events:auto;cursor:pointer;}
.gv-hotspot::before{content:'';position:absolute;inset:0;border-radius:50%;border:1.5px solid rgba(130,205,255,.9);box-shadow:0 0 9px rgba(130,205,255,.45);animation:gv-hotspot-pulse 2.4s ease-out infinite;}
.gv-hotspot::after{content:'';position:absolute;inset:10px;border-radius:50%;border:1px solid rgba(190,225,255,.55);}
.gv-hotspot:hover::before,.gv-hotspot:focus-visible::before{border-color:rgba(170,225,255,1);animation-duration:1.1s;}
.gv-hotspot-label{position:absolute;left:50%;top:calc(50% + 24px);transform:translateX(-50%);white-space:nowrap;font:11px var(--gv-font-mono,ui-monospace,monospace);color:#cfe6ff;background:rgba(6,12,22,.85);border:1px solid rgba(130,205,255,.4);border-radius:6px;padding:2px 8px;opacity:0;transition:opacity .15s;pointer-events:none;}
.gv-hotspot:hover .gv-hotspot-label,.gv-hotspot:focus-visible .gv-hotspot-label{opacity:1;}
@keyframes gv-hotspot-pulse{0%{transform:scale(.62);opacity:.9;}70%{opacity:.22;}100%{transform:scale(1.3);opacity:0;}}
@media (prefers-reduced-motion:reduce){.gv-hotspot::before{animation:none;}}`;
    document.head.appendChild(st);
}

// Body orientation (IAU pole + prime meridian) now lives in src/celestial.js, shared by the globe
// sky here and the mesh sky in src/shapemodel.js — one source of truth, extended to Ganymede/Phobos.
const iauElements = Cel.iauElements, celestialToBody = Cel.celestialToBody, gmst = Cel.gmst, moonOfDate = Cel.moonOfDate;

// ---- resolved-body textures (Earth/Moon drawn as little textured spheres, not flat discs) ------------
// Bundled equirectangular maps (Solar System Scope, CC BY 4.0) — stored locally, never fetched at runtime.
const BODY_TEX = {earth: 'data/textures/earth.jpg', moon: 'data/textures/moon.jpg'};
const _texPix = {};        // key -> {data,w,h} once decoded (null = failed/loading)
function bodyTexPixels(key, base) {
    if (key in _texPix) return _texPix[key];
    _texPix[key] = null;
    if (!BODY_TEX[key]) return null;
    const img = new Image();
    img.onload = () => {
        try {
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
            const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
            _texPix[key] = {data: cx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height};
        } catch { _texPix[key] = null; }
    };
    img.onerror = () => { delete _texPix[key]; };   // allow a retry
    img.src = (base || '') + BODY_TEX[key];
    return null;
}
// Orthographic render of a body's equirect texture onto a disc: the hemisphere facing the viewer, north up,
// with longitude lon0 (deg) at the centre. Cached by (key, size-bucket, lon0-bucket) so it rebuilds rarely.
const _ortho = {};
function orthoSphere(key, size, lon0, base) {
    const tex = bodyTexPixels(key, base); if (!tex) return null;
    size = Math.max(16, Math.min(240, Math.round(size / 8) * 8));
    const lon0b = Math.round(lon0 / 3) * 3, ck = `${key}_${size}_${lon0b}`;
    if (_ortho[ck]) return _ortho[ck];
    const out = document.createElement('canvas'); out.width = size; out.height = size;
    const octx = out.getContext('2d'), od = octx.createImageData(size, size), O = od.data;
    const {data, w, h} = tex, R = size / 2, lon0r = lon0b * Math.PI / 180;
    for (let py = 0; py < size; py++) {
        const y = (R - py) / R;
        for (let px = 0; px < size; px++) {
            const x = (px - R) / R, rr = x * x + y * y, i = (py * size + px) * 4;
            if (rr > 1) { O[i + 3] = 0; continue; }
            const z = Math.sqrt(1 - rr), lat = Math.asin(y), lon = lon0r + Math.atan2(x, z);
            let u = lon / (2 * Math.PI) + 0.5; u -= Math.floor(u);
            const v = 0.5 - lat / Math.PI;
            const si = (Math.min(h - 1, (v * h) | 0) * w + Math.min(w - 1, (u * w) | 0)) * 4;
            O[i] = data[si]; O[i + 1] = data[si + 1]; O[i + 2] = data[si + 2]; O[i + 3] = 255;
        }
    }
    octx.putImageData(od, 0, 0);
    const keys = Object.keys(_ortho); if (keys.length > 20) delete _ortho[keys[0]];
    return (_ortho[ck] = out);
}
function offsetLL(lng, lat, ang, az) {
    const p1 = rad(lat), l1 = rad(lng);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(ang) + Math.cos(p1) * Math.sin(ang) * Math.cos(az));
    const l2 = l1 + Math.atan2(Math.sin(az) * Math.sin(ang) * Math.cos(p1), Math.cos(ang) - Math.sin(p1) * Math.sin(p2));
    return [l2 * 180 / Math.PI, p2 * 180 / Math.PI];
}

/**
 * Attach a celestial sky overlay to a MapLibre map (globe projection).
 * @param {maplibregl.Map} map
 * @param {object} [opts]  getBody:()=>'earth'|'moon'|'mars', time, catalog, magLimit, and boolean
 *   layer flags: stars, milkyWay, planets, sun, moon, deepSky, constellations, starLabels, grid, ecliptic.
 *   navigable: body ids (e.g. ['earth','moon','mars']) that become clickable travel hotspots when they
 *   appear in the sky; onTravel:(bodyId, name)=>{} is called on click (both required to enable hotspots).
 * @returns {{redraw, setTime, set, time, count, stop}}
 */
export function createStarfield(map, opts = {}) {
    const getBody = opts.getBody || (() => opts.body || 'earth');
    const base = opts.root || DEFAULT_ROOT;   // asset base for the bundled body textures; module-relative by
                                              // default so the SDK finds data/textures/* at any hosted sub-path
    const canvas = document.createElement('canvas');
    canvas.className = 'gv-starfield';
    canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    map.getCanvasContainer().appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let time = opts.time ? new Date(opts.time) : new Date();
    const flags = Object.assign({stars: true, milkyWay: true, planets: true, sun: true, moon: true,
        deepSky: true, constellations: true, starLabels: false, grid: false, ecliptic: false}, opts);
    const magLimit = opts.magLimit ?? 6.5;
    const catalog = opts.catalog || Cel.STARS;
    const mw = Cel.milkyWaySamples(1100);

    // Travel hotspots: the bodies we can actually stand on (Earth, Moon, Mars) become clickable
    // targets when they appear in the sky. Enabled only when the caller supplies onTravel, so the
    // decorative hero sky stays inert. Rendered as DOM markers (CSS pulse, hover label, real clicks)
    // positioned each frame from the projected sky position, so they never block map dragging.
    const navigable = new Set((opts.navigable || []).map((s) => s.toLowerCase()));
    const onTravel = typeof opts.onTravel === 'function' ? opts.onTravel : null;
    const interactive = !!(onTravel && navigable.size);
    let markerLayer = null;
    const markers = new Map();   // bodyId -> button element
    if (interactive) {
        ensureHotspotStyle();
        markerLayer = document.createElement('div');
        markerLayer.className = 'gv-hotspot-layer';
        markerLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2;';
        map.getCanvasContainer().appendChild(markerLayer);
    }
    const marker = (id, name) => {
        let el = markers.get(id);
        if (!el) {
            el = document.createElement('button');
            el.type = 'button';
            el.className = 'gv-hotspot';
            el.setAttribute('aria-label', `Travel to ${name}`);
            const lab = document.createElement('span');
            lab.className = 'gv-hotspot-label';
            lab.textContent = `Travel to ${name}`;
            el.appendChild(lab);
            el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onTravel(id, name); });
            markerLayer.appendChild(el);
            markers.set(id, el);
        }
        return el;
    };
    const updateMarkers = (hotspots) => {
        if (!interactive) return;
        const active = new Set();
        for (const hs of hotspots) {
            active.add(hs.id);
            const el = marker(hs.id, hs.name);
            el.style.left = hs.X + 'px'; el.style.top = hs.Y + 'px'; el.style.display = '';
        }
        for (const [id, el] of markers) if (!active.has(id)) el.style.display = 'none';
    };

    // Pre-bake the field once per epoch: proper motion + colour, so per-frame cost is project+draw.
    let prepared = [];
    const prepare = () => {
        const years = Cel.yearsSinceJ2000(time);
        prepared = [];
        for (const s of catalog) {
            if (s[2] > magLimit) continue;
            const hasPM = typeof s[4] === 'number';
            prepared.push({vec: Cel.starVecAtEpoch(s[0], s[1], hasPM ? s[4] : 0, hasPM ? s[5] : 0, years), mag: s[2], rgb: Cel.colorFromBV(s[3]).join(',')});
        }
    };
    prepare();

    const fit = () => {
        const c = map.getCanvas();
        canvas.width = Math.round(c.clientWidth * dpr); canvas.height = Math.round(c.clientHeight * dpr);
        canvas.style.width = c.clientWidth + 'px'; canvas.style.height = c.clientHeight + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    // Calibrate a pinhole camera to MapLibre's globe: focal length f (px) and camera distance D.
    const calibrate = (lngc, latc) => {
        const pc = map.project([lngc, latc]);
        const near = offsetLL(lngc, latc, rad(1), 0), pn = map.project(near);
        const k = Math.hypot(pn.x - pc.x, pn.y - pc.y) / rad(1);
        let best = null;
        for (const azDeg of [0, 180, 90, 270]) {
            const gf = rad(38), dst = offsetLL(lngc, latc, gf, rad(azDeg)), pf = map.project(dst);
            const back = map.unproject([pf.x, pf.y]);
            if (Math.abs(back.lng - dst[0]) < 1 && Math.abs(back.lat - dst[1]) < 1) { best = {far: Math.hypot(pf.x - pc.x, pf.y - pc.y), gf}; break; }
        }
        let D = 60;
        if (best) { const ratio = best.far / k, d = (ratio * Math.cos(best.gf) - Math.sin(best.gf)) / (ratio - Math.sin(best.gf)); if (Number.isFinite(d) && d > 1.001) D = d; }
        const f = k * (D - 1);
        return {cx: pc.x, cy: pc.y, f, D};   // D = camera distance to globe centre, in globe radii
    };

    const render = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (map.getProjection?.().type === 'mercator') { updateMarkers([]); return; }
        const w = canvas.width / dpr, h = canvas.height / dpr;

        const {d, T} = Cel.julian(time);
        const el = iauElements(getBody(), d, T);
        const C = map.getCenter();
        const bearing = rad(map.getBearing()), pitch = rad(map.getPitch());
        const c = vecLL(C.lng, C.lat);
        let north0 = V.sub([0, 0, 1], V.scale(c, V.dot([0, 0, 1], c)));
        north0 = V.norm(north0) < 1e-6 ? V.unit(V.sub([1, 0, 0], V.scale(c, V.dot([1, 0, 0], c)))) : V.unit(north0);
        const east0 = V.unit(V.cross(north0, c));
        // Screen-up = north rotated by the map bearing (compass heading of "up"), so the sky turns
        // the SAME way as the globe when you rotate the view. The +sin matches MapLibre's bearing.
        let up = V.add(V.scale(north0, Math.cos(bearing)), V.scale(east0, Math.sin(bearing)));
        const right = V.unit(V.cross(up, c));
        let fwd = V.scale(c, -1);
        up = V.unit(rotAxis(up, right, pitch)); fwd = V.unit(rotAxis(fwd, right, pitch));
        const {cx, cy, f, D} = calibrate(C.lng, C.lat);

        // Camera position (globe radii): the look-at is the centre surface point (c, radius 1) and
        // the camera sits (D-1) behind it along -fwd, so this stays correct as pitch tilts the view.
        // A star (direction s, at infinity) is occluded when it lies inside the globe's tangent cone:
        //   angle(s, camera->centre) < angular radius a,  i.e.  dot(s, Phat) <= -cos(a),  sin(a)=1/|P|.
        // This is a true 3D sphere test, so stars no longer leak over the globe when pitched.
        const camPos = V.sub(c, V.scale(fwd, D - 1));
        const Pmag = V.norm(camPos), Phat = V.unit(camPos);
        const cosAlpha = Math.sqrt(Math.max(1e-9, 1 - 1 / (Pmag * Pmag)));

        const project = (cel) => {
            const s = celestialToBody(cel, el);
            const z = V.dot(s, fwd);
            if (z <= 1e-3) return null;
            const X = cx + f * V.dot(s, right) / z, Y = cy - f * V.dot(s, up) / z;
            return {X, Y, occluded: V.dot(Phat, s) <= -cosAlpha};
        };
        const vis = (p) => p && !p.occluded && p.X > -20 && p.Y > -20 && p.X < w + 20 && p.Y < h + 20;
        const projRD = (ra, dec) => project(Cel.eqToVec(ra, dec));
        // Draws a projected great circle, skipping segments hidden behind the body. Returns the topmost
        // on-screen point it drew (clear of the edges) so a caller can anchor a label without re-projecting.
        const polyarc = (fn, n, style, width, alpha) => {
            ctx.strokeStyle = style; ctx.lineWidth = width; ctx.globalAlpha = alpha;
            ctx.beginPath(); let drawing = false, top = null;
            for (let i = 0; i <= n; i++) {
                const p = project(fn(i / n)); const ok = vis(p);
                if (ok) {
                    if (drawing) ctx.lineTo(p.X, p.Y); else { ctx.moveTo(p.X, p.Y); drawing = true; }
                    if (p.X > 70 && p.X < w - 70 && p.Y > 16 && (!top || p.Y < top.Y)) top = {X: p.X, Y: p.Y};
                } else drawing = false;
            }
            ctx.stroke(); ctx.globalAlpha = 1;
            return top;
        };

        if (flags.milkyWay) {
            ctx.globalCompositeOperation = 'lighter';
            for (const m of mw) {
                const p = project(m.v); if (!vis(p)) continue;
                ctx.globalAlpha = Math.min(0.5, m.i * 0.07); ctx.fillStyle = '#9fb0ff';
                ctx.beginPath(); ctx.arc(p.X, p.Y, 2.6, 0, 2 * Math.PI); ctx.fill();
            }
            ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        }
        if (flags.grid) {
            for (let ra = 0; ra < 360; ra += 30) polyarc((t) => Cel.eqToVec(ra, -80 + 160 * t), 48, '#3a4a6a', 0.6, 0.5);
            for (const dec of [-60, -30, 0, 30, 60]) polyarc((t) => Cel.eqToVec(360 * t, dec), 96, dec === 0 ? '#5a6a8a' : '#3a4a6a', dec === 0 ? 0.9 : 0.6, 0.55);
        }
        if (flags.ecliptic) polyarc((t) => Cel.eclToEq(360 * t, 0, 23.439), 180, '#caa94a', 1, 0.7);
        // Orbital-plane ring. On Earth there is no parent body on screen and Earth's own orbit collapses
        // onto the ecliptic, so the ring worth drawing is the MOON's orbit around Earth — the Moon rides
        // along it, which is what makes it legible. On every other body we draw that body's own plane.
        let orbitLabelInfo = null;
        if (flags.orbit) {
            const onEarth = getBody() === 'earth';
            const orbitCol = onEarth ? '#cdd6e0' : '#43d6b0';
            const orbitFn = greatCircleFn(Cel.orbitNormal(onEarth ? 'moon' : getBody(), time));
            const top = polyarc(orbitFn, 180, orbitCol, 1.1, 0.78);   // reuses polyarc's own projection for the label anchor
            if (top) orbitLabelInfo = {X: top.X, Y: top.Y, text: onEarth ? 'Moon’s orbit' : 'orbital plane', col: orbitCol};
        }

        if (flags.constellations) {
            ctx.strokeStyle = '#5c86c4'; ctx.lineWidth = 1; ctx.globalAlpha = 0.55;
            for (const con of Cel.CONSTELLATIONS) for (const [a, b] of con.segments) {
                const pa = projRD(Cel.STARS[a][0], Cel.STARS[a][1]), pb = projRD(Cel.STARS[b][0], Cel.STARS[b][1]);
                if (vis(pa) && vis(pb)) { ctx.beginPath(); ctx.moveTo(pa.X, pa.Y); ctx.lineTo(pb.X, pb.Y); ctx.stroke(); }
            }
            ctx.globalAlpha = 1;
        }
        if (flags.deepSky) for (const ds of Cel.DEEPSKY) {
            const p = projRD(ds[0], ds[1]); if (!vis(p)) continue;
            const g = ctx.createRadialGradient(p.X, p.Y, 0, p.X, p.Y, 7);
            g.addColorStop(0, 'rgba(180,200,255,0.5)'); g.addColorStop(1, 'rgba(180,200,255,0)');
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.X, p.Y, 7, 0, 2 * Math.PI); ctx.fill();
        }

        const labels = [];
        if (flags.stars) {
            ctx.globalCompositeOperation = 'lighter';
            for (const st of prepared) {
                const p = project(st.vec); if (!vis(p)) continue;
                if (st.mag > 2.6) {
                    ctx.globalAlpha = Math.max(0.18, 0.92 - 0.12 * st.mag);
                    ctx.fillStyle = `rgb(${st.rgb})`;
                    const d2 = st.mag > 4.6 ? 1 : 1.5;
                    ctx.fillRect(p.X - d2 / 2, p.Y - d2 / 2, d2, d2);
                } else {
                    ctx.globalAlpha = 1;
                    const core = Math.max(1, 2.8 - 0.34 * st.mag), halo = core * 3.4;
                    const g = ctx.createRadialGradient(p.X, p.Y, 0, p.X, p.Y, halo);
                    g.addColorStop(0, `rgba(${st.rgb},0.95)`); g.addColorStop(0.3, `rgba(${st.rgb},0.3)`); g.addColorStop(1, `rgba(${st.rgb},0)`);
                    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.X, p.Y, halo, 0, 2 * Math.PI); ctx.fill();
                    ctx.fillStyle = `rgb(${st.rgb})`; ctx.beginPath(); ctx.arc(p.X, p.Y, core, 0, 2 * Math.PI); ctx.fill();
                }
            }
            ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        }
        if (flags.starLabels) for (const bs of Cel.STARS) {
            if (bs[2] > 1.8) continue;
            const p = projRD(bs[0], bs[1]); if (vis(p)) labels.push([p.X + 4, p.Y, bs[4], '#9db4d8']);
        }

        const sprite = (p, r, rgb, glow) => {
            ctx.globalCompositeOperation = 'lighter';
            const g = ctx.createRadialGradient(p.X, p.Y, 0, p.X, p.Y, r * glow);
            g.addColorStop(0, `rgba(${rgb},0.9)`); g.addColorStop(0.3, `rgba(${rgb},0.4)`); g.addColorStop(1, `rgba(${rgb},0)`);
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.X, p.Y, r * glow, 0, 2 * Math.PI); ctx.fill();
            ctx.fillStyle = `rgb(${rgb})`; ctx.beginPath(); ctx.arc(p.X, p.Y, r, 0, 2 * Math.PI); ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
        };
        // Sun, Moon and planets as seen FROM the current body (so the Moon shows Earth, not the Moon).
        const hotspots = [];
        const here = getBody();
        const bodyList = Cel.skyBodies(here, time);
        const sunB = bodyList.find((bd) => bd.kind === 'sun');
        const sunS = sunB && celestialToBody(Cel.eqToVec(sunB.ra, sunB.dec), el);   // Sun direction in body frame
        const R_SUN_AU = 696000 / 1.495978707e8;
        for (const b of bodyList) {
            const disc = b.kind === 'moon' || b.kind === 'earth';   // resolved bodies: the Earth–Moon pair
            if ((b.kind === 'sun' && !flags.sun) || (b.kind === 'moon' && !flags.moon)
                || ((b.kind === 'planet' || b.kind === 'earth') && !flags.planets)) continue;
            const p = projRD(b.ra, b.dec); if (!vis(p)) continue;
            const rgb = hexToRgb(b.color);
            let r;
            if (disc) {
                // True angular size (angRad) projected through the view's focal length f — so the Moon
                // reads ~0.5° from Earth and Earth ~1.9° from the Moon (a real disc, not a planet dot).
                r = Math.max(3.5, f * (b.angRad || 0.0045));
                // The lit limb faces the Sun — computed in 3D (the Sun's direction tangent to the body,
                // projected onto the screen's right/up axes) so it's correct even when the Sun is off-screen.
                let litAngle = 0;
                if (sunS) {
                    const bS = celestialToBody(Cel.eqToVec(b.ra, b.dec), el), dp = V.dot(sunS, bS);
                    const tan = [sunS[0] - bS[0] * dp, sunS[1] - bS[1] * dp, sunS[2] - bS[2] * dp];
                    litAngle = Math.atan2(-V.dot(tan, up), V.dot(tan, right));
                }
                // Real surface map: the Moon shows its Earth-facing (near) side; Earth shows the longitude
                // currently under the Moon (moonRA − GMST), so it turns through the day. Falls back to the
                // flat shaded disc until the texture decodes.
                const lon0 = b.kind === 'earth' ? moonOfDate(time).ra - gmst(time) : 0;
                const tex = r > 5 ? orthoSphere(b.kind, 2 * r, lon0, base) : null;
                drawPhasedDisc(ctx, p.X, p.Y, r, b.illum ?? 1, litAngle, rgb, tex);
                labels.push([p.X + r + 5, p.Y, `${b.name} ${((b.illum ?? 1) * 100) | 0}%`, b.color]);
            } else {
                // The Sun true-to-scale (atan(R_sun/distance)); planets are point sources sized by brightness.
                r = b.kind === 'sun' ? Math.max(2, f * Math.atan(R_SUN_AU / (b.dist || 1))) : Math.max(1.6, 3.4 - 0.85 * b.mag);
                sprite(p, r, rgb, b.kind === 'sun' ? 4 : 2.4);
                labels.push([p.X + r + 4, p.Y, b.name, b.color]);
            }
            const id = b.name.toLowerCase();
            if (interactive && navigable.has(id) && id !== here) hotspots.push({id, name: b.name, X: p.X, Y: p.Y});
        }
        updateMarkers(hotspots);

        const mono = getComputedStyle(document.body).getPropertyValue('--gv-font-mono') || 'monospace';
        if (labels.length) {
            ctx.font = '11px ' + mono; ctx.textBaseline = 'middle';
            for (const [x, y, text, col] of labels) { ctx.fillStyle = col; ctx.globalAlpha = 0.85; ctx.fillText(text, x, y); }
            ctx.globalAlpha = 1;
        }
        if (flags.constellations && flags.starLabels) {
            ctx.font = '10px ' + mono; ctx.fillStyle = '#6f86b0'; ctx.globalAlpha = 0.7; ctx.textAlign = 'center';
            for (const con of Cel.CONSTELLATIONS) { if (!con.label) continue; const p = projRD(con.label[0], con.label[1]); if (vis(p)) ctx.fillText(con.name.toUpperCase(), p.X, p.Y); }
            ctx.globalAlpha = 1; ctx.textAlign = 'left';
        }
        if (orbitLabelInfo) {   // drawn last so stars/constellations never sit on top of the ring's name
            ctx.font = '11px ' + mono; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = orbitLabelInfo.col; ctx.globalAlpha = 0.9;
            ctx.fillText(orbitLabelInfo.text, orbitLabelInfo.X, orbitLabelInfo.Y - 7);
            ctx.textAlign = 'left'; ctx.globalAlpha = 1;
        }
    };

    fit(); render();
    const onResize = () => { fit(); render(); };
    map.on('move', render); map.on('resize', onResize);

    return {
        redraw: render,
        setTime: (t) => { time = new Date(t); prepare(); render(); },
        set: (k, v) => { flags[k] = v; render(); },
        time: () => time,
        count: () => prepared.length,
        canvas: () => canvas,   // the overlay canvas, so a snapshot can composite the sky over the globe
        stop: () => { map.off('move', render); map.off('resize', onResize); canvas.remove(); markerLayer?.remove(); markers.clear(); }
    };
}

/**
 * Shade the real night side of the body as a dark fill. Inserted beneath opts.beforeId if that
 * layer exists, so data/label layers stay visible.
 * @returns {{redraw, setTime, stop}}
 */
export function createTerminator(map, opts = {}) {
    const getBody = opts.getBody || (() => opts.body || 'earth');
    let time = opts.time ? new Date(opts.time) : new Date();
    const src = 'gv-terminator';
    if (!map.getSource(src)) map.addSource(src, {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
    if (!map.getLayer(src)) map.addLayer({id: src, type: 'fill', source: src,
        paint: {'fill-color': '#05080f', 'fill-opacity': opts.opacity ?? 0.5}}, opts.beforeId && map.getLayer(opts.beforeId) ? opts.beforeId : undefined);

    const render = () => {
        const {d, T} = Cel.julian(time);
        const el = iauElements(getBody(), d, T);
        const sbf = celestialToBody(Cel.sunDirForBody(getBody(), time), el);
        const [subLng, subLat] = llVec(sbf);
        // Night = where the Sun is below the horizon. Trace the terminator as latitude vs longitude
        // and close it along the dark (winter) pole, so the polygon is a clean -180..180 strip with
        // no antimeridian crossing or pole-encircling cap (which earcut mis-fills on the globe).
        //   sin(alt) = sin(lat)sin(dec) + cos(lat)cos(dec)cos(H) = 0  ->  lat = atan(-cos(H)/tan(dec))
        const tanDec = Math.tan(rad(subLat)) || 1e-6;   // subsolar latitude acts as the declination
        const nightPole = subLat >= 0 ? -90 : 90;        // the pole in polar night
        const ring = [];
        for (let lng = -180; lng <= 180; lng += 1) {
            const H = rad(lng - subLng);
            ring.push([lng, Math.atan(-Math.cos(H) / tanDec) * 180 / Math.PI]);
        }
        ring.push([180, nightPole], [-180, nightPole], [ring[0][0], ring[0][1]]);
        map.getSource(src).setData({type: 'Feature', geometry: {type: 'Polygon', coordinates: [ring]}, properties: {}});
    };
    render();
    map.on('move', render);

    return {
        redraw: render,
        setTime: (t) => { time = new Date(t); render(); },
        stop: () => {
            map.off('move', render);
            if (map.getLayer(src)) map.removeLayer(src);
            if (map.getSource(src)) map.removeSource(src);
        }
    };
}
