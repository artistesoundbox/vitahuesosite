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
 * The UV part of the cell key is calibrated, not guessed: the base-colour
 * texture spans roughly the model's canonical width, so a UV bucket of 1/res
 * is about the same size on the surface as the position cell, and a merge
 * moves a vertex by at most half a cell in both. Buckets finer than the
 * position cell would stop any merging at all (a 1-texel key is as good as no
 * decimation); coarser ones are what lets two unrelated islands weld and their
 * paint average into a smear, so the key is clamped to never be coarser.
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

/* Finest UV bucket used in the cluster key. The effective bucket is
   max(UV_RES, res) — see the note in the header for why it tracks the grid. */
const UV_RES = 64;

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

/* Every mesh, baked into one triangle soup in model space. UVs ride along. */
function soup(file) {
  const { json, bin } = readGLB(file);
  const world = nodeMatrices(json);
  const positions = [];
  const uvs = [];
  const indices = [];
  let vertBase = 0;
  let sawUv = false;

  (json.nodes || []).forEach(function (n, ni) {
    if (n.mesh == null) return;
    const m = world[ni] || identity();
    (json.meshes[n.mesh].primitives || []).forEach(function (p) {
      if (p.attributes.POSITION == null) return;
      const pos = readAccessor(json, bin, p.attributes.POSITION);
      const uv = p.attributes.TEXCOORD_0 != null ? readAccessor(json, bin, p.attributes.TEXCOORD_0) : null;
      if (uv) sawUv = true;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.array[i * 3], y = pos.array[i * 3 + 1], z = pos.array[i * 3 + 2];
        positions.push(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14]
        );
        if (uv) uvs.push(uv.array[i * 2], uv.array[i * 2 + 1]);
        else uvs.push(0, 0);
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
    indices: Uint32Array.from(indices),
    sawUv: sawUv
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
   The cell key carries the UV as well as the position: a position-only key
   welds vertices that sit either side of a texture seam and smears the paint
   across the whole hull. */
function cluster(positions, uvs, indices, res) {
  const b = bounds(positions);
  const size = [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]];
  const longest = Math.max(size[0], size[1], size[2], 1e-6);
  const cell = longest / res;
  /* the UV bucket has to be at least as fine as the position cell, or two
     patches of the atlas that are 20 texels apart weld together */
  const uvRes = Math.max(UV_RES, res);
  const nx = Math.max(1, Math.ceil(size[0] / cell) + 1);
  const ny = Math.max(1, Math.ceil(size[1] / cell) + 1);

  const n = positions.length / 3;
  const remap = new Int32Array(n);
  const map = new Map();
  const sums = [];   // [sx, sy, sz, count, su, sv]
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const u = uvs[i * 2], v = uvs[i * 2 + 1];
    const ix = Math.min(nx - 1, Math.floor((x - b.lo[0]) / cell));
    const iy = Math.min(ny - 1, Math.floor((y - b.lo[1]) / cell));
    const iz = Math.floor((z - b.lo[2]) / cell);
    /* rounded, not floored: a UV of exactly 0 or 1 must not land in a thin
       extra cell of its own, and negative UVs must stay distinct from small
       positive ones (wrapping happens at sample time, not here) */
    const iu = Math.round(u * uvRes);
    const iv = Math.round(v * uvRes);
    const key = ix + ',' + iy + ',' + iz + ',' + iu + ',' + iv;
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
    remap[i] = id;
  }

  const vertCount = sums.length / 6;
  const outPos = new Float32Array(vertCount * 3);
  const outUv = new Float32Array(vertCount * 2);
  for (let i = 0; i < vertCount; i++) {
    const c = sums[i * 6 + 3];
    outPos[i * 3] = sums[i * 6] / c;
    outPos[i * 3 + 1] = sums[i * 6 + 1] / c;
    outPos[i * 3 + 2] = sums[i * 6 + 2] / c;
    outUv[i * 2] = sums[i * 6 + 4] / c;
    outUv[i * 2 + 1] = sums[i * 6 + 5] / c;
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
  return { positions: outPos, uvs: outUv, indices: Uint32Array.from(outIdx), vertCount };
}

/* Search the grid resolution that lands closest to the triangle budget. */
function decimate(positions, uvs, indices, targetTris) {
  let lo = 2, hi = 200, best = null;
  for (let step = 0; step < 9; step++) {
    const mid = Math.round((lo + hi) / 2);
    const r = cluster(positions, uvs, indices, mid);
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

function build(file, outDir, stem, target) {
  const { json, bin } = readGLB(file);
  const raw = soup(file);
  const dim = canonicalise(raw.positions);
  const dec = decimate(raw.positions, raw.uvs, raw.indices, target);
  const pos = dec.r.positions;
  const idx = dec.r.indices;
  const tex = dumpTexture(file, json, bin, outDir, stem);
  return {
    pos: pos, idx: idx, uv: dec.r.uvs, nrm: normals(pos, idx),
    dim: dim, before: raw.indices.length / 3, after: idx.length / 3,
    res: dec.res, sawUv: raw.sawUv, tex: tex
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
if (args.length < 3) {
  console.log('usage: node tools/glb-decimate.js <out.bin> <model.glb> [more.glb ...]');
  process.exit(1);
}
const outFile = args[0];
const outDir = path.dirname(outFile) || '.';
/* 8,000 triangles was a budget for a hull that was only ever a glowing ASCII
   silhouette. The plain 3D view is the game now, and at a 4-unit hull the
   paint is the whole point — the decimation error still lands sub-pixel but
   the *mapping* is what suffers, because clustering also moves the UVs. 16,000
   halves that without becoming a download. */
const target = 16000;
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
  console.log(name.padEnd(6) +
    ' tris ' + String(v.before).padStart(7) + ' -> ' + String(v.after).padStart(5) +
    '  verts ' + String(v.pos.length / 3).padStart(5) +
    '  grid ' + String(v.res).padStart(3) +
    '  uv ' + (v.sawUv ? 'yes' : 'NO') +
    '  tex ' + (v.tex ? v.tex.name + ' (' + (v.tex.bytes / 1024).toFixed(0) + ' KB)' : 'none') +
    '  dims ' + v.dim.map(function (d) { return d.toFixed(3); }).join(' x ') +
    '  ' + (Date.now() - t0) + 'ms');
});
const outBytes = write(outFile, vehicles);
console.log('---');
console.log('wrote ' + outFile + '  ' + (outBytes / 1024).toFixed(1) + ' KB  +  ' +
  (texBytes / 1048576).toFixed(2) + ' MB of textures');
console.log('source ' + (beforeBytes / 1048576).toFixed(1) + ' MB / ' + beforeTris.toLocaleString('en-US') +
  ' tris  ->  ' + vehicles.reduce(function (s, v) { return s + v.idx.length / 3; }, 0).toLocaleString('en-US') + ' tris');
