import bpy, math, os
from mathutils import Vector

scn = bpy.context.scene
scn.render.engine = 'BLENDER_WORKBENCH'
scn.render.resolution_x = 800
scn.render.resolution_y = 450
scn.display.shading.light = 'STUDIO'
scn.display.shading.color_type = 'TEXTURE'
scn.display.shading.show_shadows = True

out = os.path.join(os.path.dirname(bpy.data.filepath), "_preview")
os.makedirs(out, exist_ok=True)

cam_data = bpy.data.cameras.new("SeatCam")
cam = bpy.data.objects.new("SeatCam", cam_data)
scn.collection.objects.link(cam)
cam_data.lens = 22
scn.camera = cam

target = Vector((-10.4, 3.7, 5.3))

def look_at(obj, target):
    d = target - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

seats = {
    "seat_a": (12.0, 8.0, 6.3),
    "seat_b": (8.0, 4.0, 6.3),
    "seat_c": (15.0, 11.0, 6.3),
    "seat_d": (18.5, 18.3, 6.5),
}
for name, loc in seats.items():
    cam.location = loc
    look_at(cam, target)
    scn.render.filepath = os.path.join(out, name + ".png")
    bpy.ops.render.render(write_still=True)
    print("RENDERED", name)
