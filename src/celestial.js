// Celestial mechanics for Rendered Data Maps. Pure, dependency-free, and unit-testable in Node.
//
// Frame policy (the important thing for a science tool): everything is expressed in the ICRF,
// which is J2000 equatorial to within milliarcseconds. The star catalogue is J2000. Each body
// is oriented with its IAU rotational elements (pole + prime meridian) at the requested time,
// which are themselves defined in the ICRF, so star-vs-body geometry is exact in this one frame.
// Sun, Moon and planets are computed in J2000-referred frames and returned as J2000 RA/Dec.
//
// Neglected (all below the size of a rendered dot): stellar proper motion, nutation (~17"),
// annual aberration (~20"), diurnal parallax, and light-time for the outer planets. Documented
// precision is in README/handoff.

const DEG = Math.PI / 180, ARCSEC = DEG / 3600;
const rad = (d) => d * DEG, deg = (r) => r / DEG;
const norm360 = (x) => ((x % 360) + 360) % 360;
const clamp1 = (x) => Math.max(-1, Math.min(1, x));

export const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    unit: (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }
};
const rotX = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]; };
const rotZ = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]; };

// IAU rotational elements (pole RA a0, pole Dec d0, prime-meridian angle W), in degrees, with the
// usual secular terms (d = days since J2000, T = Julian centuries). One source of truth shared by the
// globe sky (src/starfield.js) and the mesh sky (src/shapemodel.js). Small periodic/nutation terms are
// dropped: they move the pole by <0.01 deg and shift W only, which does not matter for a naked-eye sky.
export function iauElements(body, d, T) {
    if (body === 'moon') return {a0: 269.9949 + 0.0031 * T, d0: 66.5392 + 0.0130 * T, W: 38.3213 + 13.17635815 * d - 1.4e-12 * d * d};
    if (body === 'mars') return {a0: 317.68143 - 0.1061 * T, d0: 52.88650 - 0.0609 * T, W: 176.630 + 350.89198226 * d};
    if (body === 'ganymede') return {a0: 268.20 - 0.009 * T, d0: 64.51 + 0.003 * T, W: 44.064 + 50.3176081 * d};
    if (body === 'phobos') return {a0: 317.68 - 0.108 * T, d0: 52.90 - 0.061 * T, W: 35.06 + 1128.8445850 * d};
    return {a0: 0.00 - 0.641 * T, d0: 90.00 - 0.557 * T, W: 190.147 + 360.9856235 * d};   // Earth
}
// Map a J2000 celestial unit vector into the body-fixed frame (z = body north pole, x = prime meridian).
export function celestialToBody(cel, el) {
    let v = rotZ(cel, -rad(el.a0 + 90));
    v = rotX(v, -rad(90 - el.d0));
    v = rotZ(v, -rad(el.W));
    return v;
}

// ---- time -------------------------------------------------------------------
export function julian(date) {
    const jd = date.getTime() / 86400000 + 2440587.5;
    const d = jd - 2451545.0;              // days since J2000.0 TT (UTC approx; <1s matters nowhere here)
    return {jd, d, T: d / 36525};
}
// Greenwich Mean Sidereal Time in degrees (IAU 1982).
export function gmst(date) {
    const {d, T} = julian(date);
    return norm360(280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - (T * T * T) / 38710000);
}
// Mean obliquity of the ecliptic (deg), Laskar 1986.
export function obliquity(T) {
    const t = T;
    return 23.439291111 - 0.0130041667 * t - 1.638889e-7 * t * t + 5.036111e-7 * t * t * t;
}
export const eqToVec = (raDeg, decDeg) => { const r = rad(raDeg), d = rad(decDeg); return [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)]; };
export const vecToEq = (v) => { const u = V.unit(v); return {ra: norm360(deg(Math.atan2(u[1], u[0]))), dec: deg(Math.asin(clamp1(u[2])))}; };

