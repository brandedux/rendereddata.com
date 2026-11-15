// PMTiles and GeoTIFF, read in the browser with no extra libraries.
//
// Two open raster/vector formats join the "bring your own layer" set:
//
//   PMTiles  a single-file tile archive (vector MVT or raster). Served over HTTP range
//            requests, or straight from a dropped File. We parse the v3 header and its
//            Hilbert-ordered directories, then hand each tile to MapLibre through a
//            `pmtiles://` protocol. Spec: https://github.com/protomaps/PMTiles (BSD-3).
//
//   GeoTIFF  a georeferenced TIFF, including Cloud-Optimized GeoTIFF (COG). We parse the
//            IFDs (classic and BigTIFF), decode the common compressions (none, Deflate,
//            LZW, PackBits), read the GeoKeys for the footprint and CRS, and place the
//            image on the globe as a MapLibre image source. EPSG:4326 and EPSG:3857 are
//            handled directly; other projections need a gdalwarp to one of those first.
//
// The parsing and decoding below are pure and Node-tested (see test at the bottom, run
// with `node src/rasterformats.js --test`). Only the rendering glue touches the browser.

/* ===================================================================== *
 *  Little primitives                                                     *
 * ===================================================================== */

/** Read an unsigned LEB128 varint from bytes at p. Returns [value, nextPos]. */
export function uvarint(bytes, p) {
    let result = 0, shift = 0, b;
    do {
        b = bytes[p++];
        result += (b & 0x7f) * Math.pow(2, shift);   // Math.pow keeps >32-bit ids exact
        shift += 7;
    } while (b & 0x80);
    return [result, p];
}

/* ===================================================================== *
 *  PMTiles v3                                                            *
 * ===================================================================== */

// Tile (z,x,y) -> 64-bit tile id, Hilbert-ordered, matching the PMTiles spec.
export function zxyToTileId(z, x, y) {
    if (z > 31) throw new Error('zoom > 31 unsupported');
    let acc = 0;
    for (let t = 0; t < z; t++) acc += Math.pow(4, t);   // tiles in all lower zooms
    const n = 1 << z;
    let rx, ry, d = 0, xx = x, yy = y;
    for (let s = n >> 1; s > 0; s = s >> 1) {
        rx = (xx & s) > 0 ? 1 : 0;
        ry = (yy & s) > 0 ? 1 : 0;
        d += s * s * ((3 * rx) ^ ry);
        // rotate the quadrant
        if (ry === 0) {
            if (rx === 1) { xx = n - 1 - xx; yy = n - 1 - yy; }
            const tmp = xx; xx = yy; yy = tmp;
        }
    }
    return acc + d;
}

/** Deserialize a PMTiles v3 directory (already decompressed) into sorted entries. */
export function deserializeDirectory(bytes) {
    let p = 0, n;
    [n, p] = uvarint(bytes, 0);
    const entries = new Array(n);
    let lastId = 0;
    for (let i = 0; i < n; i++) { let v; [v, p] = uvarint(bytes, p); lastId += v; entries[i] = {tileId: lastId, offset: 0, length: 0, runLength: 0}; }
    for (let i = 0; i < n; i++) { let v; [v, p] = uvarint(bytes, p); entries[i].runLength = v; }
    for (let i = 0; i < n; i++) { let v; [v, p] = uvarint(bytes, p); entries[i].length = v; }
    for (let i = 0; i < n; i++) {
        let v; [v, p] = uvarint(bytes, p);
        if (v === 0 && i > 0) entries[i].offset = entries[i - 1].offset + entries[i - 1].length;
        else entries[i].offset = v - 1;
    }
    return entries;
}

/** Largest entry whose tileId <= target, or null. Entries are sorted ascending. */
export function findEntry(entries, tileId) {
    let lo = 0, hi = entries.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid].tileId <= tileId) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return ans < 0 ? null : entries[ans];
}

const PM_TILETYPE = {1: 'mvt', 2: 'png', 3: 'jpeg', 4: 'webp', 5: 'avif'};

