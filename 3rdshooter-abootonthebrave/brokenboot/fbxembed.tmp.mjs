// Temporary: is the 110 MiB actually embedded textures? Compare the new FBX
// against the texture files that sit beside it.
import { readFileSync, readdirSync, statSync } from 'node:fs';

const fbx = readFileSync(process.argv[2]);
const dir = process.argv[3];
let total = 0;
for (const name of readdirSync(dir).filter((f) => /\.(png|jpg)$/i.test(f))) {
  const p = `${dir}/${name}`;
  const bytes = readFileSync(p);
  total += bytes.length;
  // Look for the file's own header+payload inside the FBX.
  const needle = bytes.subarray(0, 64);
  const at = fbx.indexOf(needle);
  console.log(`${name.padEnd(34)} ${(bytes.length / 1048576).toFixed(1)} MiB  ${at >= 0 ? `EMBEDDED at byte ${at}` : 'not embedded'}`);
}
console.log(`\nall PNG/JPG in the folder: ${(total / 1048576).toFixed(1)} MiB; the FBX is ${(fbx.length / 1048576).toFixed(1)} MiB`);
