// Rendered Data — shape-model renderer for irregular (non-spherical) bodies.
//
// The GlobeMap in src/maps.js draws every world on MapLibre's mathematical sphere: Earth, the Moon
// and Mars are spheres wearing an equirectangular texture. That is exactly wrong for a body like
// Phobos, which is a ~27x22x18 km lump with a crater (Stickney) nearly half its width. You cannot
// map a sphere onto Phobos; you have to map onto its actual shape.
//
// So this is a second, smaller renderer that takes NASA's own glTF (.glb) shape models and draws
// them as what they are — a triangle mesh — in a plain WebGL canvas, with the map data (a lon/lat
// graticule and named surface features) draped on the real surface rather than on a pretend sphere.
// It is dependency-free: the .glb container and its accessors are parsed here, the embedded texture
// is decoded with the browser's own createImageBitmap, and the 4x4 matrix maths is a few functions
// at the bottom of this file. Same house rule as the rest of the SDK: no library you cannot read.
//
//   import {ShapeModel} from './src/maps.js';
//
//   const m = new ShapeModel({
//     container: 'view',
//     model: 'data/models/phobos.glb',
//     radiusKm: [13.0, 11.4, 9.1],              // triaxial, for the readout only
//     graticule: true,
//     features: [{name: 'Stickney', lon: 49, lat: 1}],
//   });
//   await m.ready;
//   m.on('select', (f) => console.log(f.name, f.lon, f.lat));
//
// A ShapeModel owns its own <canvas> inside the container and its own animation loop. It is not a
// MapLibre map, so the tile/projection map features do not apply; what it shares with GlobeMap is the
// shape of the API — an options object, a `ready` promise, an event emitter, and setters that read
// back the same vocabulary. The real celestial sky (stars, Milky Way, constellations, Sun/planets)
// DOES work here: the shared astronomy engine (src/celestial.js) gives body-oriented sky vectors, and
// they are drawn as real 3D points/lines in this canvas, occluded by the body.

import * as Cel from './celestial.js';
import {parseVector, bounds} from './vectorparse.js';

