#!/usr/bin/env python3
"""Bind the clean un_rendem123 tubby meshes to a donor armature and bake out every clip.

Run headless:
  blender --background --python tools/rig_transfer.py -- \
      --donor  assets/models/donor/dipsy \
      --skins  assets/models/skin \
      --out    assets/game/tubbies.glb

Why this works: every un_rendem123 tubby (po, laalaa, dipsy, tinkywinky, guardian) is the same
"Teletubbie Template" mesh with a different head aerial and texture - ~1600 verts, identical
topology. So one weight-transfer onto one donor skeleton skins all five, and all five can share
a single armature in a single GLB. At runtime you swap visibility, not skeletons.

THE THING THAT TOOK FOUR REWRITES TO GET RIGHT:

Blender's glTF exporter does NOT write skinned vertices in world space, or in the mesh's own
object space. It writes them in the ARMATURE's space, and writes inverse bind matrices to
match. So any placement you compute in world space is in the wrong frame, and the mesh lands
somewhere the skeleton is not - with correct bones, correct weights, a correct draw call, and
nothing visible on screen.

Worse, "helpfully" normalising the armature to unit scale first makes it much worse: applying
a 0.03125 object scale multiplies the bone rest data by 32, so the skeleton ends up spanning
~3600 units while the mesh sits at 0.1.

So do not compute a placement at all. The donor's OWN mesh is already bound correctly - that
is the whole reason we picked it - so measure it, drop each skin onto it in its local space,
and give the skin the donor mesh's exact object transform and parenting. The exporter then
treats the skin identically to how it treats a mesh that already works, whatever frame it
happens to prefer. The armature is never touched.
"""
import bpy, sys, os, json, argparse
from mathutils import Vector, Matrix


def argv():
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--donor", required=True, help="dir holding the animated donor glTF")
    p.add_argument("--skins", required=True, help="dir holding skin/<name>/ subdirs")
    p.add_argument("--out", required=True)
    return p.parse_args(a)


def find_gltf(d):
    for root, _, files in os.walk(d):
        for f in files:
            if f.lower().endswith((".gltf", ".glb")):
                return os.path.join(root, f)
    return None


def import_gltf(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def local_bounds(objs):
    """Bounds of raw vertex data, ignoring object transforms entirely."""
    pts = [v.co for o in objs if o.type == "MESH" for v in o.data.vertices]
    if not pts:
        return None, None
    return (Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))),
            Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts))))


def world_bounds(objs):
    pts = [o.matrix_world @ v.co for o in objs if o.type == "MESH" for v in o.data.vertices]
    if not pts:
        return None, None
    return (Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))),
            Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts))))


def select(objs, active=None):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def fit_matrix(src_min, src_max, dst_min, dst_max):
    """Uniform scale + translate mapping one box onto another, feet aligned.

    Uniform on purpose: the tubby silhouette is close enough between the donor
    and the template that a non-uniform stretch would only add distortion, and a
    squashed head is far more obvious than a slightly short one.
    """
    src_size = src_max - src_min
    dst_size = dst_max - dst_min
    k = min(dst_size.x / max(src_size.x, 1e-9),
            dst_size.y / max(src_size.y, 1e-9),
            dst_size.z / max(src_size.z, 1e-9))
    src_mid = (src_min + src_max) / 2
    dst_mid = (dst_min + dst_max) / 2
    # Match centres in x/y but stand the feet on the donor's floor: a tubby whose
    # hips line up matters more than one whose bounding box centre does.
    offset = Vector((dst_mid.x, dst_mid.y, dst_min.z)) - \
             Vector((src_mid.x * k, src_mid.y * k, src_min.z * k))
    return Matrix.Translation(offset) @ Matrix.Diagonal((k, k, k, 1.0))


