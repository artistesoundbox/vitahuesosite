import bpy, os, sys

props = bpy.ops.export_scene.gltf.get_rna_type().properties
wanted = ['export_format', 'export_apply', 'export_yup', 'export_image_format',
          'export_image_quality', 'export_texcoords', 'export_normals', 'export_animations',
          'export_lights', 'export_cameras', 'export_extras', 'export_materials',
          'export_texture_dir', 'use_selection', 'export_original_specular',
          'export_keep_originals', 'export_gn_mesh', 'export_shared_accessors']
print("=== PROPS")
for w in wanted:
    print(w, 'YES' if w in props else 'no')
print("=== image format enum")
for p in props:
    if p.identifier == 'export_image_format':
        print([i.identifier for i in p.enum_items])
print("=== draco")
print([p.identifier for p in props if 'draco' in p.identifier][:12])

out = os.path.join(os.path.dirname(bpy.data.filepath), "tvroom.glb")
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format='GLB',
    export_apply=True,
    export_yup=True,
    export_image_format='JPEG',
    export_image_quality=80,
    export_texcoords=True,
    export_normals=True,
    export_animations=False,
    export_lights=False,
    export_cameras=False,
    export_materials='EXPORT',
    use_selection=False,
    export_extras=True,
)
print("=== EXPORTED", out, os.path.getsize(out))