/** Minimal event emitter, same contract as GlobeMap's. on() returns an unsubscribe. */
class Emitter {
    #h = new Map();
    on(t, cb) { (this.#h.get(t) || this.#h.set(t, new Set()).get(t)).add(cb); return () => this.off(t, cb); }
    off(t, cb) { this.#h.get(t)?.delete(cb); }
    emit(t, p) { for (const cb of this.#h.get(t) || []) cb(p); }
}

export class ShapeModel extends Emitter {
    /**
     * @param {object} opts
     * @param {string|HTMLElement} opts.container   element or id to draw into
     * @param {string} opts.model                   URL of a glTF binary (.glb) shape model
     * @param {string} [opts.label]                 body name, for readouts
     * @param {number|number[]} [opts.radiusKm]     mean radius, or [a, b, c] triaxial semi-axes (km) — readout only
     * @param {boolean} [opts.graticule=true]       draw a lon/lat graticule draped on the surface
     * @param {number} [opts.graticuleStep=30]      graticule spacing in degrees
     * @param {Array<{name,lon,lat}>} [opts.features=[]]  named surface features to pin (planetocentric lon/lat, deg)
     * @param {boolean} [opts.autorotate=true]      idle spin, like the landing-page globe
     * @param {string} [opts.background]            CSS background behind the model (default: deep space)
     * @param {'x'|'y'|'z'} [opts.northAxis='y']    which model axis is the north/spin pole (glTF is y-up)
     * @param {number} [opts.lon0=0]                longitude (deg) that lands on the +reference meridian — calibration
     * @param {1|-1} [opts.lonDir=1]                +1 east-positive, -1 west-positive (Phobos/Mars moons use west)
     */
    constructor(opts = {}) {
        super();
        if (!opts.container) throw new Error('ShapeModel: a container is required');
        if (!opts.model) throw new Error('ShapeModel: a model URL is required');
        this.el = typeof opts.container === 'string' ? document.getElementById(opts.container) : opts.container;
        if (!this.el) throw new Error(`ShapeModel: container "${opts.container}" not found`);
        this.opts = opts;
        this.label = opts.label || 'body';
        this.body = (opts.body || opts.label || '').toLowerCase();   // id for the astronomy engine (ganymede/phobos)
        this.radiusKm = opts.radiusKm ?? null;
        this._grat = opts.graticule !== false;
        this._gratStep = opts.graticuleStep || 30;
        this._labels = opts.labels !== false;    // named feature pins; toggle at runtime with setLabels()
        this.features = (opts.features || []).map((f) => ({...f}));
        this._autorotate = opts.autorotate !== false;
        this.frame = frameFor(opts.northAxis || 'y', opts.lon0 || 0, opts.lonDir === -1 ? -1 : 1);
        this.probe = {state: 'pending', url: abs(opts.model)};

        // camera orbit state. Default distance frames every body the same on load (matches the globe
        // bodies' "whole globe" zoom); opts.dist can override. For a moon with a parent planet, aim the
        // initial view at the sub-primary point so the planet looms in frame on load instead of hiding
        // behind the far side. Clamped to the interaction range.
        let yaw0 = 0.6, pitch0 = 0.35;
        const pcfg = PARENTS[this.body];
        if (pcfg) {
            const L = norm(this.frame.dir(0, 0)), pf = Math.asin(clamp(-L[1], -1, 1)), cp = Math.cos(pf) || 1e-6;
            yaw0 = Math.atan2(-L[0] / cp, -L[2] / cp) + (pcfg.framing ?? 0);
            pitch0 = pcfg.framePitch ?? 0.2;
        }
        this.cam = {yaw: yaw0, pitch: pitch0, dist: clamp(opts.dist || 5, 1.35, 8), fov: 38};
        this._spin = 0;
        this._markers = new Map();
        this._sky = null;              // celestial sky state, created by addStarfield()
        this._parentBody = null;       // the primary this moon orbits, drawn looming in its sky (built on boot)
        this._parentTime = null;       // epoch used to light the parent (tracks the sky clock when set)
        this._userLayers = new Map();  // id -> draped GeoJSON layer, created by addUserLayer()
        this._userSeq = 0;
        this.ready = this._boot().then(() => this);
    }

    async _boot() {
        this._buildDom();
        const t0 = performance.now();
        let glb;
        try {
            const res = await fetch(abs(this.opts.model), {cache: 'no-store'});
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            glb = parseGLB(buf);
            Object.assign(this.probe, {state: 'ok', bytes: buf.byteLength, ms: Math.round(performance.now() - t0),
                verts: glb.count, tris: glb.indices.length / 3});
        } catch (err) {
            Object.assign(this.probe, {state: 'fail', ms: Math.round(performance.now() - t0), error: String(err.message || err)});
            this.emit('probe', this.probe);
            this._fatal(`Could not load the model: ${this.probe.error}`);
            throw err;
        }
        this.emit('probe', this.probe);

        this.mesh = normalizeMesh(glb);                 // unit-radius positions + bounds, keeps real proportions
        this._radiusGrid = buildRadiusGrid(this.mesh.positions, this.frame);  // dir -> surface radius, for draping
        this._initGL(glb);
        this._buildGraticule();
        this._buildFeatureMarkers();
        this._buildParentBody();
        this._bindControls();
        this._resize();
        this._running = true;
        this._loop();
        this.emit('ready', this);
    }

    // ---- DOM / canvas ----------------------------------------------------------
    _buildDom() {
        const host = this.el;
        host.classList.add('gv-shape');
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.style.background = this.opts.background || SPACE_BG;
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab;';
        host.appendChild(this.canvas);
        this.overlay = document.createElement('div');   // holds feature pins
        this.overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
        host.appendChild(this.overlay);
    }
    _fatal(msg) {
        const d = document.createElement('div');
        d.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:#ffd9d5;font:13px system-ui,sans-serif;';
        d.textContent = msg;
        this.el.appendChild(d);
    }

    _initGL(glb) {
        const gl = this.gl = this.canvas.getContext('webgl', {antialias: true, alpha: true, premultipliedAlpha: false});
        if (!gl) { this._fatal('WebGL is unavailable in this browser.'); throw new Error('no webgl'); }
        gl.enable(gl.DEPTH_TEST);
        gl.clearColor(0, 0, 0, 0);

        // Surface program: textured mesh with one simple directional (sun) light + ambient fill.
        this.progSurface = makeProgram(gl, VERT_SURFACE, FRAG_SURFACE);
        this.locS = attribsUniforms(gl, this.progSurface, ['a_pos', 'a_norm', 'a_uv'], ['u_mvp', 'u_model', 'u_light', 'u_tex', 'u_ambient']);
        this.bufPos = buffer(gl, this.mesh.positions);
        this.bufNorm = buffer(gl, this.mesh.normals);
        this.bufUv = buffer(gl, this.mesh.uvs);
        this.bufIdx = indexBuffer(gl, this.mesh.indices);
        this.idxCount = this.mesh.indices.length;

        // Line program: the graticule and feature stems, flat colour.
        this.progLine = makeProgram(gl, VERT_LINE, FRAG_LINE);
        this.locL = attribsUniforms(gl, this.progLine, ['a_pos'], ['u_mvp', 'u_color']);

        // Star program: coloured, sized point sprites with a soft round falloff (for the sky).
        this.progStar = makeProgram(gl, VERT_STAR, FRAG_STAR);
        this.locStar = attribsUniforms(gl, this.progStar, ['a_pos', 'a_col', 'a_size'], ['u_mvp', 'u_alpha']);

        // Planet program + a unit sphere, for the parent world (Mars from Phobos, Jupiter from Ganymede)
        // that looms in a moon's sky — Sun-lit with a soft terminator, and banded for the gas giant.
        this.progPlanet = makeProgram(gl, VERT_PLANET, FRAG_PLANET);
        this.locP = attribsUniforms(gl, this.progPlanet, ['a_pos'], ['u_mvp', 'u_color', 'u_sun', 'u_bands', 'u_hasTex', 'u_tex']);
        const sphere = buildUVSphere();
        this.bufPlanet = buffer(gl, sphere.positions);
        this.bufPlanetIdx = indexBuffer(gl, sphere.indices);
        this.planetIdxCount = sphere.indices.length;

        // Optional equirectangular surface map for the parent planet (real Mars imagery for Phobos).
        // Starts as a flat placeholder so the first frames draw, then swaps to the decoded image.
        this._parentTexOn = false;
        const pcfg = PARENTS[this.body];
        if (pcfg?.texture) {
            this.texPlanet = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.texPlanet);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([120, 70, 50, 255]));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            const img = new Image();
            img.onload = () => {
                gl.bindTexture(gl.TEXTURE_2D, this.texPlanet);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);           // wrap longitude, no seam
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                gl.generateMipmap(gl.TEXTURE_2D);                                        // 2048x1024 is power-of-two
                this._parentTexOn = true;
            };
            img.onerror = () => {};   // fall back to the flat lit colour if the map can't load
            img.src = abs(pcfg.texture);
        }

        // Texture from the embedded image (decoded off the main parse via createImageBitmap).
        this.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([90, 90, 96, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        if (glb.image) createImageBitmap(glb.image).then((bmp) => {
            gl.bindTexture(gl.TEXTURE_2D, this.tex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        }).catch(() => {});
    }

    // ---- graticule & features (draped on the mesh, from geometry) ---------------
    _buildGraticule() {
        const step = this._gratStep, pts = [], seg = 2;   // 2-degree chords
        const push = (lon, lat) => { const p = this._surfacePoint(lon, lat, 1.012); pts.push(p[0], p[1], p[2]); };
        // meridians (constant lon)
        for (let lon = -180; lon < 180; lon += step) {
            for (let lat = -90; lat < 90; lat += seg) { push(lon, lat); push(lon, Math.min(90, lat + seg)); }
        }
        // parallels (constant lat)
        for (let lat = -90 + step; lat < 90; lat += step) {
            for (let lon = -180; lon < 180; lon += seg) { push(lon, lat); push(lon + seg, lat); }
        }
        this.bufGrat = buffer(this.gl, new Float32Array(pts));
        this.gratCount = pts.length / 3;

        // Equator + prime meridian, drawn brighter on top.
        const em = [];
        for (let lon = -180; lon < 180; lon += seg) { const a = this._surfacePoint(lon, 0, 1.013), b = this._surfacePoint(lon + seg, 0, 1.013); em.push(...a, ...b); }
        for (let lat = -90; lat < 90; lat += seg) { const a = this._surfacePoint(0, lat, 1.013), b = this._surfacePoint(0, lat + seg, 1.013); em.push(...a, ...b); }
        this.bufAxes = buffer(this.gl, new Float32Array(em));
        this.axesCount = em.length / 3;
    }

    _buildFeatureMarkers() {
        this.overlay.replaceChildren();
        this.overlay.style.display = this._labels ? '' : 'none';   // honor the labels toggle on (re)build
        this._markers.clear();
        const stems = [];
        for (const f of this.features) {
            const base = this._surfacePoint(f.lon, f.lat, 1.0);
            const top = this._surfacePoint(f.lon, f.lat, 1.16);
            f._base = base; f._top = top;
            stems.push(...base, ...top);
            const pin = document.createElement('button');
            pin.className = 'gv-shape-pin';
            pin.type = 'button';
            pin.innerHTML = `<span class="gv-shape-label">${escapeHtml(f.name)}</span><span class="gv-shape-dot"></span>`;
            pin.style.cssText = 'position:absolute;display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);pointer-events:auto;background:none;border:0;padding:0;cursor:pointer;white-space:nowrap;';
            pin.addEventListener('click', () => this.emit('select', {...f, body: this.label}));
            this.overlay.appendChild(pin);
            this._markers.set(f, pin);
        }
        this.bufStems = stems.length ? buffer(this.gl, new Float32Array(stems)) : null;
        this.stemCount = stems.length / 3;
    }

    // A point on (or just above) the real surface at lon/lat, scaled by `lift` (1.0 = surface).
    _surfacePoint(lon, lat, lift = 1) {
        const d = this.frame.dir(lon, lat);
        const r = sampleRadius(this._radiusGrid, this.frame, d) * lift;
        return [d[0] * r, d[1] * r, d[2] * r];
    }

    // ---- interaction -----------------------------------------------------------
    _bindControls() {
        const c = this.canvas; let drag = null;
        const down = (e) => { drag = {x: e.clientX, y: e.clientY}; c.style.cursor = 'grabbing'; c.setPointerCapture?.(e.pointerId); this._userActive = true; };
        const move = (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag = {x: e.clientX, y: e.clientY};
            // "Grab the surface": the point under the cursor follows the cursor, matching the MapLibre
            // globe. Drag right → surface moves right (yaw down); drag down → the north/top tips into
            // view (camera elevation up).
            this.cam.yaw -= dx * 0.008;
            this.cam.pitch = clamp(this.cam.pitch + dy * 0.008, -1.45, 1.45);
        };
        const up = (e) => { drag = null; c.style.cursor = 'grab'; c.releasePointerCapture?.(e.pointerId); };
        c.addEventListener('pointerdown', down);
        c.addEventListener('pointermove', move);
        c.addEventListener('pointerup', up);
        c.addEventListener('pointerleave', up);
        c.addEventListener('wheel', (e) => { e.preventDefault(); this.cam.dist = clamp(this.cam.dist * (1 + Math.sign(e.deltaY) * 0.08), 1.35, 8); this._userActive = true; }, {passive: false});
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(this.el);
    }

    _resize() {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = this.el.clientWidth || 640, h = this.el.clientHeight || 480;
        this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
        this._vw = w; this._vh = h; this._dpr = dpr;
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    // ---- render loop -----------------------------------------------------------
    _loop() {
        if (!this._running) return;
        if (this._autorotate && !this._userActive) this._spin += 0.0016;
        this._draw();
        this._raf = requestAnimationFrame(() => this._loop());
    }

    _view() {
        const {yaw, pitch, dist} = this.cam;
        const y = yaw + this._spin;
        const eye = [dist * Math.cos(pitch) * Math.sin(y), dist * Math.sin(pitch), dist * Math.cos(pitch) * Math.cos(y)];
        const proj = perspective(this.cam.fov * Math.PI / 180, (this._vw || 1) / (this._vh || 1), 0.05, 100);
        const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
        return {eye, proj, view, mvp: mul(proj, view)};
    }

    _draw() {
        const gl = this.gl;
        const {eye, proj, view, mvp} = this._view();
        // With the sky on, clear to opaque black so additive stars read at full brightness (a transparent
        // canvas would composite the glow against the page and wash it out); otherwise stay transparent
        // so the CSS deep-space gradient shows around the body.
        gl.clearColor(0, 0, 0, this._sky?.active ? 1 : 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // Celestial sky + parent planet, drawn first against a rotation-only view (no translation) so
        // stars sit at infinity and the parent hangs fixed over this moon's sub-primary point; the
        // opaque body is then drawn over them, occluding whatever falls behind its near hemisphere.
        if (this._sky?.active || this._parentBody) {
            const skyMvp = mul(proj, rotationOnly(view));
            if (this._sky?.active) this._drawSky(skyMvp);
            if (this._parentBody) this._drawParent(skyMvp);
        }

        // surface
        gl.useProgram(this.progSurface);
        const lightDir = norm([eye[0] * 0.4 + 0.7, eye[1] * 0.4 + 0.55, eye[2] * 0.4 + 0.3]);  // sun roughly from the camera's upper right
        gl.uniformMatrix4fv(this.locS.u_mvp, false, mvp);
        gl.uniformMatrix4fv(this.locS.u_model, false, IDENTITY);
        gl.uniform3fv(this.locS.u_light, lightDir);
        gl.uniform1f(this.locS.u_ambient, 0.28);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.uniform1i(this.locS.u_tex, 0);
        bindAttrib(gl, this.bufPos, this.locS.a_pos, 3);
        bindAttrib(gl, this.bufNorm, this.locS.a_norm, 3);
        bindAttrib(gl, this.bufUv, this.locS.a_uv, 2);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx);
        gl.drawElements(gl.TRIANGLES, this.idxCount, gl.UNSIGNED_SHORT, 0);

        // graticule + feature stems (depth-tested so the far side is hidden by the body)
        gl.useProgram(this.progLine);
        gl.uniformMatrix4fv(this.locL.u_mvp, false, mvp);
        if (this._grat && this.gratCount) {
            gl.uniform4f(this.locL.u_color, 0.72, 0.82, 0.92, 0.32);
            bindAttrib(gl, this.bufGrat, this.locL.a_pos, 3);
            gl.drawArrays(gl.LINES, 0, this.gratCount);
            gl.uniform4f(this.locL.u_color, 0.56, 0.95, 0.72, 0.6);     // equator + prime meridian
            bindAttrib(gl, this.bufAxes, this.locL.a_pos, 3);
            gl.drawArrays(gl.LINES, 0, this.axesCount);
        }
        if (this.bufStems && this._labels) {        // stems are part of the labels; hide them together
            gl.uniform4f(this.locL.u_color, 0.98, 0.86, 0.45, 0.9);
            bindAttrib(gl, this.bufStems, this.locL.a_pos, 3);
            gl.drawArrays(gl.LINES, 0, this.stemCount);
        }

        if (this._userLayers.size) this._drawUserLayers(mvp);
        this._placeMarkers(mvp, eye);
    }

    // Project each feature pin to screen, and hide the ones on the far side of the body.
    _placeMarkers(mvp, eye) {
        if (!this._labels) return;                 // labels hidden: overlay is display:none, skip the work
        const w = this._vw, h = this._vh, elen = Math.hypot(...eye);
        for (const [f, pin] of this._markers) {
            const p = f._top;
            // facing test: is the feature on the near hemisphere (its surface normal ~ its direction)?
            const d = f._base, dl = Math.hypot(...d);
            const facing = (d[0] * eye[0] + d[1] * eye[1] + d[2] * eye[2]) / (dl * elen);
            const clip = mulVec(mvp, [p[0], p[1], p[2], 1]);
            if (clip[3] <= 0 || facing < 0.08) { pin.style.display = 'none'; continue; }
            const sx = (clip[0] / clip[3] * 0.5 + 0.5) * w;
            const sy = (1 - (clip[1] / clip[3] * 0.5 + 0.5)) * h;
            pin.style.display = '';
            pin.style.left = sx + 'px';
            pin.style.top = sy + 'px';
            pin.style.opacity = String(clamp((facing - 0.08) / 0.25, 0.25, 1));
        }
    }

    // ---- celestial sky (shared astronomy engine, drawn in this canvas) ---------
    /**
     * Draw the real sky around this body — catalogue stars, the Milky Way, constellations, an RA/Dec
     * grid, the ecliptic and the Sun/planets — oriented by the body's IAU pole + prime meridian for the
     * time, and occluded by the body. Same vocabulary as GlobeMap.addStarfield(). Pass opts.catalog
     * (the 8k-star array) for the full field; otherwise the bundled bright set is used.
     */
    addStarfield(opts = {}) {
        if (!this.gl) return this;
        const flags = Object.assign({stars: true, milkyWay: true, constellations: true, grid: false,
            ecliptic: false, sun: true, planets: true, moon: true}, opts);
        this._sky = {active: true, flags, time: opts.time ? new Date(opts.time) : new Date(),
            catalog: opts.catalog || Cel.STARS, magLimit: opts.magLimit ?? 6.5, buffers: {}};
        this._buildSky();
        this._buildParentBody();                 // relight the parent to match the sky's epoch
        this._userActive = true;                 // hold the sky still (stop the idle spin)
        this.emit('starfield', this._sky);
        return this._sky;
    }
    removeStarfield() { this._sky = null; return this; }
    /** Set the sky date/time; rotates the whole sky to that epoch. */
    setSkyTime(t) { if (this._sky) { this._sky.time = new Date(t); this._buildSky(); this._buildParentBody(); } return this; }
    /** Toggle one sky layer: stars, milkyWay, constellations, grid, ecliptic, sun, planets, moon. */
    setSkyFlag(key, val) {
        if (!this._sky) return this;
        this._sky.flags[key] = !!val;
        if (key === 'sun' || key === 'planets' || key === 'moon') this._buildSkyBodies();
        return this;
    }

    // Map a J2000 celestial unit vector to a unit direction in this model's world frame (pole aligned).
    _skyDir(cel, el) {
        const s = Cel.celestialToBody(cel, el), A = this.frame.A, B = this.frame.B, P = this.frame.P;
        return [s[0] * A[0] + s[1] * B[0] + s[2] * P[0], s[0] * A[1] + s[1] * B[1] + s[2] * P[1], s[0] * A[2] + s[1] * B[2] + s[2] * P[2]];
    }

    _buildSky() {
        const S = this._sky, dpr = this._dpr || 1;
        const {d, T} = Cel.julian(S.time), el = Cel.iauElements(this.body, d, T), dir = (c) => this._skyDir(c, el);

        // Stars: proper-motion-corrected J2000 vectors, coloured by B-V, sized by magnitude.
        const sp = [], sc = [], ss = [], years = Cel.yearsSinceJ2000(S.time);
        for (const st of S.catalog) {
            if (st[2] > S.magLimit) continue;
            const hasPM = typeof st[4] === 'number';
            const w = dir(Cel.starVecAtEpoch(st[0], st[1], hasPM ? st[4] : 0, hasPM ? st[5] : 0, years));
            sp.push(w[0], w[1], w[2]);
            const rgb = Cel.colorFromBV(st[3]); sc.push(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
            ss.push(Math.max(1, 3.0 - 0.42 * st[2]) * dpr);
        }
        this._skyBuf('star', sp, sc, ss);

        // Milky Way: a faint blue cloud of points.
        const mp = [], mc = [], ms = [];
        for (const m of Cel.milkyWaySamples()) {
            const w = dir(m.v); mp.push(w[0], w[1], w[2]);
            const a = Math.min(0.5, m.i * 0.07); mc.push(0.62 * a, 0.69 * a, 1.0 * a); ms.push(2.6 * dpr);
        }
        this._skyBuf('mw', mp, mc, ms);

        // Constellation figures (segments reference the bright-star set).
        const cl = [];
        for (const con of Cel.CONSTELLATIONS) for (const [a, b] of con.segments) {
            cl.push(...dir(Cel.eqToVec(Cel.STARS[a][0], Cel.STARS[a][1])), ...dir(Cel.eqToVec(Cel.STARS[b][0], Cel.STARS[b][1])));
        }
        this._skyLineBuf('con', cl);

        // RA/Dec grid and the ecliptic.
        const grid = [];
        for (let ra = 0; ra < 360; ra += 30) this._arc(grid, (t) => Cel.eqToVec(ra, -80 + 160 * t), 48, dir);
        for (const dec of [-60, -30, 0, 30, 60]) this._arc(grid, (t) => Cel.eqToVec(360 * t, dec), 96, dir);
        this._skyLineBuf('grid', grid);
        const ecl = []; this._arc(ecl, (t) => Cel.eclToEq(360 * t, 0, 23.439), 180, dir);
        this._skyLineBuf('ecl', ecl);

        this._buildSkyBodies();
    }

    _buildSkyBodies() {
        const S = this._sky; if (!S) return;
        const {d, T} = Cel.julian(S.time), el = Cel.iauElements(this.body, d, T), dir = (c) => this._skyDir(c, el), dpr = this._dpr || 1;
        const bp = [], bc = [], bs = [];
        for (const b of Cel.skyBodies(this.body, S.time)) {
            if ((b.kind === 'sun' && !S.flags.sun) || (b.kind === 'moon' && !S.flags.moon) || (b.kind === 'planet' && !S.flags.planets)) continue;
            const w = dir(Cel.eqToVec(b.ra, b.dec)), rgb = hexRgb(b.color);
            bp.push(...w); bc.push(rgb[0], rgb[1], rgb[2]);
            bs.push((b.kind === 'sun' ? 16 : b.kind === 'moon' ? 11 : Math.max(5, 9 - b.mag)) * dpr);
        }
        this._skyBuf('body', bp, bc, bs);
    }

    _arc(out, fn, n, dir) {
        let prev = null;
        for (let i = 0; i <= n; i++) { const w = dir(fn(i / n)); if (prev) out.push(...prev, ...w); prev = w; }
    }
    _skyBuf(name, pos, col, size) {
        const gl = this.gl, B = this._sky.buffers;
        B[name] = B[name] || {pos: gl.createBuffer(), col: gl.createBuffer(), size: gl.createBuffer()};
        gl.bindBuffer(gl.ARRAY_BUFFER, B[name].pos); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, B[name].col); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(col), gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, B[name].size); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(size), gl.DYNAMIC_DRAW);
        B[name].n = size.length;
    }
    _skyLineBuf(name, pos) {
        const gl = this.gl, B = this._sky.buffers;
        B[name] = B[name] || {pos: gl.createBuffer()};
        gl.bindBuffer(gl.ARRAY_BUFFER, B[name].pos); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.DYNAMIC_DRAW);
        B[name].n = pos.length / 3;
    }
    _drawSky(skyMvp) {
        const gl = this.gl, S = this._sky, f = S.flags, B = S.buffers;
        gl.depthMask(false); gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(this.progLine); gl.uniformMatrix4fv(this.locL.u_mvp, false, skyMvp);
        const line = (name, on, r, g, b, a) => { if (!on || !B[name]?.n) return; gl.uniform4f(this.locL.u_color, r, g, b, a); bindAttrib(gl, B[name].pos, this.locL.a_pos, 3); gl.drawArrays(gl.LINES, 0, B[name].n); };
        line('grid', f.grid, 0.36, 0.45, 0.62, 0.5);
        line('ecl', f.ecliptic, 0.79, 0.66, 0.29, 0.7);
        line('con', f.constellations, 0.36, 0.52, 0.77, 0.55);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.useProgram(this.progStar); gl.uniformMatrix4fv(this.locStar.u_mvp, false, skyMvp);
        gl.uniform1f(this.locStar.u_alpha, 1);   // per-point brightness is baked into the colours
        const pts = (name, on) => {
            if (!on || !B[name]?.n) return;
            bindAttrib(gl, B[name].pos, this.locStar.a_pos, 3);
            bindAttrib(gl, B[name].col, this.locStar.a_col, 3);
            bindAttrib(gl, B[name].size, this.locStar.a_size, 1);
            gl.drawArrays(gl.POINTS, 0, B[name].n);
        };
        pts('mw', f.milkyWay); pts('star', f.stars); pts('body', true);
        gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
    }

    // The primary a moon orbits — Mars over Phobos, Jupiter over Ganymede — placed as a Sun-lit globe
    // over the sub-primary point (lon 0, lat 0, where tidally-locked moons keep their primary fixed) at
    // its true angular size. It lives in the rotation-only sky pass, so it stays pinned to the surface as
    // you orbit and the moon's own near hemisphere occludes it as you swing round to the far side.
    _buildParentBody() {
        const p = PARENTS[this.body];
        if (!p || this.opts.showParent === false || !this.gl) { this._parentBody = null; return; }
        const D = 40, R = D * Math.sin(p.angDiam * Math.PI / 360);   // angDiam = full apparent diameter (deg)
        const d = norm(this.frame.dir(0, 0));                        // world direction of the sub-primary point
        const C = [d[0] * D, d[1] * D, d[2] * D];
        const time = this._sky?.time || this._parentTime || new Date();
        this._parentTime = time;
        const {d: jd, T} = Cel.julian(time), el = Cel.iauElements(this.body, jd, T);
        const sun = norm(this._skyDir(Cel.sunDirForBody(this.body, time), el));
        this._parentBody = {name: p.name, color: new Float32Array(p.color), bands: p.bands ? 1 : 0,
            sun: new Float32Array(sun), model: modelTS(C, R)};
    }
    /** Show or hide the parent planet (Mars/Jupiter) in this moon's sky. */
    setParentVisible(on) { this.opts.showParent = !!on; this._buildParentBody(); return this; }

    _drawParent(skyMvp) {
        const gl = this.gl, P = this._parentBody;
        gl.useProgram(this.progPlanet);
        gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
        gl.uniformMatrix4fv(this.locP.u_mvp, false, mul(skyMvp, P.model));
        gl.uniform3fv(this.locP.u_color, P.color);
        gl.uniform3fv(this.locP.u_sun, P.sun);
        gl.uniform1f(this.locP.u_bands, P.bands);
        const useTex = this._parentTexOn && this.texPlanet;
        gl.uniform1f(this.locP.u_hasTex, useTex ? 1 : 0);
        if (useTex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texPlanet); gl.uniform1i(this.locP.u_tex, 0); }
        bindAttrib(gl, this.bufPlanet, this.locP.a_pos, 3);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufPlanetIdx);
        gl.drawElements(gl.TRIANGLES, this.planetIdxCount, gl.UNSIGNED_SHORT, 0);
    }

    // ---- bring your own data (GeoJSON/KML/GPX draped on the real surface) -------
    /**
     * Drape a user layer onto the actual mesh surface — points, lines and polygon outlines, projected by
     * (lon, lat) onto the body and occluded by its far side. Same vocabulary as GlobeMap.addUserLayer();
     * accepts a GeoJSON object, a File/Blob, or a URL to GeoJSON/KML/GPX. Nothing is uploaded. Coordinates
     * are read in this body's planetographic lon/lat.
     * @returns {Promise<{id, kind, license}>}
     */
    async addUserLayer(input, {id, fit = true, color} = {}) {
        await this.ready;
        const key = id || `user-${++this._userSeq}`;
        let data;
        if (typeof input === 'string') {
            const res = await fetch(input.trim(), {cache: 'no-store'});
            if (!res.ok) throw new Error(`Could not fetch layer: HTTP ${res.status}`);
            data = parseVector(input, await res.text());
        } else if (input && typeof input.text === 'function') {           // File / Blob
            data = parseVector(input.name || 'file', await input.text());
        } else if (input && typeof input === 'object' && input.type) {
            data = input;
        }
        if (!data || !data.type) throw new Error('addUserLayer expects GeoJSON/KML/GPX: an object, a File, or a URL');
        if (this._userLayers.has(key)) this.removeUserLayer(key);
        this._buildUserLayer(key, data, toRgb(color, [0.22, 0.86, 0.55]));
        if (fit) { const b = bounds(data); if (b) this.flyTo({lon: (b[0][0] + b[1][0]) / 2, lat: (b[0][1] + b[1][1]) / 2, dist: 2.6}); }
        const desc = {id: key, kind: 'geojson', license: 'user-supplied, license unknown'};
        this.emit('userlayer', desc);
        return desc;
    }
    removeUserLayer(id) {
        const L = this._userLayers.get(id);
        if (!L) return false;
        for (const b of [L.fillBuf, L.lineBuf, L.ptPos, L.ptCol, L.ptSize]) if (b) this.gl.deleteBuffer(b);
        this._userLayers.delete(id);
        return true;
    }
    userLayers() { return [...this._userLayers.keys()].map((id) => ({id})); }

    _buildUserLayer(key, geojson, color) {
        const gl = this.gl, linePos = [], ptPos = [], fillPos = [];
        const addLine = (coords, lift) => {
            for (let i = 1; i < coords.length; i++) {
                const [x1, y1] = coords[i - 1], [x2, y2] = coords[i];
                const steps = Math.max(1, Math.ceil(Math.hypot((x2 - x1) * Math.cos((y1 + y2) / 2 * Math.PI / 180), y2 - y1) / 2));
                let prev = this._surfacePoint(x1, y1, lift);
                for (let s = 1; s <= steps; s++) { const t = s / steps, p = this._surfacePoint(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, lift); linePos.push(...prev, ...p); prev = p; }
            }
        };
        const walk = (g) => {
            if (!g) return;
            if (g.type === 'Point') ptPos.push(...this._surfacePoint(g.coordinates[0], g.coordinates[1], 1.024));
            else if (g.type === 'MultiPoint') for (const c of g.coordinates) ptPos.push(...this._surfacePoint(c[0], c[1], 1.024));
            else if (g.type === 'LineString') addLine(g.coordinates, 1.018);
            else if (g.type === 'MultiLineString') for (const l of g.coordinates) addLine(l, 1.018);
            else if (g.type === 'Polygon') { this._fillPolygon(g.coordinates, fillPos); for (const r of g.coordinates) addLine(r, 1.018); }
            else if (g.type === 'MultiPolygon') for (const p of g.coordinates) { this._fillPolygon(p, fillPos); for (const r of p) addLine(r, 1.018); }
            else if (g.type === 'GeometryCollection') for (const gg of g.geometries) walk(gg);
        };
        const feats = geojson.type === 'FeatureCollection' ? geojson.features.map((f) => f.geometry) : geojson.type === 'Feature' ? [geojson.geometry] : [geojson];
        for (const g of feats) walk(g);

        const L = {color};
        if (fillPos.length) { L.fillBuf = buffer(gl, new Float32Array(fillPos)); L.fillN = fillPos.length / 3; }
        if (linePos.length) { L.lineBuf = buffer(gl, new Float32Array(linePos)); L.lineN = linePos.length / 3; }
        if (ptPos.length) {
            const n = ptPos.length / 3, dpr = this._dpr || 1;
            L.ptPos = buffer(gl, new Float32Array(ptPos));
            L.ptCol = buffer(gl, new Float32Array(Array.from({length: n}, () => color).flat()));
            L.ptSize = buffer(gl, new Float32Array(new Array(n).fill(7.5 * dpr)));
            L.ptN = n;
        }
        this._userLayers.set(key, L);
    }
    // Fill a polygon (rings = [outer, ...holes]) draped on the surface: tessellate its lon/lat bbox into
    // a grid, keep cells whose centre is inside (even-odd over all rings → concave shapes and holes work),
    // and project each cell to the mesh as two triangles that hug the terrain.
    _fillPolygon(rings, out, lift = 1.012) {
        const outer = rings[0]; if (!outer || outer.length < 4) return;
        let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
        for (const [x, y] of outer) { if (x < lonMin) lonMin = x; if (x > lonMax) lonMax = x; if (y < latMin) latMin = y; if (y > latMax) latMax = y; }
        const step = Math.min(4, Math.max(0.5, Math.max(lonMax - lonMin, latMax - latMin) / 50));
        const inside = (lon, lat) => {
            let c = false;
            for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
                if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) c = !c;
            }
            return c;
        };
        for (let lat = latMin; lat < latMax; lat += step) {
            for (let lon = lonMin; lon < lonMax; lon += step) {
                if (!inside(lon + step / 2, lat + step / 2)) continue;
                const a = this._surfacePoint(lon, lat, lift), b = this._surfacePoint(lon + step, lat, lift),
                    d = this._surfacePoint(lon + step, lat + step, lift), e = this._surfacePoint(lon, lat + step, lift);
                out.push(...a, ...b, ...d, ...a, ...d, ...e);
            }
        }
    }
    _drawUserLayers(mvp) {
        const gl = this.gl;
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
        gl.useProgram(this.progLine); gl.uniformMatrix4fv(this.locL.u_mvp, false, mvp);
        for (const L of this._userLayers.values()) {                 // translucent polygon fills
            if (!L.fillN) continue;
            gl.uniform4f(this.locL.u_color, L.color[0], L.color[1], L.color[2], 0.2);
            bindAttrib(gl, L.fillBuf, this.locL.a_pos, 3); gl.drawArrays(gl.TRIANGLES, 0, L.fillN);
        }
        for (const L of this._userLayers.values()) {                 // crisp outlines on top
            if (!L.lineN) continue;
            gl.uniform4f(this.locL.u_color, L.color[0], L.color[1], L.color[2], 0.95);
            bindAttrib(gl, L.lineBuf, this.locL.a_pos, 3); gl.drawArrays(gl.LINES, 0, L.lineN);
        }
        gl.useProgram(this.progStar); gl.uniformMatrix4fv(this.locStar.u_mvp, false, mvp); gl.uniform1f(this.locStar.u_alpha, 1);
        for (const L of this._userLayers.values()) {
            if (!L.ptN) continue;
            bindAttrib(gl, L.ptPos, this.locStar.a_pos, 3);
            bindAttrib(gl, L.ptCol, this.locStar.a_col, 3);
            bindAttrib(gl, L.ptSize, this.locStar.a_size, 1);
            gl.drawArrays(gl.POINTS, 0, L.ptN);
        }
        gl.disable(gl.BLEND); gl.depthMask(true);
    }

    // ---- public API ------------------------------------------------------------
    /** Turn the graticule on or off. */
    setGraticule(on) { this._grat = !!on; this.emit('graticule', this._grat); return this; }
    /** Show or hide the named feature labels (the pins draped on the surface). */
    setLabels(on = true) {
        this._labels = !!on;
        if (this.overlay) this.overlay.style.display = this._labels ? '' : 'none';
        this.emit('labels', this._labels);
        return this;
    }
    /** Whether the feature labels are currently shown. */
    get labels() { return this._labels; }
    /** Replace the pinned features. Each is {name, lon, lat} in planetocentric degrees. */
    setFeatures(list = []) { this.features = list.map((f) => ({...f})); if (this.gl) this._buildFeatureMarkers(); return this; }
    /** Ease the camera to look at a lon/lat. */
    flyTo({lon = 0, lat = 0, dist} = {}) {
        this._userActive = true;
        const d = this.frame.dir(lon, lat);
        this.cam.yaw = Math.atan2(d[0], d[2]);
        this.cam.pitch = clamp(Math.asin(clamp(d[1], -1, 1)), -1.45, 1.45);
        if (dist) this.cam.dist = clamp(dist, 1.35, 8);
        this._spin = 0;
        return this;
    }
    /** Resume the idle auto-rotation. */
    resumeSpin() { this._userActive = false; return this; }
    /** A short physical summary for a readout. */
    describe() {
        const r = this.radiusKm;
        const dims = Array.isArray(r) ? `${r.map((x) => x.toFixed(1)).join(' × ')} km (triaxial)` : (r ? `${r} km mean radius` : '—');
        return {body: this.label, shape: Array.isArray(r) ? 'irregular' : 'round', dims,
            vertices: this.mesh?.count, triangles: this.idxCount ? this.idxCount / 3 : 0};
    }
    resize() { this._resize(); return this; }
    remove() {
        this._running = false; cancelAnimationFrame(this._raf); this._ro?.disconnect();
        const g = this.gl;
        if (g) { const lose = g.getExtension('WEBGL_lose_context'); lose?.loseContext(); }
        this.canvas?.remove(); this.overlay?.remove();
        this.el.classList.remove('gv-shape');
    }
}