/** Parse the fixed 127-byte PMTiles v3 header from a Uint8Array (offset 0). */
export function parsePMTilesHeader(bytes) {
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6]);
    if (magic !== 'PMTiles') throw new Error('not a PMTiles archive');
    if (bytes[7] !== 3) throw new Error(`PMTiles spec version ${bytes[7]} unsupported (need 3)`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u64 = (o) => Number(dv.getBigUint64(o, true));
    const i32e7 = (o) => dv.getInt32(o, true) / 1e7;
    return {
        rootOffset: u64(8), rootLength: u64(16),
        metadataOffset: u64(24), metadataLength: u64(32),
        leafOffset: u64(40), leafLength: u64(48),
        tileDataOffset: u64(56), tileDataLength: u64(64),
        internalCompression: bytes[97], tileCompression: bytes[98],
        tileType: PM_TILETYPE[bytes[99]] || 'unknown',
        minZoom: bytes[100], maxZoom: bytes[101],
        minLon: i32e7(102), minLat: i32e7(106), maxLon: i32e7(110), maxLat: i32e7(114),
        centerZoom: bytes[118], centerLon: i32e7(119), centerLat: i32e7(123),
    };
}

/** Decompress per the PMTiles compression enum (1 none, 2 gzip). Browser/Node 18 DecompressionStream. */
async function pmDecompress(bytes, kind) {
    if (kind === 1 || !kind) return bytes;
    if (kind === 2) return gunzip(bytes);
    throw new Error(`PMTiles compression ${kind} unsupported (only none and gzip; re-pack without brotli/zstd)`);
}

async function gunzip(bytes) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Byte source over an HTTP URL. Uses Range; if the server ignores it (200), caches the full body. */
export class RangeSource {
    constructor(url) { this.url = url; this._full = null; }
    async getBytes(offset, length) {
        if (this._full) return this._full.subarray(offset, offset + length);
        const res = await fetch(this.url, {headers: {Range: `bytes=${offset}-${offset + length - 1}`}, cache: 'no-store'});
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} for ${this.url}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (res.status === 206 && buf.length <= length) return buf;    // real partial content
        this._full = buf;                                              // server sent the whole file; keep it
        return buf.subarray(offset, offset + length);
    }
}

/** Byte source over a dropped File/Blob. */
export class BlobSource {
    constructor(blob) { this.blob = blob; }
    async getBytes(offset, length) { return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer()); }
}

export class PMTiles {
    constructor(source) { this.source = source; this._leafCache = new Map(); }
    async header() {
        if (this._header) return this._header;
        const head = await this.source.getBytes(0, 127);
        const h = parsePMTilesHeader(head);
        this._header = h;
        return h;
    }
    async metadata() {
        const h = await this.header();
        if (!h.metadataLength) return {};
        const raw = await this.source.getBytes(h.metadataOffset, h.metadataLength);
        const json = await pmDecompress(raw, h.internalCompression);
        try { return JSON.parse(new TextDecoder().decode(json)); } catch { return {}; }
    }
    async _rootDir() {
        if (this._root) return this._root;
        const h = await this.header();
        const raw = await this.source.getBytes(h.rootOffset, h.rootLength);
        this._root = deserializeDirectory(await pmDecompress(raw, h.internalCompression));
        return this._root;
    }
    async _leafDir(offset, length) {
        const key = `${offset}:${length}`;
        if (this._leafCache.has(key)) return this._leafCache.get(key);
        const h = await this.header();
        const raw = await this.source.getBytes(h.leafOffset + offset, length);
        const dir = deserializeDirectory(await pmDecompress(raw, h.internalCompression));
        if (this._leafCache.size > 64) this._leafCache.delete(this._leafCache.keys().next().value);
        this._leafCache.set(key, dir);
        return dir;
    }
    /** Return the raw (decompressed) tile bytes for z/x/y, or null if absent. */
    async getTile(z, x, y) {
        const h = await this.header();
        const tileId = zxyToTileId(z, x, y);
        let entries = await this._rootDir();
        for (let depth = 0; depth < 4; depth++) {
            const e = findEntry(entries, tileId);
            if (!e) return null;
            if (e.runLength === 0) { entries = await this._leafDir(e.offset, e.length); continue; }
            if (tileId - e.tileId >= e.runLength) return null;
            const raw = await this.source.getBytes(h.tileDataOffset + e.offset, e.length);
            return pmDecompress(raw, h.tileCompression);
        }
        return null;
    }
}

