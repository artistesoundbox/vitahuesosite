/*
 * glb-decimate.js — offline authoring step for the ASCII city race.
 *
 *   node tools/glb-decimate.js racegame/vehicles.bin racegame/veh1.glb racegame/veh2.glb ...
 *
 * Why this exists
 * ---------------
 * The five race vehicles total 51 MB and ~791,000 triangles. Their original
 * embedded textures are JPEG/PNG, which a browser decodes natively, so this
 * pass keeps the surface detail and throws away the geometry detail the game
 * cannot show: each hull comes out at a couple of thousand triangles, with its
 * UVs intact and its base-colour texture written out beside the binary.
 *
 * What it does, per model:
 *   1. bakes every mesh through its node's world matrix into one triangle soup
 *      (the Sketchfab exports carry rotation/scale nodes, and veh3/veh4 sit far
 *      off the origin, so the raw accessor data is not usable as-is)
 *   2. writes the material's base-colour image next to the output (raw bytes —
 *      the file's own header says PNG or JPEG, so it needs no re-encoding)
 *   3. recentres it (X/Z on the origin, floor at y = 0) and scales the largest
 *      horizontal extent to exactly 1.0, so the game can size and place every
 *      vehicle identically — note it does NOT try to guess which way is
 *      forward: every model in this set is an aircraft, and for a wide-winged
 *      jet the wingspan is *longer* than the fuselage, so "longest horizontal
 *      axis = forward" silently rotates the model 90 degrees. Facing is read
 *      off a rendered top view instead and applied per vehicle in the game.
 *   4. vertex-cluster decimation (average of each occupied grid cell) with a
 *      binary search on the grid resolution to land near the target triangle
 *      count, then rebuilds smooth area-weighted normals. UVs are averaged with
 *      the positions, and the cell key includes the UV, so vertices either side
 *      of a texture seam never merge and the mapping stays sharp.
 *
 * The cell key is position + UV + surface direction, and all three earn their
 * place:
 *   - UV, because two vertices either side of a texture seam must not weld,
 *     or the paint averages across the seam and the livery smears. The bucket
 *     is calibrated to the position cell rather than guessed: the base-colour
 *     texture spans roughly the model's canonical width, so 1/UV_RES is about
 *     the same distance on the surface as one grid cell.
 * Two more ideas live here as switches, both OFF, because they were measured
 * and both made things worse (veh1, target 16,000):
 *   - CUBE=1 clusters in cube-normalised space, on the theory that these
 *     aircraft are thin (a wing is 0.02 of a unit thick, the span is 1.9) and
 *     a cell size taken from the longest axis starves the thin one. Every axis
 *     then gets the same cell count, the grid has to drop to keep the budget,
 *     and area kept came out slightly worse: 68.8% against 70.1%.
 *   - NRM=1 adds the surface direction to the key, on the theory that the two
 *     faces of a wing must not weld. It does stop that, and that is the
 *     problem: the vertex count stops responding to the grid resolution at
 *     all, the binary search runs to its floor, and the mesh comes out folded
 *     with 234% of its original area — worse than either alternative. There is
 *     no setting of it that lands on a budget.
 * What actually helped was simply spending more triangles (57.2% of the area
 * kept at 8,000, 70.1% at 16,000, 80.7% at 32,000 — the loss is greebles and
 * panel detail smaller than a cell collapsing, not the hull tearing in half).
 * Do not "fix" a torn-looking hull by tightening the UV bucket either: a
 * stricter key with the same budget forces a coarser position grid.
 *
 * The report prints two health numbers per model, because a decimated mesh can
 * hit its triangle target and still be wrong: the surface area it kept, and
 * how much of its edge network is open (an edge used by one triangle). A solid
 * hull keeps almost all of its area and very few open edges; a shredded one
 * loses area and sprouts boundaries.
 *
 * Output format (little endian):
 *   u32 magic 'VRS2', u32 vehicleCount
 *   per vehicle: u32 nameLen + name bytes
 *                u32 texLen + texture file name bytes ('' = untextured)
 *                f32 dimX, dimY, dimZ      (canonical, length on Z = 1.0)
 *                u32 vertCount, u32 triCount
 *                f32[verts*3] positions, f32[verts*3] normals, f32[verts*2] uvs,
 *                u32[tris*3] indices
 */
const fs = require('fs');
const path = require('path');

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const COMP_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const ITEMS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/* The atlas these exports ship: 1024 x 1024, read out of the headers of all
   five, and the unit the reported UV error is measured in. */
