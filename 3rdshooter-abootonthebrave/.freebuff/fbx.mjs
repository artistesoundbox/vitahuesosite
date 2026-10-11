import fs from 'fs';

function parseFBX(file) {
  const b = fs.readFileSync(file);
  const magic = b.slice(0, 20).toString('latin1');
  if (magic !== 'Kaydara FBX Binary  ') return { error: 'not binary fbx' };
  const version = b.readUInt32LE(23);
  const wide = version >= 7500;
  let pos = 27;

  // property size table for 7500+
  const propSizes = [];
  if (wide) {
    pos += 12; // 3 x uint32 zeros
    const n = b.readUInt32LE(pos); pos += 4;
    for (let i = 0; i < n; i++) { propSizes.push(b.readUInt8(pos)); pos++; }
    pos += 4; // terminator? (some files have 4 bytes)
  }

  function readProp() {
    let type;
    if (wide) type = b.readUInt8(pos++);
    else { type = b[pos]; pos += 1; }
    switch (String.fromCharCode(type)) {
      case 'Y': { const v = b.readInt16LE(pos); pos += 2; return v; }
      case 'C': { const v = b[pos]; pos += 1; return v; }
      case 'I': { const v = b.readInt32LE(pos); pos += 4; return v; }
      case 'F': { const v = b.readFloatLE(pos); pos += 4; return v; }
      case 'D': { const v = b.readDoubleLE(pos); pos += 8; return v; }
      case 'L': { const v = wide ? Number(b.readBigInt64LE(pos)) : b.readInt32LE(pos); pos += wide ? 8 : 4; return v; }
      case 'S': case 'R': {
        const len = b.readUInt32LE(pos); pos += 4;
        const v = b.slice(pos, pos + len).toString(len && b[pos + len - 1] === 0 ? 'latin1' : 'utf8');
        pos += len; return v;
      }
      default: {
        const len = b.readUInt32LE(pos); pos += 4;
        const enc = b.readUInt32LE(pos); pos += 4;
        const compLen = b.readUInt32LE(pos); pos += 4;
        pos += compLen;
        return { array: true, enc, compLen, type: String.fromCharCode(type) };
      }
    }
  }

  function readNode(depth) {
    let endOffset, numProps, propListLen;
    if (wide) {
      endOffset = Number(b.readBigUInt64LE(pos)); pos += 8;
      numProps = Number(b.readBigUInt64LE(pos)); pos += 8;
      propListLen = Number(b.readBigUInt64LE(pos)); pos += 8;
    } else {
      endOffset = b.readUInt32LE(pos); pos += 4;
      numProps = b.readUInt32LE(pos); pos += 4;
      propListLen = b.readUInt32LE(pos); pos += 4;
    }
    const nameLen = b.readUInt8(pos); pos += 1;
    const name = b.slice(pos, pos + nameLen).toString('latin1'); pos += nameLen;
    if (endOffset === 0 && numProps === 0 && nameLen === 0) return null; // null record
    const props = [];
    for (let i = 0; i < numProps; i++) props.push(readProp());
    if (endOffset > pos) {
      while (pos < endOffset - (wide ? 25 : 13)) {
        const child = readNode(depth + 1);
        if (!child) break;
        addChild(child, depth + 1);
      }
    }
    pos = endOffset;
    return { name, props, children: [] };
  }

  const roots = [];
  const tree = {};
  function addChild(node, depth) {
    roots.push({ node, depth });
  }

  while (pos < b.length) {
    const before = pos;
    const n = readNode(0);
    if (!n) break;
    roots.push({ node: n, depth: 0 });
    if (pos <= before) break;
  }

  const find = (name) => roots.filter(r => r.node.name === name);

  const objects = roots.find(r => r.node.name === 'Objects');
  const summary = {};
  if (objects) {
    for (const r of roots) {
      if (!r.node.name) continue;
      if (r.depth === 1 && r.node.parent === objects.node) {}
    }
    // count direct children of Objects
    const kids = collectChildren(objects.node);
    const counts = {};
    for (const k of kids) counts[k.name] = (counts[k.name] || 0) + 1;
    summary.objects = counts;
  }
  function collectChildren(node) {
    const out = [];
    for (const r of roots) {
      if (r.node.parent === node) out.push(r.node);
    }
    return out;
  }
  // fix: assign parents during build
  return { version, wide, summary, nodeNames: roots.filter(r => r.depth <= 2).map(r => '  '.repeat(r.depth) + r.node.name) };
}