// Star position at an epoch given its J2000 position and proper motion. pmRA is the on-sky rate
// (mas/yr, already including cos dec); pmDec is mas/yr. Applied as a tangential displacement on
// the unit sphere, so it is stable at the poles. Returns a J2000-frame unit vector (proper motion
// is a real displacement, not a frame change).
const MAS = Math.PI / 180 / 3600 / 1000;
export function starVecAtEpoch(raDeg, decDeg, pmRA, pmDec, years) {
    const r = eqToVec(raDeg, decDeg);
    if (!years || (!pmRA && !pmDec)) return r;
    const ra = rad(raDeg), dec = rad(decDeg);
    const east = [-Math.sin(ra), Math.cos(ra), 0];
    const north = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)];
    const dA = pmRA * MAS * years, dD = pmDec * MAS * years;
    return V.unit([r[0] + dA * east[0] + dD * north[0], r[1] + dA * east[1] + dD * north[1], r[2] + dA * east[2] + dD * north[2]]);
}
// Years since J2000.0 for a date (for proper motion).
export const yearsSinceJ2000 = (date) => julian(date).d / 365.25;

// ---- precession (IAU 1976, Lieske) ------------------------------------------
// Rotation of a J2000 equatorial vector into the mean equator/equinox of date.
export function precessToDate(v, T) {
    const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * ARCSEC;
    const ze = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * ARCSEC;
    const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * ARCSEC;
    return rotZ(rotX(rotZ(v, -ze), th), -z);
}
// Inverse: mean equator of date back to J2000.
export function precessToJ2000(v, T) {
    const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * ARCSEC;
    const ze = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * ARCSEC;
    const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * ARCSEC;
    return rotZ(rotX(rotZ(v, z), -th), ze);
}

// ---- frame transforms -------------------------------------------------------
// Ecliptic (lon,lat deg) of a given obliquity -> equatorial unit vector of the same date.
export function eclToEq(lonDeg, latDeg, epsDeg) {
    const l = rad(lonDeg), b = rad(latDeg), e = rad(epsDeg);
    const x = Math.cos(b) * Math.cos(l);
    const y = Math.cos(b) * Math.sin(l);
    const z = Math.sin(b);
    return [x, y * Math.cos(e) - z * Math.sin(e), y * Math.sin(e) + z * Math.cos(e)];
}
// Galactic -> ICRS (J2000 equatorial) via the standard constant rotation matrix (ESA/Hipparcos).
// Columns are the equatorial directions of the galactic x/y/z axes; galactic centre -> RA 266.4, Dec -28.9.
const GAL_M = [
    [-0.0548755604, 0.4941094279, -0.8676661490],
    [-0.8734370902, -0.4448296300, -0.1980763734],
    [-0.4838350155, 0.7469822445, 0.4559837762]
];
export function galToEqVec(lDeg, bDeg) {
    const l = rad(lDeg), b = rad(bDeg);
    const g = [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];
    return [V.dot(GAL_M[0], g), V.dot(GAL_M[1], g), V.dot(GAL_M[2], g)];
}

// ---- Sun (Meeus ch.25, apparent, of date) -----------------------------------
export function sunOfDate(date) {
    const {T} = julian(date);
    const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
    const M = rad(norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T));
    const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
        + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
    const trueLon = L0 + C;                 // ecliptic longitude of date
    const eps = obliquity(T);
    const v = eclToEq(trueLon, 0, eps);
    const {ra, dec} = vecToEq(v);
    return {ra, dec, lon: norm360(trueLon), eps, anomaly: deg(M) + C, ecc: e, T};
}
// Subsolar point on Earth (deg): where the Sun is overhead now. Drives the day/night terminator.
export function subsolarPoint(date) {
    const s = sunOfDate(date);
    const lng = norm360(s.ra - gmst(date));
    return {lat: s.dec, lng: lng > 180 ? lng - 360 : lng};
}