const TEXELS = 1024;

/* Both of these are overridable from the environment so a decimation setting
   can be compared against another one instead of argued about:
     TRIS=8000 UV_RES=48 NRM=0 node tools/glb-decimate.js ...
   NRM=0 turns the direction part of the key off. */
const UV_RES = Number(process.env.UV_RES || 48);
const NRM_BUCKETS = Number(process.env.NRM || 0);       // 0 = no direction in the key
/* cluster in cube-normalised space — see the header. */
const CUBE = process.env.CUBE === '1';

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

/* Every mesh, baked into one triangle soup in model space. UVs and vertex
   normals ride along; the normals are only used as a clustering key, and are
   rebuilt as smooth area-weighted normals after the decimation. */
function soup(file) {
  const { json, bin } = readGLB(file);
  const world = nodeMatrices(json);
  const positions = [];
  const uvs = [];
  const nrms = [];
  const indices = [];
  let vertBase = 0;
  let sawUv = false;
  let sawNrm = false;

  (json.nodes || []).forEach(function (n, ni) {
    if (n.mesh == null) return;
    const m = world[ni] || identity();
    (json.meshes[n.mesh].primitives || []).forEach(function (p) {
      if (p.attributes.POSITION == null) return;
      const pos = readAccessor(json, bin, p.attributes.POSITION);
      const uv = p.attributes.TEXCOORD_0 != null ? readAccessor(json, bin, p.attributes.TEXCOORD_0) : null;
      const nrm = p.attributes.NORMAL != null ? readAccessor(json, bin, p.attributes.NORMAL) : null;
      if (uv) sawUv = true;
      if (nrm) sawNrm = true;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.array[i * 3], y = pos.array[i * 3 + 1], z = pos.array[i * 3 + 2];
        positions.push(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14]
        );
        if (uv) uvs.push(uv.array[i * 2], uv.array[i * 2 + 1]);
        else uvs.push(0, 0);
        if (nrm) {
          /* rotated by the node's world matrix, which for these exports only
             ever carries rotation and uniform scale, but normalise anyway */
          const nx = m[0] * nrm.array[i * 3] + m[4] * nrm.array[i * 3 + 1] + m[8] * nrm.array[i * 3 + 2];
          const ny = m[1] * nrm.array[i * 3] + m[5] * nrm.array[i * 3 + 1] + m[9] * nrm.array[i * 3 + 2];
          const nz = m[2] * nrm.array[i * 3] + m[6] * nrm.array[i * 3 + 1] + m[10] * nrm.array[i * 3 + 2];
          const l = Math.hypot(nx, ny, nz) || 1;
          nrms.push(nx / l, ny / l, nz / l);
        } else nrms.push(0, 0, 0);
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

  return {
    positions: Float32Array.from(positions),
    uvs: Float32Array.from(uvs),
    normals: Float32Array.from(nrms),
    indices: Uint32Array.from(indices),
    sawUv: sawUv,
    sawNrm: sawNrm
  };
}

/* The base-colour image of the first material that has one, written out as-is.
   glTF stores images as complete PNG/JPEG files, so there is nothing to encode. */
function dumpTexture(file, json, bin, outDir, stem) {
  const materials = json.materials || [];
  for (let i = 0; i < materials.length; i++) {
    const pbr = materials[i].pbrMetallicRoughness || {};
    if (!pbr.baseColorTexture) continue;
    const tex = (json.textures || [])[pbr.baseColorTexture.index];
    if (!tex || tex.source == null) continue;
    const img = (json.images || [])[tex.source];
    if (!img || img.bufferView == null) continue;
    const bv = json.bufferViews[img.bufferView];
    const bytes = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const ext = img.mimeType === 'image/png' ? '.png' : (img.mimeType === 'image/jpeg' ? '.jpg' : '');
    if (!ext) continue;
    const name = stem + ext;
    fs.writeFileSync(path.join(outDir, name), bytes);
    return { name: name, bytes: bv.byteLength, material: materials[i].name || ('#' + i) };
  }
  return null;
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

/* Centred on X/Z, grounded at y = 0, scaled so the longest horizontal extent is
   exactly 1 — the game applies its own facing fix on top of this. */
function canonicalise(positions) {
  const b = bounds(positions);
  const size = [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]];
  const length = Math.max(size[0], size[2], 1e-6);
  const scale = 1 / length;
  const cx = (b.lo[0] + b.hi[0]) / 2, cz = (b.lo[2] + b.hi[2]) / 2;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] - cx) * scale;
    positions[i + 1] = (positions[i + 1] - b.lo[1]) * scale;
    positions[i + 2] = (positions[i + 2] - cz) * scale;
  }
  return [size[0] * scale, size[1] * scale, size[2] * scale];
}