export default ShapeModel;

// ============================================================================
// glTF binary (.glb) parsing — container + accessors, no library.
// ============================================================================

const ROOT = new URL('..', import.meta.url).href;
const abs = (u) => (/^https?:/.test(u) ? u : ROOT + u.replace(/^\.?\//, ''));
const SPACE_BG = 'radial-gradient(ellipse at 50% 42%, #10151f 0%, #090d15 45%, #03050b 74%, #000 100%)';
// The primary each supported moon orbits, drawn looming in its sky. angDiam is the primary's true
// apparent diameter from the moon (deg): Mars fills ~42° of Phobos's sky — wider than the camera's
// field of view — while Jupiter spans ~7.7° from Ganymede. bands adds the gas giant's belts.
// The primary each supported moon orbits, drawn looming in its sky. angDiam is its true apparent
// diameter from the moon (deg). framing/framePitch aim the initial camera: Mars is wider than the
// view, so look almost straight at it (small offset) and let Phobos sit silhouetted in front; Jupiter
// is a small disc, so swing further round so it clears Ganymede's limb. bands adds the gas giant's
// belts; texture is a real equirectangular surface map.
const PARENTS = {
    phobos:   {name: 'Mars',    color: [0.74, 0.35, 0.22], angDiam: 42.5, bands: false,
        framing: -0.15, framePitch: -0.05, texture: 'data/textures/mars.jpg'},   // Viking colour mosaic (NASA/USGS, via trek.nasa.gov)
    ganymede: {name: 'Jupiter', color: [0.82, 0.71, 0.55], angDiam: 7.7,  bands: true,
        framing: 0.34,  framePitch: 0.14},
};
const COMPONENT = {5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array};
const NUMCOMP = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16};

// Parse a .glb ArrayBuffer into {positions, normals, uvs, indices, image, count}. Assumes a single
// mesh/primitive of triangles with POSITION/NORMAL/TEXCOORD_0 and one baseColor image — which is the
// shape every NASA solar-system glTF in this project uses. Throws with a clear message otherwise.
export function parseGLB(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a .glb (bad magic)');
    if (dv.getUint32(4, true) !== 2) throw new Error('only glTF 2.0 .glb is supported');
    const total = dv.getUint32(8, true);
    let off = 12, json = null, bin = null;
    while (off < total) {
        const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true); off += 8;
        if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, off, len)));
        else if (type === 0x004e4942) bin = new Uint8Array(arrayBuffer, off, len);
        off += len;
    }
    if (!json) throw new Error('.glb has no JSON chunk');
    const prim = json.meshes?.[0]?.primitives?.[0];
    if (!prim) throw new Error('.glb has no mesh');
    if (prim.mode != null && prim.mode !== 4) throw new Error('only triangle meshes are supported');

    const accessor = (i) => {
        const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
        const TA = COMPONENT[a.componentType], nc = NUMCOMP[a.type];
        const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
        // Interleaved buffers (byteStride) are rare in these models; handle the common tight case,
        // and fall back to a strided copy when a stride is present.
        if (bv.byteStride && bv.byteStride !== nc * TA.BYTES_PER_ELEMENT) {
            const out = new TA(a.count * nc), stride = bv.byteStride;
            const src = new DataView(arrayBuffer, bin.byteOffset);
            const read = readerFor(TA);
            for (let e = 0; e < a.count; e++) for (let c = 0; c < nc; c++) out[e * nc + c] = read(src, base + e * stride + c * TA.BYTES_PER_ELEMENT);
            return out;
        }
        // Tight (non-interleaved) case. A typed-array view requires the byte offset to be a multiple
        // of the element size; GLB usually satisfies this, but copy the bytes when it does not so the
        // browser never throws a RangeError on an unaligned view.
        const byteStart = bin.byteOffset + base, byteLen = a.count * nc * TA.BYTES_PER_ELEMENT;
        if (byteStart % TA.BYTES_PER_ELEMENT === 0) return new TA(arrayBuffer, byteStart, a.count * nc);
        return new TA(arrayBuffer.slice(byteStart, byteStart + byteLen));
    };

    const positions = Float32Array.from(accessor(prim.attributes.POSITION));
    const count = positions.length / 3;
    const normals = prim.attributes.NORMAL != null ? Float32Array.from(accessor(prim.attributes.NORMAL)) : null;
    const uvs = prim.attributes.TEXCOORD_0 != null ? Float32Array.from(accessor(prim.attributes.TEXCOORD_0)) : new Float32Array(count * 2);
    let indices = prim.indices != null ? accessor(prim.indices) : null;
    if (indices && !(indices instanceof Uint16Array)) indices = Uint16Array.from(indices);   // our draw path uses UNSIGNED_SHORT
    if (!indices) { indices = new Uint16Array(count); for (let i = 0; i < count; i++) indices[i] = i; }

    // Embedded baseColor image → a Blob we can hand to createImageBitmap later.
    let image = null;
    const texIndex = prim.material != null ? json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture?.index : null;
    const imgIndex = texIndex != null ? json.textures?.[texIndex]?.source : (json.images?.length ? 0 : null);
    if (imgIndex != null && json.images?.[imgIndex]?.bufferView != null) {
        const im = json.images[imgIndex], bv = json.bufferViews[im.bufferView];
        const start = bin.byteOffset + (bv.byteOffset || 0);
        image = new Blob([new Uint8Array(arrayBuffer, start, bv.byteLength)], {type: im.mimeType || 'image/png'});
    }
    return {positions, normals, uvs, indices, image, count};
}
function readerFor(TA) {
    if (TA === Float32Array) return (dv, o) => dv.getFloat32(o, true);
    if (TA === Uint16Array) return (dv, o) => dv.getUint16(o, true);
    if (TA === Uint32Array) return (dv, o) => dv.getUint32(o, true);
    if (TA === Int16Array) return (dv, o) => dv.getInt16(o, true);
    if (TA === Uint8Array) return (dv, o) => dv.getUint8(o);
    if (TA === Int8Array) return (dv, o) => dv.getInt8(o);
    return (dv, o) => dv.getFloat32(o, true);
}