// ---- Moon (Meeus ch.47, abridged main terms; ~0.3 deg) ----------------------
export function moonOfDate(date) {
    const {T} = julian(date);
    const Lp = rad(norm360(218.3164477 + 481267.88123421 * T));          // mean longitude
    const D = rad(norm360(297.8501921 + 445267.1114034 * T));            // mean elongation
    const M = rad(norm360(357.5291092 + 35999.0502909 * T));            // Sun anomaly
    const Mp = rad(norm360(134.9633964 + 477198.8675055 * T));          // Moon anomaly
    const F = rad(norm360(93.2720950 + 483202.0175233 * T));            // argument of latitude
    const lon = deg(Lp) + (6.289 * Math.sin(Mp) + 1.274 * Math.sin(2 * D - Mp) + 0.658 * Math.sin(2 * D)
        + 0.214 * Math.sin(2 * Mp) - 0.186 * Math.sin(M) - 0.114 * Math.sin(2 * F)
        + 0.059 * Math.sin(2 * D - 2 * Mp) + 0.057 * Math.sin(2 * D - M - Mp)
        + 0.053 * Math.sin(2 * D + Mp) + 0.046 * Math.sin(2 * D - M) - 0.041 * Math.sin(M - Mp));
    const lat = 5.128 * Math.sin(F) + 0.281 * Math.sin(Mp + F) + 0.278 * Math.sin(Mp - F)
        + 0.173 * Math.sin(2 * D - F) + 0.055 * Math.sin(2 * D - Mp + F) + 0.046 * Math.sin(2 * D - Mp - F)
        + 0.033 * Math.sin(2 * D + F) + 0.017 * Math.sin(2 * Mp + F);
    const eps = obliquity(T);
    const vDate = eclToEq(norm360(lon), lat, eps);
    const vJ = precessToJ2000(vDate, T);
    const {ra, dec} = vecToEq(vJ);
    // Illuminated fraction from Sun-Moon elongation.
    const sun = sunOfDate(date);
    const elong = Math.acos(clamp1(Math.cos(rad(lat)) * Math.cos(rad(norm360(lon) - sun.lon))));
    const illum = (1 - Math.cos(elong)) / 2;
    return {ra, dec, illum, phaseAngle: deg(elong)};
}

// ---- Planets (Standish/JPL Keplerian elements, J2000 ecliptic) --------------
const PLANETS = {
    Mercury: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593, 0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081, '#b7b09c', -0.4],
    Venus:   [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255, 0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418, '#fff4d6', -4.4],
    Earth:   [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0, 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0, '#8ab4ff', 0],
    Mars:    [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343, '#ff6b4a', -1.5],
    Jupiter: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106, '#e3c08d', -2.2],
    Saturn:  [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794, '#e8d9a0', 0.5]
};
function helioEcl(p, T) {
    const a = p[0] + p[6] * T, e = p[1] + p[7] * T, I = rad(p[2] + p[8] * T);
    const L = p[3] + p[9] * T, w = p[4] + p[10] * T, O = rad(p[5] + p[11] * T);
    const argPeri = rad(w - (p[5] + p[11] * T));       // argument of perihelion = varpi - node
    let M = rad(((L - w + 180) % 360) - 180);
    let E = M + e * Math.sin(M);
    for (let i = 0; i < 8; i++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const xo = a * (Math.cos(E) - e), yo = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cw = Math.cos(argPeri), sw = Math.sin(argPeri), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
    return [
        (cw * cO - sw * sO * cI) * xo + (-sw * cO - cw * sO * cI) * yo,
        (cw * sO + sw * cO * cI) * xo + (-sw * sO + cw * cO * cI) * yo,
        (sw * sI) * xo + (cw * sI) * yo
    ];
}
// Geocentric J2000 RA/Dec of a planet. Earth heliocentric comes from the same element set.
export function planetOfDate(name, date) {
    const {T} = julian(date);
    const eps0 = rad(23.43928);
    const earth = helioEcl(PLANETS.Earth, T);
    const pl = helioEcl(PLANETS[name], T);
    const g = V.sub(pl, earth);                         // geocentric ecliptic J2000 (AU)
    const eq = [g[0], g[1] * Math.cos(eps0) - g[2] * Math.sin(eps0), g[1] * Math.sin(eps0) + g[2] * Math.cos(eps0)];
    const {ra, dec} = vecToEq(eq);
    return {ra, dec, dist: V.len(g), color: PLANETS[name][12], mag: PLANETS[name][13]};
}
export function sunRaDecJ2000(date) {
    const {T} = julian(date);
    const eps0 = rad(23.43928);
    const g = V.scale(helioEcl(PLANETS.Earth, T), -1);  // geocentric Sun = -Earth heliocentric
    const eq = [g[0], g[1] * Math.cos(eps0) - g[2] * Math.sin(eps0), g[1] * Math.sin(eps0) + g[2] * Math.cos(eps0)];
    return vecToEq(eq);
}
export const PLANET_NAMES = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];

