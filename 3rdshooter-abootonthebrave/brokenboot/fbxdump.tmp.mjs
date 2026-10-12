// Temporary: dump what each officer FBX actually contains, using the same
// loader the game uses. Delete after reading.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as THREE from './node_modules/three/build/three.module.js';

globalThis.self = globalThis;
globalThis.window = globalThis;
if (!globalThis.document) {
  globalThis.document = {
    createElementNS: () => ({
      addEventListener() {}, removeEventListener() {}, style: {},
      set src(_) {}, get src() { return ''; },
    }),
    createElement: () => ({
      addEventListener() {}, removeEventListener() {}, style: {},
      set src(_) {}, get src() { return ''; },
      getContext: () => ({}), toDataURL: () => '',
    }),
  };
}
const { FBXLoader } = await import(
  pathToFileURL(new URL('./node_modules/three/examples/jsm/loaders/FBXLoader.js', import.meta.url).pathname).href
);

const files = process.argv.slice(2);
for (const file of files) {
  const buf = readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const t0 = Date.now();
  const root = new FBXLoader().parse(ab, '');
  root.updateMatrixWorld(true);
  console.log(`\n=== ${file} (${(buf.byteLength / 1048576).toFixed(1)} MiB, parsed in ${Date.now() - t0} ms) ===`);

  const bones = [];
  const meshes = [];
  root.traverse((o) => {
    if (o.isBone) bones.push(o.name);
    if (o.isMesh) meshes.push(o);
  });
  console.log(`bones: ${bones.length}`);
  console.log(`animations: ${(root.animations || []).map((a) => `${a.name}(${a.duration.toFixed(2)}s, ${a.tracks.length} tracks)`).join(', ') || 'none'}`);

  for (const m of meshes) {
    const box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    const geo = m.geometry;
    const sw = geo?.attributes?.skinWeight;
    const si = geo?.attributes?.skinIndex;
    let footVerts = 0;
    let footBox = null;
    let footRigid = 0;
    if (sw && si && m.skeleton) {
      const at = new THREE.Vector3();
      const fb = new THREE.Box3();
      for (let v = 0; v < geo.attributes.position.count; v += 1) {
        const w = [sw.getX(v), sw.getY(v), sw.getZ(v), sw.getW(v)];
        const slot = w.findIndex((x) => x > 1e-4);
        if (slot < 0) continue;
        const bone = m.skeleton.bones[si.getComponent(v, slot)];
        if (!bone || !/foot|toe|ankle/i.test(bone.name)) continue;
        footVerts += 1;
        if (w[slot] > 0.999 && w.filter((x) => x > 1e-4).length === 1) footRigid += 1;
        at.fromBufferAttribute(geo.attributes.position, v);
        m.localToWorld(at);
        fb.expandByPoint(at);
      }
      if (!fb.isEmpty()) footBox = fb.getSize(new THREE.Vector3());
    }
    console.log(`  mesh ${m.name || '(unnamed)'}  skinned=${Boolean(m.isSkinnedMesh)} verts=${geo?.attributes?.position?.count}`
      + `  bbox=${size.x.toFixed(3)}x${size.y.toFixed(3)}x${size.z.toFixed(3)}`
      + `  minY=${box.min.y.toFixed(3)} maxY=${box.max.y.toFixed(3)}`
      + `  materials=${(Array.isArray(m.material) ? m.material : [m.material]).filter(Boolean).length}`
      + `  texRefs=${(Array.isArray(m.material) ? m.material : [m.material]).filter((mm) => mm && Object.values(mm).some((x) => x && x.isTexture)).length}`);
    if (footVerts) console.log(`     foot-bound verts=${footVerts} (rigid=${footRigid}) foot bbox=${footBox.x.toFixed(3)}x${footBox.y.toFixed(3)}x${footBox.z.toFixed(3)}`);
  }
  const loose = meshes.filter((m) => !m.isSkinnedMesh);
  console.log(`loose non-skinned meshes: ${loose.length}${loose.length ? ` -> ${loose.map((m) => m.name).join(', ')}` : ''}`);
}