/* ---------- decimation ---------- */

/* Vertex clustering: average every vertex that shares a grid cell, then keep
   the triangles that survive with three distinct corners. Cheap, dependency
   free, and kind to silhouettes at the resolutions the game can actually show.
   The cell key carries the UV and the surface direction as well as the
   position — see the header for why each of those is load-bearing. */
function cluster(positions, uvs, nrms, indices, res, cube) {
  const b = bounds(positions);
  const size = [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]];
  const longest = Math.max(size[0], size[1], size[2], 1e-6);
  const cell = longest / res;
  const uvRes = UV_RES;
  /* per-axis scale: with cube=true every axis is stretched to the longest one
     for the purposes of the grid, so all three get `res` cells and a thin wing
     is not squashed into one of them. Undone again when the sums are written. */
  const sc = cube
    ? [longest / Math.max(size[0], 1e-6), longest / Math.max(size[1], 1e-6), longest / Math.max(size[2], 1e-6)]
    : [1, 1, 1];
  const nx = Math.max(1, Math.ceil((size[0] * sc[0]) / cell) + 1);
  const ny = Math.max(1, Math.ceil((size[1] * sc[1]) / cell) + 1);
  const nz = Math.max(1, Math.ceil((size[2] * sc[2]) / cell) + 1);

  const n = positions.length / 3;
  const remap = new Int32Array(n);
  const map = new Map();
  const sums = [];   // [sx, sy, sz, count, su, sv] — positions in normalised space
  for (let i = 0; i < n; i++) {
    const x = (positions[i * 3] - b.lo[0]) * sc[0];
    const y = (positions[i * 3 + 1] - b.lo[1]) * sc[1];
    const z = (positions[i * 3 + 2] - b.lo[2]) * sc[2];
    const u = uvs[i * 2], v = uvs[i * 2 + 1];
    const ix = Math.min(nx - 1, Math.floor(x / cell));
    const iy = Math.min(ny - 1, Math.floor(y / cell));
    const iz = Math.min(nz - 1, Math.floor(z / cell));
    /* rounded, not floored: a UV of exactly 0 or 1 must not land in a thin
       extra cell of its own, and negative UVs must stay distinct from small
       positive ones (wrapping happens at sample time, not here) */
    const iu = Math.round(u * uvRes);
    const iv = Math.round(v * uvRes);
    const inx = Math.round(nrms[i * 3] * NRM_BUCKETS);
    const iny = Math.round(nrms[i * 3 + 1] * NRM_BUCKETS);
    const inz = Math.round(nrms[i * 3 + 2] * NRM_BUCKETS);
    const key = ix + ',' + iy + ',' + iz + ',' + iu + ',' + iv + ',' + inx + ',' + iny + ',' + inz;
    let id = map.get(key);
    if (id === undefined) {
      id = sums.length / 6;
      map.set(key, id);
      sums.push(x, y, z, 1, u, v);
    } else {
      sums[id * 6] += x; sums[id * 6 + 1] += y; sums[id * 6 + 2] += z;
      sums[id * 6 + 3] += 1;
      sums[id * 6 + 4] += u; sums[id * 6 + 5] += v;
    }
    /* averaged UVs are only half the story: the normals are rebuilt from the
       decimated triangles afterwards, so nothing else has to be carried */
    remap[i] = id;
  }

  const vertCount = sums.length / 6;
  const outPos = new Float32Array(vertCount * 3);
  const outUv = new Float32Array(vertCount * 2);
  for (let i = 0; i < vertCount; i++) {
    const c = sums[i * 6 + 3];
    outPos[i * 3] = sums[i * 6] / c / sc[0] + b.lo[0];
    outPos[i * 3 + 1] = sums[i * 6 + 1] / c / sc[1] + b.lo[1];
    outPos[i * 3 + 2] = sums[i * 6 + 2] / c / sc[2] + b.lo[2];
    outUv[i * 2] = sums[i * 6 + 4] / c;
    outUv[i * 2 + 1] = sums[i * 6 + 5] / c;
  }

  /* How far the decimation moved each vertex's UV, in whole texels of a 1024
     atlas. This is the number that decides whether the paint still lands where
     the exporter put it, and it is not visible in any triangle count: the two
     vertices either side of a seam both survive, at slightly wrong places, and
     the livery smears. Measured, not assumed. */
  const uvErr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const id = remap[i];
    const c = sums[id * 6 + 3];
    const du = (sums[id * 6 + 4] / c - uvs[i * 2]) * TEXELS;
    const dv = (sums[id * 6 + 5] / c - uvs[i * 2 + 1]) * TEXELS;
    uvErr[i] = Math.hypot(du, dv);
  }
  const sorted = Array.prototype.slice.call(uvErr).sort(function (a, b) { return a - b; });
  const pick = function (f) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))]; };
  const uvStats = { p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1] || 0 };

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
  return { positions: outPos, uvs: outUv, indices: Uint32Array.from(outIdx), vertCount, uvStats };
}

