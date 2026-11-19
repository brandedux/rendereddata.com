// Single source of truth for the shape-model bodies — the irregular moons (Ganymede, Phobos) and the
// Moon rendered on the shape renderer. This config was previously duplicated in both the playground
// (src/poc.js) and the standalone demo (shapes.html); the calibration (northAxis / lon0 / lonDir) and
// feature coordinates must stay identical between them, so they live here and both files import it.
//
// Fields:
//   label, model|(sphere+texture), radiusKm (number = mean radius, [a,b,c] = triaxial)
//   northAxis / lon0 / lonDir  — orientation calibration (verified against real geography)
//   features[{name, lon, lat}] — IAU/USGS feature centres (planetographic)
//   orbitKm / orbitHours       — true-scale orbit of the body around its primary (playground geometry)
//   dist                       — initial camera pull-back (playground)
//   siblings[]                 — co-orbiting moons drawn in the same scene (e.g. Deimos with Phobos)
//   note                       — human-readable blurb (demo copy)
// Consumers read whatever subset they need; extras are harmless when ignored.
export const SHAPE_BODIES = {
    moon: {label: 'Moon', sphere: true, texture: 'data/textures/moon.jpg', radiusKm: 1737.4, northAxis: 'y', lon0: 180, lonDir: 1,
        orbitKm: 384400, orbitHours: 655.720,   // the Moon's orbit around Earth, drawn true-scale (parent = Earth)
        features: [{name: 'Tycho', lon: -11.4, lat: -43.3}, {name: 'Copernicus', lon: -20.1, lat: 9.6},
            {name: 'Mare Imbrium', lon: -16, lat: 33}, {name: 'Apollo 11', lon: 23.5, lat: 0.7}]},
    ganymede: {label: 'Ganymede', model: 'data/models/ganymede.glb', radiusKm: 2634, northAxis: 'y', lon0: 0, lonDir: 1,
        note: "Jupiter's largest moon — big enough to be round, shown here on its real (slightly out-of-round) mesh.",
        orbitKm: 1070400, orbitHours: 171.709,   // Ganymede's orbit around Jupiter (for true-scale geometry)
        // IAU gazetteer centres (planetographic, +West). Convention calibrated against Galileo Regio.
        features: [{name: 'Galileo Regio', lon: 127, lat: 45}, {name: 'Osiris', lon: 166.3, lat: -38}, {name: 'Tros', lon: 27.3, lat: 11}]},
    phobos: {label: 'Phobos', model: 'data/models/phobos.glb', radiusKm: [13.0, 11.4, 9.1], northAxis: 'y', lon0: 0, lonDir: -1,
        note: 'A ~27 km lump of a moon. Stickney crater is nearly half its width — impossible to map on a sphere.',
        dist: 7.5,   // pulled back so Phobos, Mars and Deimos all frame together on load
        orbitKm: 9376, orbitHours: 7.6533,   // Phobos's own orbit around Mars (for sibling-moon geometry)
        siblings: [{name: 'Deimos', model: 'data/models/24879_Deimos_1_1000.glb', radiusKm: 6.2, orbitKm: 23463, orbitHours: 30.312}],
        features: [{name: 'Stickney', lon: 49, lat: 1}, {name: 'Limtoc', lon: 54, lat: -11}, {name: 'Hall', lon: 21, lat: -80},
            {name: 'Roche', lon: 177, lat: 53}, {name: "D'Arrest", lon: 179, lat: -39}]}
};
