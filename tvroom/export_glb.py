"""
Rebuild tvroom.glb from tvroom.blend — the model the TV Room page renders.

    "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
        --background tvroom.blend --python export_glb.py

Everything except the room itself (camera, lights, the television's material)
is decided in js/room.js, so the export stays a plain, unlit model with its
packed textures as JPEG.
"""

import bpy
import os

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

print("EXPORTED", out, os.path.getsize(out), "bytes")
