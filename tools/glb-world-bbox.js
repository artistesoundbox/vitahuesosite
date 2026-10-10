/*
 * glb-world-bbox.js — offline helper (node tools/glb-world-bbox.js <file.glb> ...)
 *
 * glTF accessor min/max are in each MESH's own space, which is useless for
 * working out which way a model faces once Sketchfab's rotation/scale nodes
 * are in play. This walks the node hierarchy, composes the world matrices and
 * prints each mesh's world-space bounding box, so "where is the eye mesh
 * relative to the body?" becomes answerable.
 *
 * Not used by the site — a one-off authoring aid, kept for the next model.
 */
const fs = require('fs');

function identity() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }

function multiply(a, b) {
  const out = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
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

function transform(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}

function readGLB(path) {
  const buf = fs.readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
}

function report(path) {
  const json = readGLB(path);
  const nodes = json.nodes || [];
  const world = new Array(nodes.length);
  const sceneNodes = (json.scenes[json.scene || 0] || { nodes: [] }).nodes;

  function walk(i, parentMatrix) {
    const n = nodes[i];
    const local = n.matrix
      ? n.matrix.slice()
      : fromTRS(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
    const m = multiply(parentMatrix, local);
    world[i] = m;
    (n.children || []).forEach(function (c) { walk(c, m); });
  }

  sceneNodes.forEach(function (i) { walk(i, identity()); });

  console.log('=== ' + path);
  nodes.forEach(function (n, i) {
    if (n.mesh == null) return;
    const mesh = json.meshes[n.mesh];
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    mesh.primitives.forEach(function (p) {
      const a = json.accessors[p.attributes.POSITION];
      if (!a || !a.min) return;
      for (let bx = 0; bx < 2; bx++) {
        for (let by = 0; by < 2; by++) {
          for (let bz = 0; bz < 2; bz++) {
            const w = transform(world[i], [
              bx ? a.max[0] : a.min[0],
              by ? a.max[1] : a.min[1],
              bz ? a.max[2] : a.min[2]
            ]);
            for (let k = 0; k < 3; k++) {
              if (w[k] < lo[k]) lo[k] = w[k];
              if (w[k] > hi[k]) hi[k] = w[k];
            }
          }
        }
      }
    });
    const f = function (v) { return v.toFixed(2); };
    console.log('  ' + (n.name || '(unnamed)') +
      '  X[' + f(lo[0]) + ',' + f(hi[0]) + ']' +
      ' Y[' + f(lo[1]) + ',' + f(hi[1]) + ']' +
      ' Z[' + f(lo[2]) + ',' + f(hi[2]) + ']');
  });
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log('usage: node tools/glb-world-bbox.js <model.glb> [more.glb ...]');
  process.exit(1);
}
args.forEach(report);