// Heliocentric ecliptic J2000 position (AU) of the body the viewer is standing on. Earth and Mars
// come from the Keplerian table; the Moon is Earth's position plus the small geocentric offset, so
// that Earth is correctly placed in the Moon's sky.
function observerHelio(observer, date, T) {
    if (observer === 'mars' || observer === 'phobos') return helioEcl(PLANETS.Mars, T);      // Phobos ~ Mars
    if (observer === 'ganymede') return helioEcl(PLANETS.Jupiter, T);                         // Ganymede ~ Jupiter
    const earth = helioEcl(PLANETS.Earth, T);
    if (observer === 'moon') {
        const m = moonOfDate(date), eps0 = rad(23.43928), eq = eqToVec(m.ra, m.dec);
        const ecl = [eq[0], eq[1] * Math.cos(eps0) + eq[2] * Math.sin(eps0), -eq[1] * Math.sin(eps0) + eq[2] * Math.cos(eps0)];
        return V.add(earth, V.scale(ecl, 0.00257));     // ~384,400 km in AU
    }
    return earth;
}

// Every Sun / planet / moon in the sky as seen FROM the given body, in J2000 RA/Dec. The body you
// are standing on is omitted (you cannot see it), and Earth appears when you are elsewhere. This is
// what makes the Mars sky show Earth and the Sun-from-Mars, not Mars itself.
export function skyBodies(observer, date) {
    const {T} = julian(date), eps0 = rad(23.43928), obs = observerHelio(observer, date, T);
    const eqFrom = (helio) => {
        const g = V.sub(helio, obs);
        const eq = [g[0], g[1] * Math.cos(eps0) - g[2] * Math.sin(eps0), g[1] * Math.sin(eps0) + g[2] * Math.cos(eps0)];
        return {...vecToEq(eq), dist: V.len(g)};
    };
    const out = [];
    const sun = eqFrom([0, 0, 0]);                        // the Sun sits at the heliocentric origin
    out.push({name: 'Sun', kind: 'sun', ra: sun.ra, dec: sun.dec, color: '#fff4d6', mag: -26});
    const parent = {phobos: 'mars', ganymede: 'jupiter'}[observer];   // a moon can't see its own primary (zero distance)
    for (const n of ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn']) {
        if (n.toLowerCase() === observer || n.toLowerCase() === parent) continue;
        const p = eqFrom(helioEcl(PLANETS[n], T));
        out.push({name: n, kind: 'planet', ra: p.ra, dec: p.dec, color: PLANETS[n][12], mag: n === 'Earth' ? -3.0 : PLANETS[n][13]});
    }
    if (observer === 'earth') {                           // only Earth's own sky shows Earth's Moon
        const m = moonOfDate(date);
        out.push({name: 'Moon', kind: 'moon', ra: m.ra, dec: m.dec, color: '#dce0e6', mag: -10, illum: m.illum});
    }
    return out;
}

// Direction to the Sun as seen from a body, as a J2000 equatorial unit vector. Drives the
// day/night terminator. Earth and Moon use the geocentric Sun direction (the Moon is ~Earth to
// the precision of a terminator); Mars uses the true Sun direction from Mars.
export function sunDirForBody(body, date) {
    const {T} = julian(date);
    const eps0 = rad(23.43928);
    // A body orbiting a planet shares that planet's Sun direction to terminator precision; a moon's
    // own orbital offset is tiny next to the planet-Sun distance.
    const primary = {mars: 'Mars', phobos: 'Mars', ganymede: 'Jupiter'}[body];
    if (primary) {
        const dir = V.scale(helioEcl(PLANETS[primary], T), -1);   // primary -> Sun in J2000 ecliptic
        return V.unit([dir[0], dir[1] * Math.cos(eps0) - dir[2] * Math.sin(eps0), dir[1] * Math.sin(eps0) + dir[2] * Math.cos(eps0)]);
    }
    const s = sunRaDecJ2000(date);
    return eqToVec(s.ra, s.dec);
}

