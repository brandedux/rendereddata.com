// Shared, dependency-free vector readers used by both renderers (GlobeMap on the globe, ShapeModel on
// a mesh) so "bring your own data" parses the same way on any surface. GeoJSON is JSON; KML and GPX are
// parsed with the browser's own DOMParser. Nothing is uploaded anywhere.

const xmlText = (parent, tag) => { const n = parent.getElementsByTagName(tag)[0]; return n ? n.textContent.trim() : ''; };
const feature = (geometry, name) => ({type: 'Feature', properties: name ? {name} : {}, geometry});

// Read a user file's text as GeoJSON, KML or GPX (by extension or sniffed root tag) → GeoJSON, or null.
export function parseVector(name, text) {
    const lower = (name || '').toLowerCase();
    const head = text.slice(0, 500);
    const asJson = () => { try { return JSON.parse(text); } catch { return null; } };
    if (lower.endsWith('.geojson') || lower.endsWith('.json') || /^\s*[{[]/.test(text)) { const j = asJson(); if (j) return j; }
    if (lower.endsWith('.kml') || /<kml[\s>]/i.test(head)) return kmlToGeoJSON(text);
    if (lower.endsWith('.gpx') || /<gpx[\s>]/i.test(head)) return gpxToGeoJSON(text);
    return asJson();
}

export function kmlToGeoJSON(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const features = [];
    const coords = (el) => {
        const n = el.getElementsByTagName('coordinates')[0];
        if (!n) return [];
        return n.textContent.trim().split(/\s+/)
            .map((t) => { const [a, b] = t.split(',').map(Number); return [a, b]; })
            .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
    };
    for (const pm of doc.getElementsByTagName('Placemark')) {
        const name = xmlText(pm, 'name');
        for (const p of pm.getElementsByTagName('Point')) { const c = coords(p); if (c[0]) features.push(feature({type: 'Point', coordinates: c[0]}, name)); }
        for (const l of pm.getElementsByTagName('LineString')) { const c = coords(l); if (c.length > 1) features.push(feature({type: 'LineString', coordinates: c}, name)); }
        for (const pg of pm.getElementsByTagName('Polygon')) {
            const ob = pg.getElementsByTagName('outerBoundaryIs')[0];
            const ring = coords(ob || pg);
            if (ring.length > 3) features.push(feature({type: 'Polygon', coordinates: [ring]}, name));
        }
    }
    return {type: 'FeatureCollection', features};
}

export function gpxToGeoJSON(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const features = [];
    const ll = (e) => [parseFloat(e.getAttribute('lon')), parseFloat(e.getAttribute('lat'))];
    const good = (c) => Number.isFinite(c[0]) && Number.isFinite(c[1]);
    for (const w of doc.getElementsByTagName('wpt')) { const c = ll(w); if (good(c)) features.push(feature({type: 'Point', coordinates: c}, xmlText(w, 'name'))); }
    for (const trk of doc.getElementsByTagName('trk')) {
        const c = [];
        for (const seg of trk.getElementsByTagName('trkseg')) for (const p of seg.getElementsByTagName('trkpt')) { const c2 = ll(p); if (good(c2)) c.push(c2); }
        if (c.length > 1) features.push(feature({type: 'LineString', coordinates: c}, xmlText(trk, 'name')));
    }
    for (const rte of doc.getElementsByTagName('rte')) {
        const c = [...rte.getElementsByTagName('rtept')].map(ll).filter(good);
        if (c.length > 1) features.push(feature({type: 'LineString', coordinates: c}, xmlText(rte, 'name')));
    }
    return {type: 'FeatureCollection', features};
}

// Bounding box [[w, s], [e, n]] of any GeoJSON, or null if it has no finite coordinates.
export function bounds(geojson) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const walk = (c) => {
        if (typeof c[0] === 'number') {
            const [lng, lat] = c;
            if (Number.isFinite(lng) && Number.isFinite(lat)) {
                if (lng < w) w = lng; if (lng > e) e = lng; if (lat < s) s = lat; if (lat > n) n = lat;
            }
        } else for (const x of c) walk(x);
    };
    const geoms = geojson.type === 'FeatureCollection' ? geojson.features.map((f) => f.geometry)
        : geojson.type === 'Feature' ? [geojson.geometry] : [geojson];
    for (const g of geoms) if (g && g.coordinates) walk(g.coordinates);
    return w <= e && s <= n ? [[w, s], [e, n]] : null;
}