// Centre the mesh on its figure centre and scale so the bounding radius is 1, keeping real
// proportions (so Phobos stays lumpy and Ganymede stays round). Recomputes normals if absent.
function normalizeMesh(glb) {
    const p = glb.positions, n = p.length / 3;
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < n; i++) {
        const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2;
    let rmax = 1e-6;
    for (let i = 0; i < n; i++) { const x = p[i * 3] - cx, y = p[i * 3 + 1] - cy, z = p[i * 3 + 2] - cz; rmax = Math.max(rmax, Math.hypot(x, y, z)); }
    const positions = new Float32Array(p.length);
    for (let i = 0; i < n; i++) { positions[i * 3] = (p[i * 3] - cx) / rmax; positions[i * 3 + 1] = (p[i * 3 + 1] - cy) / rmax; positions[i * 3 + 2] = (p[i * 3 + 2] - cz) / rmax; }
    const normals = glb.normals ? glb.normals : computeNormals(positions, glb.indices);
    return {positions, normals, uvs: glb.uvs, indices: glb.indices, count: n};
}
function computeNormals(pos, idx) {
    const nrm = new Float32Array(pos.length);
    for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const o of [a, b, c]) { nrm[o] += nx; nrm[o + 1] += ny; nrm[o + 2] += nz; }
    }
    for (let i = 0; i < nrm.length; i += 3) { const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1; nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l; }
    return nrm;
}

