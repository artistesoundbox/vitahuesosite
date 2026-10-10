/*
 * glb-inspect.js — offline helper (node tools/glb-inspect.js racegame/veh1.glb ...)
 *
 * Answers the questions that shape a driving game, rather than just "does it load":
 *   - how big is the file, how many triangles/vertices per mesh
 *   - what are the nodes called (are the wheels separate nodes we can spin?)
 *   - does it carry animation clips (a spinning wheel/engine loop we could just play?)
 *   - which axis does it face, and where is the ground plane (min.y)
 *   - what textures/materials ship inside
 *
 * Node-only, never shipped to the site — an authoring aid.
 */
const fs = require('fs');

function readGLB(path) {
  const buf = fs.readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + path);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  return { json, bytes: buf.length };
}

/* glTF accessor min/max are in mesh-local space; walk the hierarchy so the
   numbers we print are the ones a camera and a ground plane actually see. */
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

function triple(a) { return '[' + a.map(function (v) { return (Math.abs(v) < 1e-4 ? 0 : v).toFixed(3); }).join(', ') + ']'; }

function report(path) {
  const { json, bytes } = readGLB(path);
  const nodes = json.nodes || [];
  const meshes = json.meshes || [];
  const accessors = json.accessors || [];

  let verts = 0, tris = 0;
  meshes.forEach(function (m) {
    m.primitives.forEach(function (p) {
      const pos = accessors[p.attributes.POSITION];
      if (pos) verts += pos.count;
      const idx = p.indices != null ? accessors[p.indices] : null;
      tris += idx ? idx.count / 3 : (pos ? pos.count / 3 : 0);
    });
  });

  const world = new Array(nodes.length);
  function walk(i, parent) {
    const n = nodes[i];
    const local = n.matrix ? n.matrix.slice()
      : fromTRS(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
    const m = multiply(parent, local);
    world[i] = m;
    (n.children || []).forEach(function (c) { walk(c, m); });
  }
  (json.scenes[json.scene || 0] || { nodes: [] }).nodes.forEach(function (i) { walk(i, identity()); });

  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  const rows = [];
  nodes.forEach(function (n, i) {
    if (n.mesh == null) return;
    const mesh = meshes[n.mesh];
    const part = mesh.primitives.map(function (p) {
      const pos = accessors[p.attributes.POSITION];
      const idx = p.indices != null ? accessors[p.indices] : null;
      return {
        v: pos ? pos.count : 0,
        t: Math.round(idx ? idx.count / 3 : (pos ? pos.count / 3 : 0)),
        mat: p.material != null && json.materials ? (json.materials[p.material].name || '#' + p.material) : null
      };
    });
    const bLo = [1e9, 1e9, 1e9], bHi = [-1e9, -1e9, -1e9];
    mesh.primitives.forEach(function (p) {
      const a = accessors[p.attributes.POSITION];
      if (!a || !a.min) return;
      for (let bx = 0; bx < 2; bx++) for (let by = 0; by < 2; by++) for (let bz = 0; bz < 2; bz++) {
        const w = transform(world[i], [bx ? a.max[0] : a.min[0], by ? a.max[1] : a.min[1], bz ? a.max[2] : a.min[2]]);
        for (let k = 0; k < 3; k++) { if (w[k] < bLo[k]) bLo[k] = w[k]; if (w[k] > bHi[k]) bHi[k] = w[k]; }
      }
    });
    for (let k = 0; k < 3; k++) { if (bLo[k] < lo[k]) lo[k] = bLo[k]; if (bHi[k] > hi[k]) hi[k] = bHi[k]; }
    const center = [(bLo[0] + bHi[0]) / 2, (bLo[1] + bHi[1]) / 2, (bLo[2] + bHi[2]) / 2];
    rows.push('    ' + (n.name || '(unnamed)') +
      '  min' + triple(bLo) + ' max' + triple(bHi) +
      '  centre' + triple(center) +
      '  v=' + part.reduce(function (s, p) { return s + p.v; }, 0) +
      ' tris=' + part.reduce(function (s, p) { return s + p.t; }, 0) +
      (part.length > 1 ? ' [' + part.map(function (p) { return p.t + 'x' + (p.mat || '?'); }).join(' | ') + ']' : (part[0] && part[0].mat ? ' mat=' + part[0].mat : '')));
  });

  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const anims = (json.animations || []).map(function (a) {
    let dur = 0;
    a.samplers.forEach(function (s) {
      const acc = accessors[s.input];
      if (acc && acc.max) dur = Math.max(dur, acc.max[0]);
    });
    return a.name + ' (' + a.channels.length + ' channels, ' + dur.toFixed(2) + 's)';
  });
  const mats = (json.materials || []).map(function (m) { return m.name || '(unnamed)'; });
  const images = (json.images || []).map(function (im) { return im.name || im.mimeType || '(image)'; });

  console.log('=== ' + path + '   ' + (bytes / 1048576).toFixed(2) + ' MB');
  console.log('  nodes=' + nodes.length + '  meshes=' + meshes.length +
    '  verts=' + verts + '  tris=' + Math.round(tris));
  console.log('  world bbox  min' + triple(lo) + '  max' + triple(hi) + '  size' + triple(size));
  console.log('  animations: ' + (anims.length ? anims.join('; ') : 'none'));
  console.log('  materials:  ' + (mats.length ? mats.join(', ') : 'none'));
  console.log('  images:     ' + (images.length ? images.join(', ') : 'none'));
  console.log('  meshes (world space):');
  rows.forEach(function (r) { console.log(r); });
  const named = nodes.map(function (n) { return n.name; }).filter(Boolean);
  const wheels = named.filter(function (n) { return /wheel|tyre|tire|rim/i.test(n); });
  const parented = nodes.filter(function (n) { return (n.children || []).length; }).map(function (n) { return n.name; });
  console.log('  wheel-ish nodes: ' + (wheels.length ? wheels.join(', ') : 'NONE (wheel geometry is welded to the body)'));
  console.log('  nodes with children: ' + (parented.length ? parented.join(', ') : 'none (flat)'));
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log('usage: node tools/glb-inspect.js <model.glb> [more.glb ...]');
  process.exit(1);
}
args.forEach(report);