/* Search the grid resolution that lands closest to the triangle budget. */
function decimate(positions, uvs, nrms, indices, targetTris, cube) {
  let lo = 2, hi = 400, best = null;
  for (let step = 0; step < 11; step++) {
    const mid = Math.round((lo + hi) / 2);
    const r = cluster(positions, uvs, nrms, indices, mid, cube);
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

/* ---------- health metrics ---------- */

/* Total surface area. A decimation that welds a wing's two faces together, or
   drops whole regions of the hull, loses area — so the fraction kept is a
   direct read on whether the result is still the shape it started as. */
function surfaceArea(positions, indices) {
  let area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[b] - positions[a], ay = positions[b + 1] - positions[a + 1], az = positions[b + 2] - positions[a + 2];
    const bx = positions[c] - positions[a], by = positions[c + 1] - positions[a + 1], bz = positions[c + 2] - positions[a + 2];
    area += Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) * 0.5;
  }
  return area;
}

/* The fraction of edges used by exactly one triangle. Where the surface is
   closed this is near zero; tearing it open — the failure mode that makes a
   hull look shredded — shows up here immediately. (The source is not closed
   either: these exports arrive as several chunks, so their own seams count.) */
function openEdgeFraction(indices) {
  const count = new Map();
  const add = function (a, b) {
    const key = a < b ? a + ':' + b : b + ':' + a;
    count.set(key, (count.get(key) || 0) + 1);
  };
  for (let t = 0; t < indices.length; t += 3) {
    add(indices[t], indices[t + 1]);
    add(indices[t + 1], indices[t + 2]);
    add(indices[t + 2], indices[t]);
  }
  let open = 0;
  count.forEach(function (n) { if (n === 1) open++; });
  return count.size ? open / count.size : 0;
}

/* ---------- writing ---------- */

function build(file, outDir, stem, target) {
  const { json, bin } = readGLB(file);
  const raw = soup(file);
  const dim = canonicalise(raw.positions);
  const dec = decimate(raw.positions, raw.uvs, raw.normals, raw.indices, target, CUBE);
  const pos = dec.r.positions;
  const idx = dec.r.indices;
  const tex = dumpTexture(file, json, bin, outDir, stem);
  const areaBefore = surfaceArea(raw.positions, raw.indices);
  const areaAfter = surfaceArea(pos, idx);
  return {
    pos: pos, idx: idx, uv: dec.r.uvs, nrm: normals(pos, idx),
    dim: dim, before: raw.indices.length / 3, after: idx.length / 3,
    res: dec.res, sawUv: raw.sawUv, tex: tex, uvStats: dec.r.uvStats,
    areaKept: areaBefore > 0 ? areaAfter / areaBefore : 1,
    openEdges: openEdgeFraction(idx)
  };
}

