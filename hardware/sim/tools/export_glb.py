"""blackout.xml -> server/public/models/rover.glb for the dashboard Live View.
Settles the sim so the suspension sits as built, then bakes every visual mesh at its world pose.
Run: ~/.venvs/cad/bin/python tools/export_glb.py"""
import os
import mujoco, numpy as np, trimesh

HERE = os.path.dirname(os.path.abspath(__file__))
m = mujoco.MjModel.from_xml_path(os.path.join(HERE, "..", "blackout.xml"))
d = mujoco.MjData(m)
for _ in range(2000):  # 2 s at 1 ms: body drops onto the corner springs
    mujoco.mj_step(m, d)

parts = []
for g in range(m.ngeom):
    if m.geom_type[g] != mujoco.mjtGeom.mjGEOM_MESH or m.geom_group[g] != 2:
        continue
    k = m.geom_dataid[g]
    v0, nv = m.mesh_vertadr[k], m.mesh_vertnum[k]
    f0, nf = m.mesh_faceadr[k], m.mesh_facenum[k]
    v = m.mesh_vert[v0:v0 + nv] @ d.geom_xmat[g].reshape(3, 3).T + d.geom_xpos[g]
    mesh = trimesh.Trimesh(v, m.mesh_face[f0:f0 + nf], process=True)
    mesh.visual.face_colors = (m.geom_rgba[g] * 255).astype(np.uint8)
    parts.append(mesh)

scene = trimesh.util.concatenate(parts)
# settling drifts the heading a few degrees; undo yaw only, keep the real pitch/roll on the springs
R = d.xmat[m.jnt_bodyid[list(m.jnt_type).index(mujoco.mjtJoint.mjJNT_FREE)]].reshape(3, 3)
scene.apply_transform(trimesh.transformations.rotation_matrix(-np.arctan2(R[1, 0], R[0, 0]), [0, 0, 1]))
# MuJoCo is Z-up, forward +X. glTF is Y-up; scene.js turns the group +90° about Y,
# so forward must land on -X here to face +Z (the sonar wall) in the dashboard.
scene.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
scene.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [0, 1, 0]))
out = os.path.join(HERE, "..", "..", "..", "server", "public", "models", "rover.glb")
scene.export(out)
print(len(parts), "meshes,", len(scene.faces), "tris ->", os.path.getsize(out) // 1024, "KB")