// ============================================================================
// Direction frame + radius grid — turns the mesh into a lon/lat -> surface map.
// ============================================================================

// Build an orthonormal frame about a chosen north/spin axis with a calibratable longitude origin.
function frameFor(northAxis, lon0, lonDir) {
    const P = {x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1]}[northAxis] || [0, 1, 0];
    // A = meridian reference (lon 0), B = lon +90, both perpendicular to P.
    let A = Math.abs(P[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
    A = norm(cross(cross(P, A), P));     // project A into the equatorial plane
    const B = norm(cross(P, A));
    const l0 = lon0 * Math.PI / 180;
    return {
        P, A, B, lonDir,
        dir(lonDeg, latDeg) {
            const lon = lonDeg * Math.PI / 180 * lonDir + l0, lat = latDeg * Math.PI / 180;
            const cl = Math.cos(lat), e0 = Math.cos(lon), e1 = Math.sin(lon);
            return norm([
                cl * (e0 * A[0] + e1 * B[0]) + Math.sin(lat) * P[0],
                cl * (e0 * A[1] + e1 * B[1]) + Math.sin(lat) * P[1],
                cl * (e0 * A[2] + e1 * B[2]) + Math.sin(lat) * P[2],
            ]);
        },
        lonlat(u) {   // unit vector -> [lonDeg, latDeg], inverse of dir()
            const lat = Math.asin(clamp(dot(u, this.P), -1, 1));
            const lon = Math.atan2(dot(u, this.B), dot(u, this.A));
            return [((lon - l0) / lonDir) * 180 / Math.PI, lat * 180 / Math.PI];
        },
    };
}

// A coarse (lat x lon) grid of surface radius sampled from the mesh vertices, so a lon/lat can be
// draped onto the real lumpy surface. Empty cells (none in these dense models) are hole-filled.
function buildRadiusGrid(positions, frame, gh = 60, gw = 120) {
    const sum = new Float64Array(gh * gw), cnt = new Uint32Array(gh * gw);
    const n = positions.length / 3;
    for (let i = 0; i < n; i++) {
        const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
        const r = Math.hypot(x, y, z); if (r < 1e-6) continue;
        const [lon, lat] = frame.lonlat([x / r, y / r, z / r]);
        const gi = clamp(Math.floor((90 - lat) / 180 * gh), 0, gh - 1);
        const gj = ((Math.floor((lon + 180) / 360 * gw) % gw) + gw) % gw;
        const k = gi * gw + gj; sum[k] += r; cnt[k]++;
    }
    const grid = new Float32Array(gh * gw);
    for (let k = 0; k < grid.length; k++) grid[k] = cnt[k] ? sum[k] / cnt[k] : -1;
    // Fill any empty cells from neighbours (a few relaxation passes; wraps in longitude).
    for (let pass = 0; pass < 4; pass++) {
        let holes = 0;
        for (let i = 0; i < gh; i++) for (let j = 0; j < gw; j++) {
            if (grid[i * gw + j] >= 0) continue;
            let s = 0, c = 0;
            for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                const ii = clamp(i + di, 0, gh - 1), jj = ((j + dj) % gw + gw) % gw, v = grid[ii * gw + jj];
                if (v >= 0) { s += v; c++; }
            }
            if (c) grid[i * gw + j] = s / c; else holes++;
        }
        if (!holes) break;
    }
    for (let k = 0; k < grid.length; k++) if (grid[k] < 0) grid[k] = 1;   // last resort
    return {grid, gh, gw};
}
function sampleRadius({grid, gh, gw}, frame, unitDir) {
    const [lon, lat] = frame.lonlat(unitDir);
    const fi = clamp((90 - lat) / 180 * gh - 0.5, 0, gh - 1), fj = ((lon + 180) / 360 * gw - 0.5 + gw) % gw;
    const i0 = Math.floor(fi), j0 = Math.floor(fj), ti = fi - i0, tj = fj - j0;
    const i1 = Math.min(i0 + 1, gh - 1), j1 = (j0 + 1) % gw;
    const a = grid[i0 * gw + j0], b = grid[i0 * gw + j1], c = grid[i1 * gw + j0], d = grid[i1 * gw + j1];
    return (a * (1 - tj) + b * tj) * (1 - ti) + (c * (1 - tj) + d * tj) * ti;
}