// ---- star colour from B-V (Ballesteros 2012 approximation) ------------------
export function colorFromBV(bv) {
    const b = Math.max(-0.4, Math.min(2.0, bv));
    const t = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));   // effective temperature (K)
    return kelvinToRGB(t);
}
function kelvinToRGB(k) {
    const t = k / 100; let r, g, b;
    if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; }
    else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); }
    if (t <= 19) b = 0; else if (t >= 66) b = 255; else b = 138.52 * Math.log(t - 10) - 305.04;
    const cl = (x) => Math.max(0, Math.min(255, Math.round(x)));
    return [cl(r), cl(g), cl(b)];
}

// ---- bright-star catalogue: [RA(deg,J2000), Dec, mag, B-V, name] ------------
export const STARS = [
    [101.287, -16.716, -1.46, 0.00, 'Sirius'], [95.988, -52.696, -0.74, 0.15, 'Canopus'],
    [219.902, -60.834, -0.27, 0.71, 'Rigil Kent.'], [213.915, 19.182, -0.05, 1.23, 'Arcturus'],
    [279.234, 38.784, 0.03, 0.00, 'Vega'], [79.172, 45.998, 0.08, 0.80, 'Capella'],
    [78.634, -8.202, 0.13, -0.03, 'Rigel'], [114.825, 5.225, 0.34, 0.42, 'Procyon'],
    [88.793, 7.407, 0.50, 1.85, 'Betelgeuse'], [24.429, -57.237, 0.46, -0.16, 'Achernar'],
    [210.956, -60.373, 0.61, -0.23, 'Hadar'], [297.696, 8.868, 0.76, 0.22, 'Altair'],
    [186.650, -63.099, 0.77, -0.24, 'Acrux'], [68.980, 16.509, 0.85, 1.54, 'Aldebaran'],
    [247.352, -26.432, 1.06, 1.83, 'Antares'], [201.298, -11.161, 0.98, -0.23, 'Spica'],
    [116.329, 28.026, 1.14, 1.00, 'Pollux'], [344.413, -29.622, 1.16, 0.09, 'Fomalhaut'],
    [310.358, 45.280, 1.25, 0.09, 'Deneb'], [191.930, -59.689, 1.25, -0.24, 'Mimosa'],
    [152.093, 11.967, 1.35, -0.11, 'Regulus'], [104.656, -28.972, 1.50, -0.21, 'Adhara'],
    [113.650, 31.888, 1.58, 0.03, 'Castor'], [187.791, -57.113, 1.63, 1.59, 'Gacrux'],
    [81.283, 6.350, 1.64, -0.22, 'Bellatrix'], [81.573, 28.608, 1.65, -0.13, 'Elnath'],
    [138.300, -69.717, 1.68, 0.07, 'Miaplacidus'], [84.053, -1.202, 1.69, -0.18, 'Alnilam'],
    [85.190, -1.943, 1.74, -0.21, 'Alnitak'], [193.507, 55.960, 1.76, -0.02, 'Alioth'],
    [165.932, 61.751, 1.79, 1.07, 'Dubhe'], [83.002, -0.299, 2.25, -0.22, 'Mintaka'],
    [206.885, 49.313, 1.86, -0.10, 'Alkaid'], [37.955, 89.264, 1.98, 0.60, 'Polaris'],
    [10.127, 56.537, 2.24, 1.17, 'Schedar'], [2.295, 59.150, 2.28, 0.34, 'Caph'],
    [14.177, 60.717, 2.15, -0.05, 'Gamma Cas'], [165.460, 56.383, 2.37, 0.03, 'Merak'],
    [178.458, 53.695, 2.44, 0.04, 'Phecda'], [183.857, 57.033, 3.31, 0.08, 'Megrez'],
    [200.981, 54.926, 2.23, 0.06, 'Mizar'], [141.897, -8.659, 1.98, 1.44, 'Alphard'],
    [31.793, 23.463, 2.00, 1.15, 'Hamal'], [10.897, -17.987, 2.04, 1.02, 'Diphda'],
    [177.265, 14.572, 2.11, 0.09, 'Denebola'], [51.081, 49.861, 1.79, 0.48, 'Mirfak'],
    [332.058, -46.961, 1.74, -0.07, 'Alnair'], [306.412, -56.735, 1.94, -0.12, 'Peacock'],
    [283.816, -26.297, 2.05, -0.13, 'Nunki'], [89.882, 44.947, 1.90, 0.08, 'Menkalinan'],
    [252.166, -69.028, 1.91, 1.45, 'Atria'], [125.628, -59.510, 1.86, 1.28, 'Avior'],
    [139.273, -59.275, 2.21, 0.19, 'Aspidiske'], [264.330, -42.998, 1.86, 0.41, 'Sargas'],
    [263.402, -37.104, 1.62, -0.22, 'Shaula'], [276.043, -34.385, 1.85, -0.03, 'Kaus Aust.'],
    [107.098, -26.393, 1.83, 0.68, 'Wezen'], [95.674, -17.956, 1.98, -0.24, 'Mirzam'],
    [168.527, 20.524, 2.56, 0.13, 'Zosma'], [222.720, -47.388, 2.06, -0.22, 'Menkent']
];
const idx = (name) => STARS.findIndex((s) => s[4] === name);
// Constellation stick figures (name pairs resolved to catalogue indices).
const LINE_DEFS = {
    Orion: [['Betelgeuse', 'Alnilam'], ['Alnilam', 'Rigel'], ['Alnitak', 'Alnilam'], ['Alnilam', 'Mintaka'], ['Bellatrix', 'Betelgeuse'], ['Bellatrix', 'Mintaka'], ['Alnitak', 'Betelgeuse'], ['Mintaka', 'Rigel']],
    'Ursa Major': [['Dubhe', 'Merak'], ['Merak', 'Phecda'], ['Phecda', 'Megrez'], ['Megrez', 'Dubhe'], ['Megrez', 'Alioth'], ['Alioth', 'Mizar'], ['Mizar', 'Alkaid']],
    Cassiopeia: [['Caph', 'Schedar'], ['Schedar', 'Gamma Cas']],
    Crux: [['Acrux', 'Gacrux'], ['Mimosa', 'Menkent']],
    'Canis Major': [['Sirius', 'Mirzam'], ['Sirius', 'Adhara'], ['Adhara', 'Wezen'], ['Wezen', 'Sirius']]
};
export const CONSTELLATIONS = Object.entries(LINE_DEFS).map(([name, segs]) => ({
    name,
    segments: segs.map(([a, b]) => [idx(a), idx(b)]).filter(([a, b]) => a >= 0 && b >= 0),
    label: (() => { const members = new Set(segs.flat()); let r = 0, d = 0, n = 0;
        for (const m of members) { const i = idx(m); if (i >= 0) { r += STARS[i][0]; d += STARS[i][1]; n++; } }
        return n ? [r / n, d / n] : null; })()
}));

