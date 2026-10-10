/*
 * glb-decimate.js — offline authoring step for the ASCII city race.
 *
 *   node tools/glb-decimate.js racegame/vehicles.bin racegame/veh1.glb racegame/veh2.glb ...
 *
 * Why this exists
 * ---------------
 * The five race vehicles total 51 MB and ~791,000 triangles. An ASCII grid
 * draws a car with roughly 120 characters, so almost all of that detail is
 * destroyed by the renderer before anybody sees it. This collapses each model
 * down to a couple of thousand triangles and writes one small binary the game
 * loads in a single request.
 *
 * What it does, per model:
 *   1. bakes every mesh through its node's world matrix into one triangle soup
 *      (the Sketchfab exports carry rotation/scale nodes, and veh3/veh4 sit far
 *      off the origin, so the raw accessor data is not usable as-is)
 *   2. drops texture/material data on purpose — the ASCII pass only reads
 *      luminance and silhouette, so paint would be wasted bytes
 *   3. recentres it (X/Z on the origin, floor at y = 0) and scales the largest
 *      horizontal extent to exactly 1.0, so the game can size and place every
 *      vehicle identically — note it does NOT try to guess which way is
 *      forward: every model in this set is an aircraft, and for a wide-winged
 *      jet the wingspan is *longer* than the fuselage, so "longest horizontal
 *      axis = forward" silently rotates the model 90 degrees. Facing is read
 *      off a rendered top view instead and applied per vehicle in the game.
 *   4. vertex-cluster decimation (average of each occupied grid cell) with a
 *      binary search on the grid resolution to land near the target triangle
 *      count, then rebuilds smooth area-weighted normals
 *
 * Output format (little endian):
 *   u32 magic 'VRS1', u32 vehicleCount
 *   per vehicle: u32 nameLen + name bytes
 *                f32 dimX, dimY, dimZ      (canonical, length on Z = 1.0)
 *                u32 vertCount, u32 triCount
 *                f32[verts*3] positions, f32[verts*3] normals, u32[tris*3] indices
 */
const fs = require('fs');

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const COMP_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const ITEMS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/* ---------- glTF reading ---------- */

function readGLB(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB: ' + file);
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8'));
    else if (type === CHUNK_BIN) bin = data;
    off += 8 + len;
  }
  if (!json) throw new Error('no JSON chunk in ' + file);
  return { json, bin };
}

/* Returns a tightly packed copy of an accessor, so byteStride (veh5 is an
   interleaved OBJ import) is handled instead of silently misread. */
function readAccessor(json, bin, index) {
  const a = json.accessors[index];
  const bv = json.bufferViews[a.bufferView];
  const TA = COMPONENT[a.componentType];
  const itemSize = ITEMS[a.type];
  const compBytes = COMP_BYTES[a.componentType];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new TA(a.count * itemSize);
  const stride = bv.byteStride || 0;
  if (!stride || stride === compBytes * itemSize) {
    out.set(new TA(bin.buffer, bin.byteOffset + base, a.count * itemSize));
  } else {
    for (let e = 0; e < a.count; e++) {
      out.set(new TA(bin.buffer, bin.byteOffset + base + e * stride, itemSize), e * itemSize);
    }
  }
  return { array: out, itemSize, count: a.count };
}

function identity() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }

function multiply(a, b) {
  const out = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    out[c * 4 + r] = s;
  }
  return out;
}

function fromTRS(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1
  ];
}

function nodeMatrices(json) {
  const nodes = json.nodes || [];
  const world = new Array(nodes.length);
  function walk(i, parent) {
    const n = nodes[i] || {};
    const local = n.matrix ? n.matrix.slice()
      : fromTRS(n.translation || [0,0,0], n.rotation || [0,0,0,1], n.scale || [1,1,1]);
    const m = multiply(parent, local);
    world[i] = m;
    (n.children || []).forEach(function (c) { walk(c, m); });
  }
  (json.scenes[json.scene || 0] || { nodes: [] }).nodes.forEach(function (i) { walk(i, identity()); });
  return world;
}