let _pmReg = null;
/** Register the `pmtiles://<id>/{z}/{x}/{y}` protocol once. Returns {add, get, remove}. */
export function registerPMTilesProtocol(maplibregl) {
    if (_pmReg) return _pmReg;
    const archives = new Map();
    maplibregl.addProtocol('pmtiles', async (params) => {
        const m = /^pmtiles:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
        if (!m) throw new Error(`bad pmtiles url: ${params.url}`);
        const arc = archives.get(m[1]);
        if (!arc) throw new Error(`pmtiles archive not registered: ${m[1]}`);
        const data = await arc.getTile(+m[2], +m[3], +m[4]);
        if (!data) return {data: new Uint8Array(0).buffer};   // empty tile
        return {data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)};
    });
    _pmReg = {
        add: (id, source) => { const a = new PMTiles(source); archives.set(id, a); return a; },
        get: (id) => archives.get(id),
        remove: (id) => archives.delete(id),
    };
    return _pmReg;
}

/* ===================================================================== *
 *  GeoTIFF / COG decoders (pure)                                         *
 * ===================================================================== */

/** TIFF LZW (MSB-first, variable 9-12 bit codes, early change). Ported to match libtiff. */
export function lzwDecode(input) {
    const CLEAR = 256, EOI = 257;
    const out = [];
    let bitPos = 0;
    const read = (n) => {
        let v = 0;
        for (let i = 0; i < n; i++) {
            const byteIdx = bitPos >> 3;
            const bit = byteIdx < input.length ? (input[byteIdx] >> (7 - (bitPos & 7))) & 1 : 0;
            v = (v << 1) | bit; bitPos++;
        }
        return v;
    };
    let dict, bitLength, oldCode;
    const initDict = () => {
        dict = new Array(258);
        for (let i = 0; i < 256; i++) dict[i] = [i];
        dict[256] = []; dict[257] = [];
        bitLength = 9; oldCode = null;
    };
    initDict();
    while (bitPos + bitLength <= input.length * 8) {
        const code = read(bitLength);
        if (code === EOI) break;
        if (code === CLEAR) { initDict(); continue; }
        let entry;
        if (oldCode === null) { entry = dict[code]; for (const v of entry) out.push(v); oldCode = code; continue; }
        if (code < dict.length) {
            entry = dict[code];
            for (const v of entry) out.push(v);
            dict.push(dict[oldCode].concat(entry[0]));
        } else {
            entry = dict[oldCode].concat(dict[oldCode][0]);
            for (const v of entry) out.push(v);
            dict.push(entry);
        }
        oldCode = code;
        if (dict.length === 511) bitLength = 10;
        else if (dict.length === 1023) bitLength = 11;
        else if (dict.length === 2047) bitLength = 12;
    }
    return Uint8Array.from(out);
}

/** PackBits (TIFF compression 32773). */
export function packBitsDecode(data) {
    const out = [];
    let i = 0;
    while (i < data.length) {
        let n = data[i++];
        if (n < 128) { for (let j = 0; j <= n; j++) out.push(data[i++]); }
        else if (n > 128) { const b = data[i++]; for (let j = 0; j < 257 - n; j++) out.push(b); }
        // n === 128: no-op
    }
    return Uint8Array.from(out);
}

/** Undo horizontal differencing (predictor 2) in place, per row, per sample. 8 or 16 bit. */
export function undoHorizontalPredictor(samples, width, height, spp, bitsPerSample) {
    if (bitsPerSample !== 8 && bitsPerSample !== 16) throw new Error(`predictor 2 for ${bitsPerSample}-bit unsupported`);
    const mask = bitsPerSample === 8 ? 0xff : 0xffff;
    for (let row = 0; row < height; row++) {
        const base = row * width * spp;
        for (let col = 1; col < width; col++)
            for (let s = 0; s < spp; s++) {
                const idx = base + col * spp + s;
                samples[idx] = (samples[idx] + samples[idx - spp]) & mask;
            }
    }
    return samples;
}

/* ===================================================================== *
 *  GeoTIFF IFD parsing                                                   *
 * ===================================================================== */

const TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8};

