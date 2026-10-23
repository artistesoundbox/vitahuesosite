import bpy, sys, json, os

scn = bpy.context.scene
print("=== SCENE:", scn.name)
print("render engine:", scn.render.engine, "res:", scn.render.resolution_x, scn.render.resolution_y)
print("world:", scn.world.name if scn.world else None)
print("camera:", scn.camera.name if scn.camera else None)

objs = []
for o in scn.objects:
    d = {
        "name": o.name,
        "type": o.type,
        "parent": o.parent.name if o.parent else None,
        "loc": [round(v, 4) for v in o.location],
        "rot": [round(v, 4) for v in o.rotation_euler],
        "scale": [round(v, 4) for v in o.scale],
        "dims": [round(v, 4) for v in o.dimensions],
        "mats": [m.name for m in o.data.materials] if getattr(o.data, "materials", None) else [],
        "hide_render": o.hide_render,
        "visible": o.visible_get(),
    }
    if o.type == "CAMERA":
        d["cam"] = {"lens": o.data.lens, "type": o.data.type, "sensor": o.data.sensor_width}
    if o.type == "LIGHT":
        d["light"] = {"kind": o.data.type, "energy": o.data.energy, "color": list(o.data.color)}
    if o.type == "MESH":
        d["verts"] = len(o.data.vertices)
        d["polys"] = len(o.data.polygons)
    objs.append(d)

print("=== OBJECTS", len(objs))
print(json.dumps(objs, indent=1))

print("=== MATERIALS")
for m in bpy.data.materials:
    info = {"name": m.name, "nodes": m.use_nodes}
    if m.use_nodes:
        info["node_types"] = [n.type for n in m.node_tree.nodes]
        info["images"] = [n.image.filepath for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image]
    print(json.dumps(info))

print("=== IMAGES")
for i in bpy.data.images:
    print(i.name, i.filepath, i.source, i.size[:], "packed" if i.packed_file else "")

print("=== COLLECTIONS")
for c in bpy.data.collections:
    print(c.name, [o.name for o in c.objects])

print("=== CUSTOM PROPS / TEXT")
for t in bpy.data.texts:
    print("TEXT:", t.name, len(t.as_string()))

print("=== WORLD NODES")
if scn.world and scn.world.use_nodes:
    for n in scn.world.node_tree.nodes:
        print(n.type, n.name, getattr(n, "image", None))