/* Every mesh, baked into one triangle soup in model space. */
function soup(file) {
  const { json, bin } = readGLB(file);
  const world = nodeMatrices(json);
  const positions = [];
  const indices = [];
  let vertBase = 0;

  (json.nodes || []).forEach(function (n, ni) {
    if (n.mesh == null) return;
    const m = world[ni] || identity();
    (json.meshes[n.mesh].primitives || []).forEach(function (p) {
      if (p.attributes.POSITION == null) return;
      const pos = readAccessor(json, bin, p.attributes.POSITION);
      const p3 = pos.itemSize;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.array[i * p3], y = pos.array[i * p3 + 1], z = pos.array[i * p3 + 2];
        positions.push(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14]
        );
      }
      if (p.indices != null) {
        const idx = readAccessor(json, bin, p.indices);
        for (let i = 0; i < idx.count; i++) indices.push(vertBase + idx.array[i]);
      } else {
        for (let i = 0; i < pos.count; i++) indices.push(vertBase + i);
      }
      vertBase += pos.count;
    });
  });

  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/* ---------- canonicalising ---------- */

function bounds(positions) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  return { lo, hi };
}

/* Length onto Z (rotating 90 deg if the model is longer across), centred on
   X/Z, grounded at y = 0, and scaled so the length is exactly 1. */
function canonicalise(positions, indices) {
  let b = bounds(positions);
  let size = [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]];
  const length = Math.max(size[0], size[2], 1e-6);
  const scale = 1 / length;
  const cx = (b.lo[0] + b.hi[0]) / 2, cz = (b.lo[2] + b.hi[2]) / 2;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] - cx) * scale;
    positions[i + 1] = (positions[i + 1] - b.lo[1]) * scale;
    positions[i + 2] = (positions[i + 2] - cz) * scale;
  }
  return {
    dim: [size[0] * scale, size[1] * scale, size[2] * scale],
    tris: indices.length / 3
  };
}

/* ---------- decimation ---------- */

/* Vertex clustering: average every vertex that shares a grid cell, then keep
   the triangles that survive with three distinct corners. Cheap, dependency
   free, and kind to silhouettes at the resolutions ASCII can actually show. */
function cluster(positions, indices, res) {
  const b = bounds(positions);
  const size = [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]];
  const longest = Math.max(size[0], size[1], size[2], 1e-6);
  const cell = longest / res;
  const nx = Math.max(1, Math.ceil(size[0] / cell) + 1);
  const ny = Math.max(1, Math.ceil(size[1] / cell) + 1);

  const n = positions.length / 3;
  const remap = new Int32Array(n);
  const map = new Map();
  const sums = [];   // [sx, sy, sz, count]
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const ix = Math.min(nx - 1, Math.floor((x - b.lo[0]) / cell));
    const iy = Math.min(ny - 1, Math.floor((y - b.lo[1]) / cell));
    const iz = Math.floor((z - b.lo[2]) / cell);
    const key = ix + iy * nx + iz * nx * ny + '';
    let id = map.get(key);
    if (id === undefined) {
      id = sums.length / 4;
      map.set(key, id);
      sums.push(x, y, z, 1);
    } else {
      sums[id * 4] += x; sums[id * 4 + 1] += y; sums[id * 4 + 2] += z; sums[id * 4 + 3]++;
    }
    remap[i] = id;
  }

  const vertCount = sums.length / 4;
  const outPos = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    const c = sums[i * 4 + 3];
    outPos[i * 3] = sums[i * 4] / c;
    outPos[i * 3 + 1] = sums[i * 4 + 1] / c;
    outPos[i * 3 + 2] = sums[i * 4 + 2] / c;
  }

  const seen = new Set();
  const outIdx = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], bb = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a === bb || bb === c || a === c) continue;
    /* same three corners in any winding = the same face twice */
    const s = a < bb ? (bb < c ? [a, bb, c] : (a < c ? [a, c, bb] : [c, a, bb]))
                     : (a < c ? [bb, a, c] : (bb < c ? [bb, c, a] : [c, bb, a]));
    const key = s[0] * 1e12 + s[1] * 1e6 + s[2];
    if (seen.has(key)) continue;
    seen.add(key);
    outIdx.push(a, bb, c);
  }
  return { positions: outPos, indices: Uint32Array.from(outIdx), vertCount };
}