// ============================================================================
// WebGL helpers + tiny 4x4 matrix maths (column-major, like WebGL expects).
// ============================================================================

const VERT_SURFACE = `
attribute vec3 a_pos; attribute vec3 a_norm; attribute vec2 a_uv;
uniform mat4 u_mvp; uniform mat4 u_model;
varying vec3 v_norm; varying vec2 v_uv;
void main() { v_uv = a_uv; v_norm = mat3(u_model) * a_norm; gl_Position = u_mvp * vec4(a_pos, 1.0); }`;
const FRAG_SURFACE = `
precision highp float;
uniform sampler2D u_tex; uniform vec3 u_light; uniform float u_ambient;
varying vec3 v_norm; varying vec2 v_uv;
void main() {
  vec3 n = normalize(v_norm);
  float lambert = max(dot(n, normalize(u_light)), 0.0);
  float shade = u_ambient + (1.0 - u_ambient) * lambert;
  vec3 base = texture2D(u_tex, v_uv).rgb;
  gl_FragColor = vec4(base * shade, 1.0);
}`;
const VERT_LINE = `
attribute vec3 a_pos; uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); }`;
const FRAG_LINE = `
precision mediump float; uniform vec4 u_color;
void main() { gl_FragColor = u_color; }`;

// Star point sprites: per-vertex colour + pixel size, soft round falloff, additive-blended for glow.
const VERT_STAR = `
attribute vec3 a_pos; attribute vec3 a_col; attribute float a_size;
uniform mat4 u_mvp; varying vec3 v_col;
void main() { v_col = a_col; gl_Position = u_mvp * vec4(a_pos, 1.0); gl_PointSize = a_size; }`;
const FRAG_STAR = `
precision mediump float; uniform float u_alpha; varying vec3 v_col;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  float a = smoothstep(0.5, 0.0, d) * u_alpha;
  gl_FragColor = vec4(v_col, a);
}`;