/** Parse all IFDs of a (Big)TIFF. Returns {little, big, ifds:[Map tag -> {type,count,values}]}. */
export function parseTIFF(buffer) {
    const dv = new DataView(buffer);
    const bom = dv.getUint16(0, false);
    const little = bom === 0x4949;
    if (!little && bom !== 0x4d4d) throw new Error('not a TIFF (bad byte order mark)');
    const magic = dv.getUint16(2, little);
    const big = magic === 43;
    if (magic !== 42 && magic !== 43) throw new Error('not a TIFF (bad magic)');

    const readOffset = (o) => big ? Number(dv.getBigUint64(o, little)) : dv.getUint32(o, little);
    let ifdOffset = big ? readOffset(8) : readOffset(4);

    const readValues = (type, count, valueOffset, inlineAt) => {
        const size = TYPE_SIZE[type] || 1;
        const bytes = size * count;
        const inlineCap = big ? 8 : 4;
        const at = bytes <= inlineCap ? inlineAt : valueOffset;
        const vals = [];
        for (let i = 0; i < count; i++) {
            const o = at + i * size;
            switch (type) {
                case 1: case 2: case 6: case 7: vals.push(dv.getUint8(o)); break;
                case 3: vals.push(dv.getUint16(o, little)); break;
                case 8: vals.push(dv.getInt16(o, little)); break;
                case 4: case 13: vals.push(dv.getUint32(o, little)); break;
                case 9: vals.push(dv.getInt32(o, little)); break;
                case 11: vals.push(dv.getFloat32(o, little)); break;
                case 12: vals.push(dv.getFloat64(o, little)); break;
                case 5: vals.push(dv.getUint32(o, little) / dv.getUint32(o + 4, little)); break;
                case 10: vals.push(dv.getInt32(o, little) / dv.getInt32(o + 4, little)); break;
                case 16: case 18: vals.push(Number(dv.getBigUint64(o, little))); break;
                case 17: vals.push(Number(dv.getBigInt64(o, little))); break;
                default: vals.push(dv.getUint8(o));
            }
        }
        if (type === 2) return vals;   // ASCII kept as code points; caller joins
        return vals;
    };

    const ifds = [];
    const entrySize = big ? 20 : 12;
    let guard = 0;
    while (ifdOffset && guard++ < 64) {
        const count = big ? Number(dv.getBigUint64(ifdOffset, little)) : dv.getUint16(ifdOffset, little);
        const entriesStart = ifdOffset + (big ? 8 : 2);
        const map = new Map();
        for (let i = 0; i < count; i++) {
            const eo = entriesStart + i * entrySize;
            const tag = dv.getUint16(eo, little);
            const type = dv.getUint16(eo + 2, little);
            const cnt = big ? Number(dv.getBigUint64(eo + 4, little)) : dv.getUint32(eo + 4, little);
            const valueFieldAt = eo + (big ? 12 : 8);
            const valueOffset = big ? Number(dv.getBigUint64(valueFieldAt, little)) : dv.getUint32(valueFieldAt, little);
            const values = readValues(type, cnt, valueOffset, valueFieldAt);
            map.set(tag, {type, count: cnt, values});
        }
        ifds.push(map);
        ifdOffset = readOffset(entriesStart + count * entrySize);
    }
    return {little, big, buffer, ifds};
}

/** Pull the GeoKey directory into a flat {keyId: value} map. */
export function parseGeoKeys(ifd) {
    const dir = ifd.get(34735);
    if (!dir) return {};
    const d = dir.values;
    const doubles = ifd.get(34736)?.values || [];
    const ascii = ifd.get(34737)?.values || [];
    const asciiStr = String.fromCharCode(...ascii);
    const keys = {};
    const n = d[3];
    for (let i = 0; i < n; i++) {
        const o = 4 + i * 4;
        const keyId = d[o], loc = d[o + 1], count = d[o + 2], valueOffset = d[o + 3];
        if (loc === 0) keys[keyId] = valueOffset;                       // value is inline
        else if (loc === 34736) keys[keyId] = doubles[valueOffset];     // double
        else if (loc === 34737) keys[keyId] = asciiStr.substr(valueOffset, count).replace(/\|$/, '');
    }
    return keys;
}

