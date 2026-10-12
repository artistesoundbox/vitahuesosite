// Temporary: which bones does each file's idle clip actually animate?
import { readFileSync } from 'node:fs';
import * as THREE from './node_modules/three/build/three.module.js';

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {}, set src(_) {} }),
  createElement: () => ({ addEventListener() {}, removeEventListener() {}, style: {}, set src(_) {}, getContext: () => ({}) }),
};
const { FBXLoader } = await import('./node_modules/three/examples/jsm/loaders/FBXLoader.js');

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o.name); });
  console.log(`\n=== ${file.split(/[\\/]/).pop()} ===`);
  for (const clip of root.animations || []) {
    if (!clip.tracks.length) continue;
    const byBone = new Set(clip.tracks.map((t) => t.name.split('.')[0]));
    console.log(`clip ${clip.name}: ${clip.tracks.length} tracks over ${byBone.size} nodes, ${clip.duration.toFixed(2)}s`);
    const missing = bones.filter((b) => !byBone.has(b));
    console.log(`  animated: ${[...byBone].filter((n) => bones.includes(n)).length} of ${bones.length} bones`);
    console.log(`  NOT animated (sit at bind pose): ${missing.join(', ') || 'none'}`);
  }
}
