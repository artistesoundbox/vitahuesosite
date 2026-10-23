import bpy, math, os, sys

scn = bpy.context.scene
scn.render.engine = 'BLENDER_WORKBENCH'
scn.render.resolution_x = 960
scn.render.resolution_y = 540
scn.render.resolution_percentage = 100
scn.display.shading.light = 'STUDIO'
scn.display.shading.color_type = 'TEXTURE'
scn.display.shading.show_shadows = True
scn.render.film_transparent = False

out = os.path.join(os.path.dirname(bpy.data.filepath), "_preview")
os.makedirs(out, exist_ok=True)

def render(name):
    scn.render.filepath = os.path.join(out, name + ".png")
    bpy.ops.render.render(write_still=True)
    print("RENDERED", scn.render.filepath)

# 1. Scene camera as authored
render("camera")

# 2. Look at the TV (Plane.005) from a few metres in front of it
tv = bpy.data.objects.get("Plane.005")
print("TV world loc", [round(v, 3) for v in tv.matrix_world.translation])
print("TV matrix", [[round(v, 3) for v in row] for row in tv.matrix_world])

cam_data = bpy.data.cameras.new("InspectCam")
cam = bpy.data.objects.new("InspectCam", cam_data)
scn.collection.objects.link(cam)
cam_data.lens = 24
scn.camera = cam

views = {
    "tv_from_room": ((-2.0, 3.5, 6.5), (math.radians(90), 0, math.radians(-90))),
    "room_wide": ((10.0, 12.0, 8.0), (math.radians(78), 0, math.radians(200))),
    "room_wide2": ((0.0, 14.0, 9.0), (math.radians(80), 0, math.radians(180))),
    "room_center": ((0.0, 0.0, 7.0), (math.radians(90), 0, math.radians(90))),
}
for name, (loc, rot) in views.items():
    cam.location = loc
    cam.rotation_euler = rot
    render(name)