/* Search the grid resolution that lands closest to the triangle budget. */
function decimate(positions, indices, targetTris) {
  let lo = 6, hi = 160, best = null;
  for (let step = 0; step < 9; step++) {
    const mid = Math.round((lo + hi) / 2);
    const r = cluster(positions, indices, mid);
    const tris = r.indices.length / 3;
    if (!best || Math.abs(tris - targetTris) < Math.abs(best.tris - targetTris)) best = { res: mid, tris, r };
    if (tris > targetTris) hi = mid - 1;
    else lo = mid + 1;
    if (hi < lo) break;
  }
  return best;
}

/* Area-weighted smooth normals for the decimated mesh. */
function normals(positions, indices) {
  const out = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    /* cross product length is twice the face area, so this weights by area */
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const len = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= len; out[i + 1] /= len; out[i + 2] /= len;
  }
  return out;
}

/* ---------- writing ---------- */

function build(file, target) {
  const raw = soup(file);
  const meta = canonicalise(raw.positions, raw.indices);
  const dec = decimate(raw.positions, raw.indices, target);
  const pos = dec.r.positions;
  const idx = dec.r.indices;
  const nrm = normals(pos, idx);
  return { pos, idx, nrm, dim: meta.dim, before: meta.tris, after: idx.length / 3, res: dec.res };
}

function write(outFile, vehicles) {
  let bytes = 8;
  vehicles.forEach(function (v) {
    bytes += 4 + Buffer.byteLength(v.name) + 12 + 8 + v.pos.length * 4 * 2 + v.idx.length * 4;
  });
  const buf = Buffer.alloc(bytes);
  let o = 0;
  buf.writeUInt32LE(0x31535256, o); o += 4;           // 'VRS1'
  buf.writeUInt32LE(vehicles.length, o); o += 4;
  vehicles.forEach(function (v) {
    const name = Buffer.from(v.name, 'utf8');
    buf.writeUInt32LE(name.length, o); o += 4;
    name.copy(buf, o); o += name.length;
    buf.writeFloatLE(v.dim[0], o); o += 4;
    buf.writeFloatLE(v.dim[1], o); o += 4;
    buf.writeFloatLE(v.dim[2], o); o += 4;
    buf.writeUInt32LE(v.pos.length / 3, o); o += 4;
    buf.writeUInt32LE(v.idx.length / 3, o); o += 4;
    Buffer.from(v.pos.buffer, v.pos.byteOffset, v.pos.byteLength).copy(buf, o); o += v.pos.byteLength;
    Buffer.from(v.nrm.buffer, v.nrm.byteOffset, v.nrm.byteLength).copy(buf, o); o += v.nrm.byteLength;
    Buffer.from(v.idx.buffer, v.idx.byteOffset, v.idx.byteLength).copy(buf, o); o += v.idx.byteLength;
  });
  fs.writeFileSync(outFile, buf);
  return buf.length;
}

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log('usage: node tools/glb-decimate.js <out.bin> <model.glb> [more.glb ...]');
  process.exit(1);
}
const outFile = args[0];
const target = 2200;
const vehicles = [];
let beforeTris = 0, beforeBytes = 0;
args.slice(1).forEach(function (f) {
  const t0 = Date.now();
  const v = build(f, target);
  beforeTris += v.before;
  beforeBytes += fs.statSync(f).size;
  const name = f.replace(/^.*[\\/]/, '').replace(/\.glb$/i, '');
  vehicles.push({ name: name, pos: v.pos, idx: v.idx, nrm: v.nrm, dim: v.dim });
  console.log(name.padEnd(6) +
    ' tris ' + String(v.before).padStart(7) + ' -> ' + String(v.after).padStart(5) +
    '  verts ' + String(v.pos.length / 3).padStart(5) +
    '  grid ' + String(v.res).padStart(3) +
    '  dims ' + v.dim.map(function (d) { return d.toFixed(3); }).join(' x ') +
    '  ' + (Date.now() - t0) + 'ms');
});
const outBytes = write(outFile, vehicles);
console.log('---');
console.log('wrote ' + outFile + '  ' + (outBytes / 1024).toFixed(1) + ' KB');
console.log('source ' + (beforeBytes / 1048576).toFixed(1) + ' MB / ' + beforeTris.toLocaleString('en-US') +
  ' tris  ->  ' + vehicles.reduce(function (s, v) { return s + v.idx.length / 3; }, 0).toLocaleString('en-US') + ' tris');
console.log('shrink: ' + (beforeBytes / outBytes).toFixed(0) + 'x smaller by bytes');