/** EPSG code and a lon/lat corner mapper from an IFD's geo tags. Supports 4326 and 3857. */
export function geoReference(ifd) {
    const keys = parseGeoKeys(ifd);
    const modelType = keys[1024];                 // 1 projected, 2 geographic
    const epsg = keys[3072] || keys[2048] || (modelType === 2 ? 4326 : null);
    const width = ifd.get(256).values[0], height = ifd.get(257).values[0];

    const scale = ifd.get(33550)?.values;         // [sx, sy, sz]
    const tie = ifd.get(33922)?.values;           // [i,j,k, X,Y,Z]
    const mat = ifd.get(34264)?.values;           // 4x4

    const pixelToWorld = (col, row) => {
        if (mat) return [mat[0] * col + mat[1] * row + mat[3], mat[4] * col + mat[5] * row + mat[7]];
        if (scale && tie) return [tie[3] + (col - tie[0]) * scale[0], tie[4] - (row - tie[1]) * scale[1]];
        throw new Error('GeoTIFF has no ModelPixelScale/Tiepoint or ModelTransformation');
    };

    const is3857 = epsg === 3857 || epsg === 900913 || epsg === 3587 || epsg === 102100;
    const is4326 = epsg === 4326 || (!epsg && modelType === 2);
    if (!is3857 && !is4326)
        throw new Error(`GeoTIFF CRS EPSG:${epsg || 'unknown'} is not supported. Reproject to EPSG:4326 or 3857 (gdalwarp -t_srs EPSG:4326 in.tif out.tif).`);

    const R = 6378137, HALF = Math.PI * R;
    const worldToLonLat = ([X, Y]) => is4326
        ? [X, Y]
        : [(X / HALF) * 180, (Math.atan(Math.exp((Y / HALF) * Math.PI)) * 2 - Math.PI / 2) * 180 / Math.PI];

    // corners in MapLibre image order: TL, TR, BR, BL
    const corners = [[0, 0], [width, 0], [width, height], [0, height]]
        .map(([c, r]) => worldToLonLat(pixelToWorld(c, r)));
    return {epsg: epsg || (is4326 ? 4326 : null), crs: is4326 ? 'EPSG:4326' : 'EPSG:3857', width, height, corners};
}

/* ===================================================================== *
 *  GeoTIFF decode to pixels (browser; needs canvas)                      *
 * ===================================================================== */

async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode one IFD's raster into an RGBA ImageData-like {width,height,data:Uint8ClampedArray}. */
export async function decodeImage(tiff, ifd) {
    const g = (tag, d) => (ifd.get(tag)?.values ?? d);
    const width = g(256)[0], height = g(257)[0];
    const spp = g(277, [1])[0];
    const bps = g(258, [8])[0];
    const compression = g(259, [1])[0];
    const photometric = g(262, [bps === 1 ? 0 : 1])[0];
    const predictor = g(317, [1])[0];
    const planar = g(284, [1])[0];
    const sampleFormat = g(339, [1])[0];                 // 1 uint, 2 int, 3 float
    const colorMap = ifd.get(320)?.values;
    if (planar !== 1) throw new Error('planar (separate) sample layout unsupported; use chunky (interleaved)');

    const tileWidth = ifd.get(322)?.values[0];
    const tiled = tileWidth != null;
    const tw = tiled ? tileWidth : width;
    const th = tiled ? ifd.get(323).values[0] : (g(278, [height])[0]);
    const offsets = (tiled ? ifd.get(324) : ifd.get(273)).values;
    const counts = (tiled ? ifd.get(325) : ifd.get(279)).values;
    const cols = tiled ? Math.ceil(width / tw) : 1;
    const rows = Math.ceil(height / th);

    const decodeBlock = async (raw) => {
        let b = raw;
        if (compression === 1) b = raw;
        else if (compression === 5) b = lzwDecode(raw);
        else if (compression === 8 || compression === 32946) b = await inflate(raw);
        else if (compression === 32773) b = packBitsDecode(raw);
        else throw new Error(`GeoTIFF compression ${compression} unsupported (have none, LZW, Deflate, PackBits)`);
        return b;
    };

    // output as RGBA
    const out = new Uint8ClampedArray(width * height * 4);
    // for 16-bit / float single band we normalize to grayscale across the image
    const needsNorm = (bps > 8) && spp === 1;
    let gmin = Infinity, gmax = -Infinity;
    const floatBlocks = [];   // defer when normalizing

    const bytesPerSample = bps / 8;
    const toSamples = (bytes, bw, bh) => {
        // returns a Float64 or int array of length bw*bh*spp, honoring endianness and format
        const n = bw * bh * spp;
        const arr = (bps <= 8) ? new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(n, bytes.length))
            : new Float64Array(n);
        if (bps > 8) {
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let i = 0; i < n; i++) {
                const o = i * bytesPerSample;
                if (o + bytesPerSample > bytes.byteLength) { arr[i] = 0; continue; }
                if (bps === 16) arr[i] = sampleFormat === 2 ? dv.getInt16(o, tiff.little) : dv.getUint16(o, tiff.little);
                else if (bps === 32) arr[i] = sampleFormat === 3 ? dv.getFloat32(o, tiff.little) : dv.getUint32(o, tiff.little);
                else arr[i] = dv.getUint8(o);
            }
        }
        return arr;
    };

    for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
            const bi = ty * cols + tx;
            if (offsets[bi] == null) continue;
            const raw = new Uint8Array(tiff.buffer, offsets[bi], counts[bi]);
            let bytes = await decodeBlock(raw);
            const bw = tiled ? tw : width;
            const bh = tiled ? th : Math.min(th, height - ty * th);
            let samples = toSamples(bytes, bw, bh);
            if (predictor === 2) undoHorizontalPredictor(samples, bw, bh, spp, bps);
            else if (predictor !== 1) throw new Error(`predictor ${predictor} unsupported`);

            // place into output
            const x0 = tx * tw, y0 = ty * th;
            for (let ry = 0; ry < bh; ry++) {
                const oy = y0 + ry;
                if (oy >= height) break;
                for (let rx = 0; rx < bw; rx++) {
                    const ox = x0 + rx;
                    if (ox >= width) break;
                    const si = (ry * bw + rx) * spp;
                    const di = (oy * width + ox) * 4;
                    if (needsNorm) {
                        const v = samples[si];
                        if (v < gmin) gmin = v; if (v > gmax) gmax = v;
                        floatBlocks.push(di, v);           // store for a second pass
                    } else if (spp >= 3) {
                        const shift = bps === 16 ? 8 : 0;
                        out[di] = bps === 16 ? samples[si] >> 8 : samples[si];
                        out[di + 1] = bps === 16 ? samples[si + 1] >> 8 : samples[si + 1];
                        out[di + 2] = bps === 16 ? samples[si + 2] >> 8 : samples[si + 2];
                        out[di + 3] = spp >= 4 ? (bps === 16 ? samples[si + 3] >> 8 : samples[si + 3]) : 255;
                    } else if (colorMap) {
                        const n = colorMap.length / 3, v = samples[si];
                        out[di] = colorMap[v] >> 8; out[di + 1] = colorMap[n + v] >> 8; out[di + 2] = colorMap[2 * n + v] >> 8; out[di + 3] = 255;
                    } else {
                        let v = bps === 8 ? samples[si] : samples[si];
                        if (photometric === 0) v = 255 - v;     // WhiteIsZero
                        out[di] = out[di + 1] = out[di + 2] = v; out[di + 3] = 255;
                    }
                }
            }
        }
    }

    if (needsNorm) {
        const span = (gmax - gmin) || 1;
        for (let k = 0; k < floatBlocks.length; k += 2) {
            const di = floatBlocks[k], v = floatBlocks[k + 1];
            let g255 = Math.round(((v - gmin) / span) * 255);
            if (photometric === 0) g255 = 255 - g255;
            out[di] = out[di + 1] = out[di + 2] = g255; out[di + 3] = 255;
        }
    }
    return {width, height, data: out, bands: spp, bits: bps, min: gmin, max: gmax};
}

