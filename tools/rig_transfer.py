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

THE RULE THAT MATTERS: by export time the armature and every skinned mesh must have an
IDENTITY object transform.

glTF says a skinned mesh node's own transform "MUST be ignored" - skinned vertices are placed
entirely by the inverse bind matrices and the joint hierarchy. A Sketchfab rip arrives wrapped
in nested nodes carrying ~0.031 scale factors, and Blender parents meshes to armatures through a
hidden parent-inverse matrix. Both of those are object transforms, so both get silently DROPPED
on export. Leave them in and the mesh binds fine in Blender and previews fine in Blender, then
renders 70 metres above its own skeleton in three.js - with correct bone positions and correct
skin weights the entire time, which is what makes it such a miserable thing to chase.

So flatten everything: normalise the armature to identity (rescaling the actions' location
channels to match, since Blender will not do that for you), bring the skins into that same
space, bake it into vertex data, and only then bind. The rig's native height goes into a sidecar
JSON and three.js scales the whole cloned root uniformly - safe, because bones and bind matrices
then scale together.
"""
import bpy, sys, os, json, argparse
from mathutils import Vector


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


def bounds(objs):
    """World-space min/max over every mesh vertex. Blender is Z-up here."""
    pts = [o.matrix_world @ v.co
           for o in objs if o.type == "MESH" for v in o.data.vertices]
    if not pts:
        return None, None
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return mn, mx


def action_fcurves(act):
    """Every f-curve in an action, across Blender's two action APIs.

    Blender 4.4 moved animation data into layers -> strips -> channelbags (one
    per slot) and 5.x dropped the flat `Action.fcurves` shortcut entirely.
    """
    if hasattr(act, "fcurves"):
        return list(act.fcurves)
    out = []
    for layer in getattr(act, "layers", []):
        for strip in getattr(layer, "strips", []):
            for bag in getattr(strip, "channelbags", []):
                out.extend(bag.fcurves)
    return out


def normalise_armature(arm, actions):
    """Force the armature object transform to identity, keeping the animation valid.

    Applying scale to an armature multiplies every bone's rest length, but Blender
    does NOT rescale the actions to match - pose-bone `location` channels are in
    Blender units, so every translated bone would drift by exactly the scale
    factor. We rescale those channels ourselves. Rotation and scale channels are
    unaffected, so they are left alone.
    """
    scale = tuple(arm.matrix_world.to_scale())
    k = sum(scale) / 3.0
    if max(scale) - min(scale) > 1e-4 * max(1.0, k):
        print(f"  warning: non-uniform armature scale {scale}, using mean {k:.5f}")

    select([arm])
    if arm.parent:
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.context.view_layer.update()

    if abs(k - 1.0) > 1e-6:
        touched = 0
        for act in actions:
            for fc in action_fcurves(act):
                if not fc.data_path.endswith("location"):
                    continue
                for kp in fc.keyframe_points:
                    kp.co.y *= k
                    kp.handle_left.y *= k
                    kp.handle_right.y *= k
                touched += 1
        print(f"  armature normalised (scale {k:.5f} baked in), "
              f"rescaled {touched} location curves across {len(actions)} clips")
    else:
        print("  armature already at unit scale")


def select(objs, active=None):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


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

    # Measure in WORLD space. Applying the armature's transform below bakes it
    # into the bone rest data and leaves the rig looking identical in world
    # space, so world is the frame both the donor and the skins share.
    dmin, dmax = bounds(donor_objs)
    if dmin is None:
        sys.exit("donor has no mesh - cannot establish a scale reference")
    donor_h = dmax.z - dmin.z
    if donor_h <= 1e-9:
        sys.exit("donor mesh has no height - cannot establish a scale reference")
    donor_mid = Vector(((dmin.x + dmax.x) / 2, (dmin.y + dmax.y) / 2, 0))

    actions = list(bpy.data.actions)
    for act in actions:
        act.use_fake_user = True          # survive the donor mesh being deleted
    print(f"donor: {os.path.basename(donor_path)} - armature '{arm.name}', "
          f"{len(arm.data.bones)} bones, {len(actions)} clips, "
          f"world height {donor_h:.4f}")

    for o in donor_objs:
        if o.type == "MESH":
            bpy.data.objects.remove(o, do_unlink=True)

    normalise_armature(arm, actions)

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

        # Flatten the Sketchfab wrapper nodes into the meshes themselves.
        select(meshes)
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

        # Match the donor's size and footing. World space == armature space now.
        smin, smax = bounds(meshes)
        k = donor_h / max(smax.z - smin.z, 1e-9)
        smid = Vector(((smin.x + smax.x) / 2, (smin.y + smax.y) / 2, 0))
        for m in meshes:
            m.scale = [s * k for s in m.scale]
            m.location = (m.location - smid) * k + donor_mid
            m.location.z = (m.location.z - smin.z) * k + dmin.z
        bpy.context.view_layer.update()
        select(meshes)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

        # Drop everything the skin brought except the meshes.
        for o in objs:
            if o.type != "MESH" and o.name in bpy.data.objects:
                bpy.data.objects.remove(o, do_unlink=True)

        for idx, m in enumerate(meshes):
            # Index the parts explicitly. Naming them all the same makes Blender
            # append .001/.002 suffixes, which defeat prefix matching at runtime.
            m.name = f"tubby_{name}_{idx}"
            for mod in list(m.modifiers):
                m.modifiers.remove(mod)

        select(meshes, active=arm)
        arm.select_set(True)
        # Heat-map weights: fine here because the tubby silhouette is a simple
        # closed body. Bones far outside the mesh (the donor's chainsaw) warn and
        # receive no weights, which is exactly what we want.
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")

        # parent_set stores a parent-inverse matrix, and some importers leave a
        # residual local matrix on the first mesh of a hierarchy. three.js builds
        # each SkinnedMesh's bindMatrix from its world matrix, so ANY leftover
        # object transform here corrupts the bind and throws the geometry across
        # the map. The vertices are already baked into armature space, so the
        # correct local transform is exactly identity - assert that.
        for m in meshes:
            m.matrix_parent_inverse.identity()
            # NOT m.matrix_basis.identity() - matrix_basis returns a COPY derived
            # from loc/rot/scale, so mutating it in place is silently discarded.
            # Zero the underlying properties instead.
            m.location = (0.0, 0.0, 0.0)
            m.rotation_euler = (0.0, 0.0, 0.0)
            m.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
            m.scale = (1.0, 1.0, 1.0)
        bpy.context.view_layer.update()

        skinned += meshes
        print(f"  skinned {name}: {len(meshes)} mesh(es)")

    if not skinned:
        sys.exit("nothing was skinned - fetch the skin/ models first")

    fmin, fmax = bounds(skinned)
    native_h = fmax.z - fmin.z
    print(f"rig native height {native_h:.4f}, feet at z={fmin.z:.4f}")

    # Anything still carrying an object transform will be dropped by glTF, so say
    # so loudly here rather than letting it turn into an invisible mesh later.
    stray = []
    for o in [arm, *skinned]:
        t = o.matrix_world.to_translation()
        sc = o.matrix_world.to_scale()
        if max(abs(t.x), abs(t.y), abs(t.z)) > 1e-4 or \
           max(abs(sc.x - 1), abs(sc.y - 1), abs(sc.z - 1)) > 1e-4:
            stray.append(o.name)
    if stray:
        print(f"  WARNING: non-identity transforms glTF will drop: {stray}")
        for nm in stray[:1]:
            o = bpy.data.objects[nm]
            print(f"    {nm}: loc={tuple(round(v,4) for v in o.location)} "
                  f"scale={tuple(round(v,4) for v in o.scale)} "
                  f"dloc={tuple(round(v,4) for v in o.delta_location)} "
                  f"dscale={tuple(round(v,4) for v in o.delta_scale)} "
                  f"parent={o.parent.name if o.parent else None} "
                  f"constraints={[c.type for c in o.constraints]}")
            print(f"    matrix_world={[round(v,4) for row in o.matrix_world for v in row]}")
    else:
        print("  all object transforms are identity - safe for glTF skinning")

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=a.out, export_format="GLB",
        export_animations=True, export_animation_mode="ACTIONS",
        export_nla_strips=False, export_skins=True,
        export_apply=False, use_selection=False)

    # Blender Z-up becomes glTF Y-up on export, so z here is y for the game.
    sidecar = os.path.splitext(a.out)[0] + ".json"
    with open(sidecar, "w", encoding="utf8") as f:
        json.dump({
            "nativeHeight": round(native_h, 6),
            "feet": round(fmin.z, 6),
            "clips": len(actions),
            "characters": sorted({m.name.rsplit("_", 1)[0].removeprefix("tubby_")
                                  for m in skinned}),
        }, f, indent=1)

    print(f"\nwrote {a.out}: {len(skinned)} meshes on 1 armature, {len(actions)} clips")
    print(f"wrote {sidecar}")


if __name__ == "__main__":
    main()