function write(outFile, vehicles) {
  let bytes = 8;
  vehicles.forEach(function (v) {
    bytes += 4 + Buffer.byteLength(v.name) + 4 + Buffer.byteLength(v.texName);
    bytes += 12 + 8;
    bytes += v.pos.length * 4 * 2 + v.uv.length * 4 + v.idx.length * 4;
  });
  const buf = Buffer.alloc(bytes);
  let o = 0;
  buf.writeUInt32LE(0x32535256, o); o += 4;           // 'VRS2'
  buf.writeUInt32LE(vehicles.length, o); o += 4;
  vehicles.forEach(function (v) {
    const name = Buffer.from(v.name, 'utf8');
    buf.writeUInt32LE(name.length, o); o += 4;
    name.copy(buf, o); o += name.length;
    const tex = Buffer.from(v.texName, 'utf8');
    buf.writeUInt32LE(tex.length, o); o += 4;
    tex.copy(buf, o); o += tex.length;
    buf.writeFloatLE(v.dim[0], o); o += 4;
    buf.writeFloatLE(v.dim[1], o); o += 4;
    buf.writeFloatLE(v.dim[2], o); o += 4;
    buf.writeUInt32LE(v.pos.length / 3, o); o += 4;
    buf.writeUInt32LE(v.idx.length / 3, o); o += 4;
    Buffer.from(v.pos.buffer, v.pos.byteOffset, v.pos.byteLength).copy(buf, o); o += v.pos.byteLength;
    Buffer.from(v.nrm.buffer, v.nrm.byteOffset, v.nrm.byteLength).copy(buf, o); o += v.nrm.byteLength;
    Buffer.from(v.uv.buffer, v.uv.byteOffset, v.uv.byteLength).copy(buf, o); o += v.uv.byteLength;
    Buffer.from(v.idx.buffer, v.idx.byteOffset, v.idx.byteLength).copy(buf, o); o += v.idx.byteLength;
  });
  fs.writeFileSync(outFile, buf);
  return buf.length;
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('usage: node tools/glb-decimate.js <out.bin> <model.glb> [more.glb ...]');
  process.exit(1);
}
const outFile = args[0];
const outDir = path.dirname(outFile) || '.';
let worstArea = 1, worstOpen = 0, worstUv = 0;
/* 8,000 triangles was a budget for a hull that was only ever a glowing ASCII
   silhouette. The plain 3D view is the game now and the paint is the point, so
   the budget goes up: 16,000 keeps 70% of the model's surface area against 57%
   at 8,000, and the binary lands each hull within a few hundred triangles of
   it. The binary has to search finer than it used to, hence the range. */
const target = Number(process.env.TRIS || 16000);
const vehicles = [];
let beforeTris = 0, beforeBytes = 0, texBytes = 0;
args.slice(1).forEach(function (f) {
  const t0 = Date.now();
  const name = f.replace(/^.*[\\/]/, '').replace(/\.glb$/i, '');
  const v = build(f, outDir, 'tex-' + name, target);
  beforeTris += v.before;
  beforeBytes += fs.statSync(f).size;
  const texName = v.tex ? v.tex.name : '';
  if (v.tex) texBytes += v.tex.bytes;
  vehicles.push({ name: name, pos: v.pos, idx: v.idx, uv: v.uv, nrm: v.nrm, dim: v.dim, texName: texName });
  worstArea = Math.min(worstArea, v.areaKept);
  worstOpen = Math.max(worstOpen, v.openEdges);
  worstUv = Math.max(worstUv, v.uvStats.p95);
  console.log(name.padEnd(6) +
    ' tris ' + String(v.before).padStart(7) + ' -> ' + String(v.after).padStart(5) +
    '  verts ' + String(v.pos.length / 3).padStart(5) +
    '  grid ' + String(v.res).padStart(3) +
    '  uv ' + (v.sawUv ? 'yes' : 'NO') +
    '  tex ' + (v.tex ? v.tex.name + ' (' + (v.tex.bytes / 1024).toFixed(0) + ' KB)' : 'none') +
    '  dims ' + v.dim.map(function (d) { return d.toFixed(3); }).join(' x ') +
    '  area kept ' + (v.areaKept * 100).toFixed(1).padStart(5) + '%' +
    '  uv err ' + v.uvStats.p50.toFixed(1) + '/' + v.uvStats.p95.toFixed(1) + ' tex' +
    '  open edges ' + (v.openEdges * 100).toFixed(1).padStart(4) + '%' +
    '  ' + (Date.now() - t0) + 'ms');
});
const outBytes = write(outFile, vehicles);
console.log('---');
console.log('wrote ' + outFile + '  ' + (outBytes / 1024).toFixed(1) + ' KB  +  ' +
  (texBytes / 1048576).toFixed(2) + ' MB of textures');
console.log('source ' + (beforeBytes / 1048576).toFixed(1) + ' MB / ' + beforeTris.toLocaleString('en-US') +
  ' tris  ->  ' + vehicles.reduce(function (s, v) { return s + v.idx.length / 3; }, 0).toLocaleString('en-US') + ' tris');
console.log('worst area kept ' + (worstArea * 100).toFixed(1) + '%   worst open edges ' + (worstOpen * 100).toFixed(1) +
  '%   worst uv error p95 ' + worstUv.toFixed(1) + ' texels of ' + TEXELS);