// Parent planet: a unit sphere, Sun-lit with a soft terminator. a_pos doubles as the world-space
// normal (the model matrix is translate + uniform scale only), and its local y is latitude for bands.
const VERT_PLANET = `
attribute vec3 a_pos; uniform mat4 u_mvp;
varying vec3 v_n; varying vec3 v_l;
void main() { v_n = a_pos; v_l = a_pos; gl_Position = u_mvp * vec4(a_pos, 1.0); }`;
const FRAG_PLANET = `
precision highp float;
uniform vec3 u_color; uniform vec3 u_sun; uniform float u_bands; uniform float u_hasTex; uniform sampler2D u_tex;
varying vec3 v_n; varying vec3 v_l;
const float PI = 3.141592653589793;
void main() {
  vec3 n = normalize(v_n);
  float lambert = max(dot(n, normalize(u_sun)), 0.0);
  float shade = 0.08 + 0.92 * lambert;              // faint ambient so the night side reads as a dim disc, not a void
  vec3 col;
  if (u_hasTex > 0.5) {                              // real equirectangular surface map
    float u = atan(n.z, n.x) / (2.0 * PI) + 0.5;
    float v = acos(clamp(n.y, -1.0, 1.0)) / PI;      // 0 at north pole, 1 at south
    col = texture2D(u_tex, vec2(u, v)).rgb;
  } else {
    col = u_color;
    if (u_bands > 0.5) {                             // gas-giant belts + a warm equatorial band
      col *= 0.86 + 0.14 * sin(v_l.y * 16.0);
      col = mix(col, vec3(0.72, 0.47, 0.34), 0.22 * smoothstep(0.16, 0.0, abs(v_l.y + 0.06)));
    }
  }
  gl_FragColor = vec4(col * shade, 1.0);
}`;

