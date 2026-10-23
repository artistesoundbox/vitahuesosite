import bpy, math
from mathutils import Vector

scn = bpy.context.scene
print("=== WORLD BBOXES")
for o in scn.objects:
    if o.type not in ('MESH', 'CAMERA', 'LIGHT'):
        continue
    mw = o.matrix_world
    if o.type == 'MESH':
        pts = [mw @ Vector(c) for c in o.bound_box]
        mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        print(f"{o.name[:38]:40} min=({mn.x:8.2f},{mn.y:8.2f},{mn.z:8.2f}) max=({mx.x:8.2f},{mx.y:8.2f},{mx.z:8.2f}) size=({mx.x-mn.x:7.2f},{mx.y-mn.y:7.2f},{mx.z-mn.z:7.2f})")
    elif o.type == 'CAMERA':
        d = mw.to_quaternion() @ Vector((0, 0, -1))
        print(f"CAMERA at {tuple(round(v,2) for v in mw.translation)} dir {tuple(round(v,3) for v in d)}")
    else:
        print(f"LIGHT {o.name} ({o.data.type}) at {tuple(round(v,2) for v in mw.translation)}")

print("=== overall mesh bounds")
allpts = []
for o in scn.objects:
    if o.type == 'MESH':
        mw = o.matrix_world
        allpts += [mw @ Vector(c) for c in o.bound_box]
mn = Vector((min(p.x for p in allpts), min(p.y for p in allpts), min(p.z for p in allpts)))
mx = Vector((max(p.x for p in allpts), max(p.y for p in allpts), max(p.z for p in allpts)))
print("min", [round(v,2) for v in mn], "max", [round(v,2) for v in mx], "size", [round(v,2) for v in (mx-mn)])

print("=== plane.005 details")
p = bpy.data.objects['Plane.005']
for v in p.data.vertices:
    print("v", [round(c,3) for c in (p.matrix_world @ v.co)])
print("normals", [[round(n,3) for n in poly.normal] for poly in p.data.polygons])
print("uv layers", [l.name for l in p.data.uv_layers])
print("=== material.005")
m = bpy.data.materials['Material.005']
for n in m.node_tree.nodes:
    print(n.type, n.name)
    if n.type == 'BSDF_PRINCIPLED':
        for inp in n.inputs:
            if not inp.is_linked and hasattr(inp, 'default_value'):
                try:
                    print("   ", inp.name, inp.default_value if not hasattr(inp.default_value, '__len__') else list(inp.default_value))
                except Exception:
                    pass
print("=== world")
w = scn.world
if w.use_nodes:
    for n in w.node_tree.nodes:
        print(n.type, getattr(n.inputs.get('Color'), 'default_value', None) if n.type=='BACKGROUND' else '')
