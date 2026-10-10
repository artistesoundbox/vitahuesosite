/*
 * glb-materials.js — offline helper (node tools/glb-materials.js racegame/veh1.glb ...)
 *
 * Before re-adding textures to the decimated race vehicles, this answers the
 * only questions that matter for the bake:
 *   - how many materials/primitives are there, and what does each reference?
 *   - do the primitives carry TEXCOORD_0 (without UVs a texture is unusable)?
 *   - how big is each embedded image, and is it PNG or JPEG?
 *   - is there a baseColorFactor (a flat colour is free and always available)?
 *
 * Not used by the site — an authoring aid, like glb-inspect.js.
 */
const fs = require('fs');

function readGLB(path) {
  const buf = fs.readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  return { json, bytes: buf.length };
}

function colourOf(f) {
  if (!f) return null;
  return '#' + f.slice(0, 3).map(function (v) {
    return Math.round(Math.min(1, Math.pow(v, 1 / 2.2)) * 255).toString(16).padStart(2, '0');
  }).join('');
}

const args = process.argv.slice(2);
args.forEach(function (path) {
  const { json, bytes } = readGLB(path);
  console.log('=== ' + path + '   ' + (bytes / 1048576).toFixed(2) + ' MB');
  console.log('  images: ' + (json.images || []).length + '   textures: ' + (json.textures || []).length +
    '   materials: ' + (json.materials || []).length);

  let imgBytes = 0;
  (json.images || []).forEach(function (im, i) {
    const bv = im.bufferView != null ? json.bufferViews[im.bufferView] : null;
    const len = bv ? bv.byteLength : 0;
    imgBytes += len;
    /* a PNG/JPEG header tells us the pixel size without decoding anything */
    let px = '';
    if (bv && im.mimeType === 'image/png') {
      const off = 20 + json.bufferViews[im.bufferView].byteOffset + 12;   // past the file header chunk
      /* the GLB's JSON chunk sits before the BIN chunk; find it properly below */
      px = '';
    }
    console.log('    image[' + i + '] ' + (im.name || '(unnamed)') + '  ' + (im.mimeType || '?') +
      '  ' + (len / 1024).toFixed(1) + ' KB');
  });
  console.log('  total image bytes: ' + (imgBytes / 1048576).toFixed(2) + ' MB');

  const accessors = json.accessors || [];
  (json.materials || []).forEach(function (m, i) {
    const p = m.pbrMetallicRoughness || {};
    const base = p.baseColorTexture ? p.baseColorTexture.index : null;
    const baseImg = base != null && json.textures[base] ? json.textures[base].source : null;
    console.log('    material[' + i + '] ' + (m.name || '(unnamed)') +
      '  baseColor=' + (baseImg != null ? 'image[' + baseImg + ']' : 'none') +
      '  factor=' + (colourOf(p.baseColorFactor) || 'default white') +
      '  metallic=' + (p.metallicFactor === undefined ? 1 : p.metallicFactor) +
      '  rough=' + (p.roughnessFactor === undefined ? 1 : p.roughnessFactor) +
      '  emissive=' + (m.emissiveFactor ? colourOf(m.emissiveFactor) : 'none') +
      (m.emissiveTexture ? ' emissiveTex=image[' + (json.textures[m.emissiveTexture.index] || {}).source + ']' : ''));
  });

  (json.meshes || []).forEach(function (mesh, mi) {
    console.log('    mesh[' + mi + '] ' + (mesh.name || '(unnamed)') + '  primitives=' + mesh.primitives.length);
    mesh.primitives.forEach(function (pr, pi) {
      console.log('      prim[' + pi + '] material=' + (pr.material != null ? pr.material : 'none') +
        '  attrs=' + Object.keys(pr.attributes).join(',') +
        '  tris=' + (pr.indices != null ? Math.round(accessors[pr.indices].count / 3) : '?'));
    });
  });
});