function makeProgram(gl, vsrc, fsrc) {
    const vs = compile(gl, gl.VERTEX_SHADER, vsrc), fs = compile(gl, gl.FRAGMENT_SHADER, fsrc);
    const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('shader link failed: ' + gl.getProgramInfoLog(p));
    return p;
}
function compile(gl, type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader compile failed: ' + gl.getShaderInfoLog(s));
    return s;
}
function attribsUniforms(gl, prog, attrs, unis) {
    const out = {};
    for (const a of attrs) out[a] = gl.getAttribLocation(prog, a);
    for (const u of unis) out[u] = gl.getUniformLocation(prog, u);
    return out;
}
function buffer(gl, data) { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; }
function indexBuffer(gl, data) { const b = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; }
function bindAttrib(gl, buf, loc, size) { if (loc < 0) return; gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); }

// A unit UV sphere (positions double as normals). Used for the parent planet in a moon's sky.
function buildUVSphere(rows = 48, cols = 96) {
    const pos = [], idx = [], w = cols + 1;
    for (let i = 0; i <= rows; i++) {
        const theta = i / rows * Math.PI, st = Math.sin(theta), ct = Math.cos(theta);
        for (let j = 0; j <= cols; j++) {
            const phi = j / cols * 2 * Math.PI;
            pos.push(st * Math.cos(phi), ct, st * Math.sin(phi));
        }
    }
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
        const a = i * w + j, b = a + 1, c = a + w, d = c + 1;
        idx.push(a, c, b, b, c, d);
    }
    return {positions: new Float32Array(pos), indices: new Uint16Array(idx)};
}
// Column-major model matrix: uniform scale s then translate to centre c.
function modelTS(c, s) { return new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, c[0], c[1], c[2], 1]); }

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function lookAt(eye, center, up) {
    const z = norm([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
    const x = norm(cross(up, z)), y = cross(z, x);
    return new Float32Array([
        x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
        -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
    ]);
}
function mul(a, b) {   // a*b, both column-major
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
    }
    return o;
}
function mulVec(m, v) {
    return [
        m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
        m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
    ];
}
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])); }
// Strip the translation from a view matrix → an infinity skybox (stars rotate with the view, never shift).
function rotationOnly(view) { const o = Float32Array.from(view); o[12] = 0; o[13] = 0; o[14] = 0; return o; }
function hexRgb(hex) { const n = parseInt((hex || '#ffffff').slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
function toRgb(color, fallback) { return Array.isArray(color) ? color : typeof color === 'string' ? hexRgb(color) : fallback; }
