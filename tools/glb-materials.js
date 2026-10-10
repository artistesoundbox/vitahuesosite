/*
 * glb-materials.js — offline helper (node tools/glb-materials.js racegame/veh1.glb ...)
 *
 * Before re-adding textures to the decimated race vehicles, this answers the
 * only questions that matter for the bake:
 *   - how many materials/primitives are there, and what does each reference?
 *   - do the primitives carry TEXCOORD_0 (without UVs a texture is unusable)?
 *   - how big is each embedded image, and is it PNG or JPEG?
 *   - is there a baseColorFactor (a flat colour is free and always available)?
 *   - what range does TEXCOORD_0 cover, and which wrap mode does the sampler
 *     ask for? UVs outside 0..1 sampled with ClampToEdge are what "the texture
 *     looks distorted" usually turns out to be: the edge row of texels gets
 *     stretched across the whole surface as streaks.
 *   - what are the image's real pixel dimensions (read from the file header)?
 *     A 512-wide livery on an 8,000-triangle hull is a smeared livery, and
 *     that is a budget question, not a mapping bug.
 *
 * Not used by the site — an authoring aid, like glb-inspect.js.
 */
const fs = require('fs');

/* The GLB's BIN chunk, so an accessor can actually be read here. The JSON
   chunk's length only tells us where it ends, not where the BIN starts. */
function readGLB(path) {
  const buf = fs.readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + path);
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  return { json, bin, bytes: buf.length };
}

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const COMP_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const ITEMS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

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
    for (let e = 0; e < a.count; e++) out.set(new TA(bin.buffer, bin.byteOffset + base + e * stride, itemSize), e * itemSize);
  }
  return out;
}

const WRAP = ['CLAMP_TO_EDGE', 'MIRRORED_REPEAT', 'REPEAT'];

/* Pixel dimensions straight out of the file header — no decoding needed. */
function imageSize(bytes, mime) {
  if (mime === 'image/png' && bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (mime === 'image/jpeg' && bytes.length > 4 && bytes.readUInt16BE(0) === 0xffd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) { o++; continue; }
      const marker = bytes[o + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return [bytes.readUInt16BE(o + 7), bytes.readUInt16BE(o + 5)];  // width, height
      }
      o += 2 + bytes.readUInt16BE(o + 2);
    }
  }
  return null;
}

function colourOf(f) {
  if (!f) return null;
  return '#' + f.slice(0, 3).map(function (v) {
    return Math.round(Math.min(1, Math.pow(v, 1 / 2.2)) * 255).toString(16).padStart(2, '0');
  }).join('');
}

const args = process.argv.slice(2);
args.forEach(function (path) {
  const { json, bin, bytes } = readGLB(path);
  console.log('=== ' + path + '   ' + (bytes / 1048576).toFixed(2) + ' MB');
  console.log('  images: ' + (json.images || []).length + '   textures: ' + (json.textures || []).length +
    '   materials: ' + (json.materials || []).length);

  let imgBytes = 0;
  (json.images || []).forEach(function (im, i) {
    const bv = im.bufferView != null ? json.bufferViews[im.bufferView] : null;
    const len = bv ? bv.byteLength : 0;
    imgBytes += len;
    let px = '';
    if (bv) {
      const slice = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + len);
      const size = imageSize(slice, im.mimeType);
      if (size) px = '  ' + size[0] + 'x' + size[1] + 'px';
    }
    console.log('    image[' + i + '] ' + (im.name || '(unnamed)') + '  ' + (im.mimeType || '?') +
      '  ' + (len / 1024).toFixed(1) + ' KB' + px);
  });

  (json.samplers || []).forEach(function (s, i) {
    console.log('    sampler[' + i + ']  wrapS=' + (WRAP[s.wrapS] || s.wrapS || 'REPEAT(default)') +
      '  wrapT=' + (WRAP[s.wrapT] || s.wrapT || 'REPEAT(default)') +
      '  mag=' + (s.magFilter || 'linear') + '  min=' + (s.minFilter || 'linear-mipmap'));
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
        '  tris=' + (pr.indices != null ? Math.round(accessors[pr.indices].count / 3) : '?') +
        (pr.attributes.TEXCOORD_0 != null ? '  ' + uvRange(json, bin, pr.attributes.TEXCOORD_0) : '  UV=NONE'));
    });
  });
});

/* Which part of the atlas a primitive actually samples, and whether it needs
   the wrap mode at all. "tiles" is the number of whole texture widths the UVs
   span: above 1 the mapping is a repeating pattern and ClampToEdge streaks. */
function uvRange(json, bin, index) {
  const uv = readAccessor(json, bin, index);
  let uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity;
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i], v = uv[i + 1];
    if (u < uLo) uLo = u; if (u > uHi) uHi = u;
    if (v < vLo) vLo = v; if (v > vHi) vHi = v;
  }
  const outside = (uLo < 0 || uHi > 1 || vLo < 0 || vHi > 1);
  return 'UV u[' + uLo.toFixed(3) + ',' + uHi.toFixed(3) + '] v[' + vLo.toFixed(3) + ',' + vHi.toFixed(3) +
    '] span(' + (uHi - uLo).toFixed(2) + 'x' + (vHi - vLo).toFixed(2) + ')' +
    (outside ? '  OUTSIDE 0..1 — needs REPEAT' : '  inside 0..1');
}
