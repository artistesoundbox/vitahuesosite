/*
 * glb-overlap.js — offline helper (node tools/glb-overlap.js racegame/veh1.glb ...)
 *
 * Answers the one question the mesh list cannot: are these meshes *parts* of
 * one object, or several copies of the same object stacked on top of each
 * other? A Sketchfab export that ships an LOD chain looks identical in a mesh
 * list — same material, overlapping bounding boxes — but baking all of it into
 * one soup draws five shells in the same place, and the decimation budget then
 * gets split five ways. The texture on the result z-fights with itself and the
 * hull reads as melted.
 *
 * Method: put every mesh's world-space vertices in a spatial hash at a
 * tolerance of 1% of the model's longest extent, then ask what fraction of
 * mesh A's sampled vertices have a vertex of mesh B within that tolerance.
 * Parts of one object share only a seam (a few percent); copies of the same
 * surface match nearly everywhere.
 *
 * Not used by the site — an authoring aid, like glb-inspect.js.
 */
const fs = require('fs');

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const COMP_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const ITEMS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function readGLB(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + file);
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  return { json, bin };
}

function readAccessor(json, bin, index) {
  const a = json.accessors[index];
  const bv = json.bufferViews[a.bufferView];
  const TA = COMPONENT[a.componentType];
  const itemSize = ITEMS[a.type];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || 0;
  const out = new TA(a.count * itemSize);
  if (!stride || stride === COMP_BYTES[a.componentType] * itemSize) {
    out.set(new TA(bin.buffer, bin.byteOffset + base, a.count * itemSize));
  } else {
    for (let e = 0; e < a.count; e++) out.set(new TA(bin.buffer, bin.byteOffset + base + e * stride, itemSize), e * itemSize);
  }
  return out;
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

/* Every mesh, as world-space vertices and a triangle count. */
function meshes(file) {
  const { json, bin } = readGLB(file);
  const nodes = json.nodes || [];
  const world = new Array(nodes.length);
  (function walk(i, parent) {
    const n = nodes[i] || {};
    const local = n.matrix ? n.matrix.slice()
      : fromTRS(n.translation || [0,0,0], n.rotation || [0,0,0,1], n.scale || [1,1,1]);
    const m = multiply(parent, local);
    world[i] = m;
    (n.children || []).forEach(function (c) { walk(c, m); });
  })(0, identity());
  /* the walk starts at node 0, but scenes can list several roots */
  (json.scenes[json.scene || 0] || { nodes: [] }).nodes.forEach(function (i, k) {
    if (k === 0) return;
    (function walk(j, parent) {
      const n = nodes[j] || {};
      const local = n.matrix ? n.matrix.slice()
        : fromTRS(n.translation || [0,0,0], n.rotation || [0,0,0,1], n.scale || [1,1,1]);
      const m = multiply(parent, local);
      world[j] = m;
      (n.children || []).forEach(function (c) { walk(c, m); });
    })(i, identity());
  });

  const out = [];
  nodes.forEach(function (n, ni) {
    if (n.mesh == null) return;
    const m = world[ni] || identity();
    (json.meshes[n.mesh].primitives || []).forEach(function (p) {
      if (p.attributes.POSITION == null) return;
      const pos = readAccessor(json, bin, p.attributes.POSITION);
      const tris = p.indices != null ? json.accessors[p.indices].count / 3 : pos.length / 9;
      const pts = [];
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        pts.push(m[0] * x + m[4] * y + m[8] * z + m[12],
                 m[1] * x + m[5] * y + m[9] * z + m[13],
                 m[2] * x + m[6] * y + m[10] * z + m[14]);
      }
      out.push({ name: n.name || (json.meshes[n.mesh].name || '(unnamed)'), tris: Math.round(tris), pts: pts });
    });
  });
  return out;
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log('usage: node tools/glb-overlap.js <model.glb> [more.glb ...]');
  process.exit(1);
}

args.forEach(function (file) {
  const list = meshes(file);
  const all = [Infinity, Infinity, Infinity].map(function () { return 0; });
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  list.forEach(function (m) {
    for (let i = 0; i < m.pts.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (m.pts[i + k] < lo[k]) lo[k] = m.pts[i + k];
        if (m.pts[i + k] > hi[k]) hi[k] = m.pts[i + k];
      }
    }
  });
  const longest = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const tol = longest * 0.01;
  const Q = Math.max(1e-6, tol);

  console.log('=== ' + file);
  console.log('  ' + list.length + ' meshes, ' + list.reduce(function (s, m) { return s + m.tris; }, 0).toLocaleString('en-US') +
    ' tris, longest extent ' + longest.toFixed(3) + '  match tolerance ' + tol.toFixed(4));

  /* one spatial hash per mesh, then a nearest-cell query for each sample */
  const hashes = list.map(function (m) {
    const h = new Map();
    for (let i = 0; i < m.pts.length; i += 3) {
      const key = Math.floor(m.pts[i] / Q) + ',' + Math.floor(m.pts[i + 1] / Q) + ',' + Math.floor(m.pts[i + 2] / Q);
      let arr = h.get(key);
      if (!arr) { arr = []; h.set(key, arr); }
      arr.push(m.pts[i], m.pts[i + 1], m.pts[i + 2]);
    }
    return h;
  });

  function covered(ai, bi) {
    const a = list[ai], h = hashes[bi];
    const step = Math.max(3, Math.floor(a.pts.length / 3 / 1500) * 3);
    let total = 0, hit = 0;
    for (let i = 0; i < a.pts.length; i += step) {
      const x = a.pts[i], y = a.pts[i + 1], z = a.pts[i + 2];
      total++;
      const cx = Math.floor(x / Q), cy = Math.floor(y / Q), cz = Math.floor(z / Q);
      let near = false;
      for (let dx = -1; dx <= 1 && !near; dx++) {
        for (let dy = -1; dy <= 1 && !near; dy++) {
          for (let dz = -1; dz <= 1 && !near; dz++) {
            const arr = h.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
            if (!arr) continue;
            for (let j = 0; j < arr.length; j += 3) {
              const d = Math.abs(arr[j] - x) + Math.abs(arr[j + 1] - y) + Math.abs(arr[j + 2] - z);
              if (d < tol * 1.5) { near = true; break; }
            }
          }
        }
      }
      if (near) hit++;
    }
    return hit / total;
  }

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const ab = covered(i, j), ba = covered(j, i);
      const verdict = Math.min(ab, ba) > 0.7 ? '  <== SAME SURFACE (duplicate/LOD)'
        : (Math.min(ab, ba) > 0.25 ? '  <== partly overlapping' : '');
      console.log('  ' + String(i).padStart(2) + ' ' + list[i].name.padEnd(24) + '->' +
        String(j).padStart(2) + ' ' + list[j].name.padEnd(24) +
        '  covered ' + (ab * 100).toFixed(0).padStart(3) + '% / ' + (ba * 100).toFixed(0).padStart(3) + '%' + verdict);
    }
  }
});
