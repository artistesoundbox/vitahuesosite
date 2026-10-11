import fs from 'fs';

function glbJson(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546C67) return { error: 'not glb' };
  const total = b.readUInt32LE(8);
  let off = 12, json = null;
  while (off < total) {
    const len = b.readUInt32LE(off);
    const type = b.readUInt32LE(off + 4);
    if (type === 0x4E4F534A) { json = JSON.parse(b.slice(off + 8, off + 8 + len).toString('utf8')); break; }
    off += 12 + len;
  }
  return json;
}

for (const f of fs.readdirSync('.').filter(x => x.endsWith('.glb'))) {
  const j = glbJson(f);
  if (j.error) { console.log(f, j.error); continue; }
  const nodes = j.nodes || [];
  const skins = (j.skins || []).map(s => ({ name: s.name, joints: s.joints.length }));
  const anims = (j.animations || []).map(a => a.name);
  const meshes = (j.meshes || []).map(m => m.name);
  const mats = (j.materials || []).map(m => m.name);
  const tex = (j.textures || []).length;
  console.log('==', f, '==');
  console.log('  generator:', j.asset?.generator, '| nodes:', nodes.length, '| meshes:', meshes.length, '| skins:', JSON.stringify(skins), '| textures:', tex);
  console.log('  meshes:', meshes.slice(0, 12).join(', '));
  console.log('  materials:', mats.slice(0, 12).join(', '));
  console.log('  animations:', anims.length ? anims.join(', ') : '(none)');
  const jointNames = skins[0] ? (j.skins[0].joints.map(i => nodes[i]?.name)) : [];
  console.log('  first joints:', jointNames.slice(0, 8).join(', '));
  console.log('  root-ish nodes:', nodes.filter(n => n.mesh === undefined).slice(0, 6).map(n => n.name).join(', '));
}

for (const f of fs.readdirSync('.').filter(x => x.toLowerCase().endsWith('.fbx'))) {
  const s = fs.readFileSync(f).toString('latin1');
  const stacks = [...s.matchAll(/AnimationStack::([\w:]+)/g)].map(m => m[1]);
  const models = [...s.matchAll(/Model::([\w:]+)/g)].map(m => m[1]);
  const hasMixamo = s.includes('mixamorig');
  const mixes = new Set((s.match(/(mixamorig[A-Za-z0-9_]*)/g) || []));
  const uniqueModels = [...new Set(models)];
  console.log('==', f, '==');
  console.log('  stacks:', [...new Set(stacks)].join(', ') || '(none)');
  console.log('  mixamo bones:', hasMixamo, '| sample bones:', [...mixes].slice(0, 6).join(', '));
  console.log('  model count:', uniqueModels.length, '| sample:', uniqueModels.slice(0, 8).join(', '));
  console.log('  embedded media (Video/Content):', /Video::/.test(s), '| version:', (s.match(/FBXVersion:\s*(\d+)/) || [])[1]);
}