def main():
    a = argv()
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # ---------------------------------------------------------------- donor --
    donor_path = find_gltf(a.donor)
    if not donor_path:
        sys.exit(f"no glTF under {a.donor} - run tools/fetch_sketchfab.py first")
    donor_objs = import_gltf(donor_path)
    arm = next((o for o in donor_objs if o.type == "ARMATURE"), None)
    if not arm:
        sys.exit(f"{donor_path} has no armature - pick a different donor")

    donor_meshes = [o for o in donor_objs if o.type == "MESH"]
    if not donor_meshes:
        sys.exit("donor has no mesh to use as a reference")

    # The biggest donor mesh is the body; the small ones are eyes and trim.
    ref = max(donor_meshes, key=lambda o: len(o.data.vertices))
    dmin, dmax = local_bounds([ref])
    wmin, wmax = world_bounds(donor_meshes)

    actions = list(bpy.data.actions)
    for act in actions:
        act.use_fake_user = True          # survive the donor mesh being deleted

    print(f"donor: {os.path.basename(donor_path)}")
    print(f"  armature '{arm.name}', {len(arm.data.bones)} bones, {len(actions)} clips")
    print(f"  reference mesh '{ref.name}', {len(ref.data.vertices)} verts")
    print(f"  its LOCAL bounds z {dmin.z:.3f}..{dmax.z:.3f}  (world height {wmax.z - wmin.z:.3f})")
    print(f"  armature matrix scale {tuple(round(v, 5) for v in arm.matrix_world.to_scale())}"
          " - left untouched, deliberately")

    ref_basis = ref.matrix_basis.copy()
    ref_parent = ref.parent
    ref_parent_inverse = ref.matrix_parent_inverse.copy()

    # ---------------------------------------------------------------- skins --
    skinned = []
    for name in sorted(os.listdir(a.skins)):
        sub = os.path.join(a.skins, name)
        if name.startswith("_") or not os.path.isdir(sub):
            continue
        gp = find_gltf(sub)
        if not gp:
            print(f"  skip {name}: no glTF")
            continue

        objs = import_gltf(gp)
        meshes = [o for o in objs if o.type == "MESH"]
        if not meshes:
            continue

        # Flatten the Sketchfab wrapper nodes into the vertex data so the skin's
        # local space is its own, then measure it in that space.
        select(meshes)
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        smin, smax = local_bounds(meshes)

        fit = fit_matrix(smin, smax, dmin, dmax)
        for idx, m in enumerate(meshes):
            # Bake the fit into the vertex data, then wear the donor mesh's own
            # object transform and parenting. From here the exporter cannot tell
            # this apart from the mesh that was already working.
            m.data.transform(fit)
            m.data.update()
            m.name = f"tubby_{name}_{idx}"
            for mod in list(m.modifiers):
                m.modifiers.remove(mod)
            m.parent = ref_parent
            m.matrix_parent_inverse = ref_parent_inverse.copy()
            m.matrix_basis = ref_basis.copy()

        # Drop everything the skin brought except its meshes.
        for o in objs:
            if o.type != "MESH" and o.name in bpy.data.objects:
                bpy.data.objects.remove(o, do_unlink=True)

        bpy.context.view_layer.update()
        select(meshes, active=arm)
        arm.select_set(True)
        # Heat-map weights, computed with the skin sitting exactly where the
        # donor's own mesh sits - which is the only place the bones expect it.
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        skinned += meshes
        fmin, fmax = world_bounds(meshes)
        print(f"  skinned {name}: {len(meshes)} mesh(es), world height {fmax.z - fmin.z:.3f}")

    if not skinned:
        sys.exit("nothing was skinned - fetch the skin/ models first")

    # Only now is the donor mesh expendable.
    for o in donor_meshes:
        bpy.data.objects.remove(o, do_unlink=True)

    fmin, fmax = world_bounds(skinned)
    native_h = fmax.z - fmin.z
    print(f"\nrig world height {native_h:.4f}, feet at z={fmin.z:.4f}")

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=a.out, export_format="GLB",
        export_animations=True, export_animation_mode="ACTIONS",
        export_nla_strips=False, export_skins=True,
        export_apply=False, use_selection=False)

    sidecar = os.path.splitext(a.out)[0] + ".json"
    with open(sidecar, "w", encoding="utf8") as f:
        json.dump({
            "nativeHeight": round(native_h, 6),
            "feet": round(fmin.z, 6),
            "clips": len(actions),
            "characters": sorted({m.name.rsplit("_", 1)[0].removeprefix("tubby_")
                                  for m in skinned}),
        }, f, indent=1)

    print(f"wrote {a.out}: {len(skinned)} meshes on 1 armature, {len(actions)} clips")
    print(f"wrote {sidecar}")


if __name__ == "__main__":
    main()