// A few deep-sky objects: [RA, Dec, name].
export const DEEPSKY = [
    [56.75, 24.12, 'Pleiades'], [83.82, -5.39, 'Orion Nebula'], [10.68, 41.27, 'Andromeda Gal.'],
    [201.37, -43.02, 'Omega Cen.'], [250.42, 36.46, 'Hercules Cl.']
];

// Milky Way: points sampled near the galactic plane (correct orientation), with intensity that
// fades with galactic latitude and brightens toward the galactic centre (l~0, Sagittarius). The
// geometry is exact; the intensity profile is a schematic model of the diffuse band.
export function milkyWaySamples(n = 1400, seed = 1) {
    let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const out = [];
    for (let i = 0; i < n; i++) {
        const l = rnd() * 360;
        const sigma = 7 + 9 * Math.exp(-Math.pow(((l + 180) % 360 - 180) / 40, 2));   // wider bulge near centre
        const b = (rnd() + rnd() + rnd() - 1.5) * sigma;                               // ~gaussian latitude
        const bulge = 1 + 1.6 * Math.exp(-Math.pow(((l + 180) % 360 - 180) / 35, 2));
        const intensity = Math.exp(-(b * b) / (2 * sigma * sigma)) * bulge;
        out.push({v: galToEqVec(l, b), i: intensity});
    }
    return out;
}