/** Choose the IFD to render: the largest overview whose longest side <= maxSize, else the smallest. */
export function chooseIFD(ifds, maxSize) {
    const sized = ifds.map((m, i) => ({i, m, s: Math.max(m.get(256).values[0], m.get(257).values[0])}));
    const small = sized.filter((x) => x.s <= maxSize).sort((a, b) => b.s - a.s);
    if (small.length) return small[0];
    return sized.sort((a, b) => a.s - b.s)[0];           // nothing small enough: coarsest
}

/**
 * Load a GeoTIFF/COG ArrayBuffer and produce an RGBA canvas plus its lon/lat footprint.
 * @returns {{canvas, corners, crs, epsg, width, height, bands, bits, overview}}
 */
export async function loadGeoTIFF(buffer, {maxSize = 2048} = {}) {
    const tiff = parseTIFF(buffer);
    const geoRef = geoReference(tiff.ifds[0]);          // footprint from the full-res IFD
    const pick = chooseIFD(tiff.ifds, maxSize);
    const img = await decodeImage(tiff, pick.m);

    const canvas = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(img.width, img.height)
        : Object.assign(document.createElement('canvas'), {width: img.width, height: img.height});
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);

    return {
        canvas, corners: geoRef.corners, crs: geoRef.crs, epsg: geoRef.epsg,
        width: geoRef.width, height: geoRef.height, bands: img.bands, bits: img.bits,
        overview: pick.i, renderWidth: img.width, renderHeight: img.height,
    };
}

/** PNG data URL from the canvas produced by loadGeoTIFF (for a MapLibre image source). */
export async function canvasToDataURL(canvas) {
    if (typeof canvas.convertToBlob === 'function') {        // OffscreenCanvas
        const blob = await canvas.convertToBlob({type: 'image/png'});
        return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    }
    return canvas.toDataURL('image/png');
}