// rebuild with parent tracking
function parseFBX2(file) {
  const b = fs.readFileSync(file);
  if (b.slice(0, 20).toString('latin1') !== 'Kaydara FBX Binary  ') return { error: 'not binary fbx' };
  const version = b.readUInt32LE(23);
  const wide = version >= 7500;
  let pos = 27;
  if (wide) {
    pos += 12;
    const n = b.readUInt32LE(pos); pos += 4;
    pos += n + 4;
  }
  function readProp() {
    const type = String.fromCharCode(b[pos]); pos += 1;
    switch (type) {
      case 'Y': { const v = b.readInt16LE(pos); pos += 2; return v; }
      case 'C': { const v = b[pos]; pos += 1; return v; }
      case 'I': { const v = b.readInt32LE(pos); pos += 4; return v; }
      case 'F': { const v = b.readFloatLE(pos); pos += 4; return v; }
      case 'D': { const v = b.readDoubleLE(pos); pos += 8; return v; }
      case 'L': { const v = wide ? Number(b.readBigInt64LE(pos)) : b.readInt32LE(pos); pos += wide ? 8 : 4; return v; }
      case 'S': case 'R': { const len = b.readUInt32LE(pos); pos += 4; const v = b.slice(pos, pos + len).toString('latin1'); pos += len; return v; }
      default: { const len = b.readUInt32LE(pos); pos += 4; const enc = b.readUInt32LE(pos); pos += 4; const compLen = b.readUInt32LE(pos); pos += 4; pos += compLen; return { array: type, enc, compLen }; }
    }
  }
  function readNode(depth, parent) {
    let endOffset, numProps;
    if (wide) { endOffset = Number(b.readBigUInt64LE(pos)); pos += 8; numProps = Number(b.readBigUInt64LE(pos)); pos += 8; pos += 8; }
    else { endOffset = b.readUInt32LE(pos); pos += 4; numProps = b.readUInt32LE(pos); pos += 4; pos += 4; }
    const nameLen = b.readUInt8(pos); pos += 1;
    if (nameLen === 0) { return null; }
    const name = b.slice(pos, pos + nameLen).toString('latin1'); pos += nameLen;
    const node = { name, props: [], children: [], parent };
    for (let i = 0; i < numProps; i++) node.props.push(readProp());
    while (pos < endOffset) {
      const child = readNode(depth + 1, node);
      if (!child) { pos = endOffset; break; }
      node.children.push(child);
    }
    pos = endOffset;
    return node;
  }
  const roots = [];
  while (pos < b.length - 1) {
    const before = pos;
    const n = readNode(0, null);
    if (!n) break;
    roots.push(n);
    if (pos <= before) break;
  }
  const objects = roots.flatMap(r => r.children).find(c => c.name === 'Objects');
  let objCounts = {};
  if (objects) for (const c of objects.children) objCounts[c.name] = (objCounts[c.name] || 0) + 1;
  // dig into Geometry + Deformer
  let geometryTypes = new Set();
  if (objects) for (const c of objects.children) if (c.name === 'Geometry') geometryTypes.add(c.props[2] || 'unknown');
  const modelNames = objects ? objects.children.filter(c => c.name === 'Model').map(c => c.props[1]).slice(0, 6) : [];
  return { version, wide, objCounts, geometryTypes: [...geometryTypes], modelCount: objCounts.Model || 0, geometryCount: objCounts.Geometry || 0, modelNames };
}

for (const f of fs.readdirSync('.').filter(x => x.toLowerCase().endsWith('.fbx'))) {
  console.log('==', f, '==');
  try { console.log(' ', JSON.stringify(parseFBX2(f))); } catch (e) { console.log('  ERROR', e.message); }
}
