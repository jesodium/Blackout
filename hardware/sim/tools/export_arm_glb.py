"""blackout.xml -> server/public/models/arm.glb for the dashboard's 3D arm.
One glTF node per MuJoCo body under `mearm`, at its rest pos/quat, with that body's
visual meshes baked into its own frame, so the dash only has to rotate each node
about its joint axis (armsim.mjs armJoints). Also writes server/test/arm-fk.json:
MuJoCo's own tool position at a few poses and the arm joints' ranges, which test/arm.mjs
checks the dash against.
Stays MuJoCo-native (Z up, metres); the dash turns it Y-up.
Run: ~/.venvs/cad/bin/python tools/export_arm_glb.py"""
import json, os
import mujoco, numpy as np, trimesh

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "..", "..", "server")
m = mujoco.MjModel.from_xml_path(os.path.join(HERE, "..", "blackout.xml"))
d = mujoco.MjData(m)
root = m.body("mearm").id


def under(b):
    while b:
        if b == root:
            return True
        b = m.body_parentid[b]
    return False


def mat(pos, quat):
    M = np.eye(4)
    M[:3, :3] = trimesh.transformations.quaternion_matrix(quat)[:3, :3]
    M[:3, 3] = pos
    return M


scene = trimesh.Scene(base_frame="arm")
tris = 0
for b in range(m.nbody):
    if not under(b):
        continue
    name = m.body(b).name
    parent = "arm" if b == root else m.body(m.body_parentid[b]).name
    scene.graph.update(frame_to=name, frame_from=parent, matrix=np.eye(4) if b == root else mat(m.body_pos[b], m.body_quat[b]))
    parts = []
    for g in range(m.ngeom):
        if m.geom_bodyid[g] != b or m.geom_type[g] != mujoco.mjtGeom.mjGEOM_MESH or m.geom_group[g] != 2:
            continue
        k = m.geom_dataid[g]
        v0, nv, f0, nf = m.mesh_vertadr[k], m.mesh_vertnum[k], m.mesh_faceadr[k], m.mesh_facenum[k]
        mesh = trimesh.Trimesh(m.mesh_vert[v0:v0 + nv], m.mesh_face[f0:f0 + nf], process=True)
        mesh.apply_transform(mat(m.geom_pos[g], m.geom_quat[g]))
        parts.append(mesh)
    if parts:
        mesh = trimesh.util.concatenate(parts)
        tris += len(mesh.faces)
        scene.add_geometry(mesh, node_name=name + "_mesh", geom_name=name + "_mesh", parent_node_name=name)

out = os.path.join(SERVER, "public", "models", "arm.glb")
os.makedirs(os.path.dirname(out), exist_ok=True)
scene.export(out)
print(tris, "tris ->", os.path.getsize(out) // 1024, "KB")

# reference poses: the mimic joints set by hand, same formulas as armsim.mjs armJoints
MIMIC = lambda j1, j2: {"arm_0_support_mimic": 1.57 + j1, "arm_0_connector_mimic": -1.57 - j1,
                        "gripper_support_mimic": -1.57 - j2, "gripper_holder": -1.57 + j2,
                        "arm1_mimic_0": -1.57 - j1 - j2, "joint_2_mimic_0b": 1.57 - j1 - j2}
ref = []
for q in [(0, 0, 0, 0), (0.5, -0.785, 0.785, 0.3), (-0.6, 0.9, 1.4, 0.5), (0.2, -1.5, 0.1, 0)]:
    d.qpos[:] = m.qpos0
    for n, v in {"joint_0": q[0], "joint_1": q[1], "joint_2": q[2], "jaw_A": q[3], "jaw_B": q[3], **MIMIC(q[1], q[2])}.items():
        d.qpos[m.jnt_qposadr[m.joint(n).id]] = v
    mujoco.mj_kinematics(m, d)
    rel = lambda b: (d.xmat[root].reshape(3, 3).T @ (d.body(b).xpos - d.xpos[root])).round(6).tolist()
    ref.append({"q": q, "tool": rel("tool"), "jaw_A": rel("jaw_A")})
# the CAD's mechanical travel: the dash clamps the drawn pose to it (ARM_RANGE)
rng = {n: m.jnt_range[m.joint(n).id].round(4).tolist() for n in ("joint_0", "joint_1", "joint_2", "jaw_A")}
with open(os.path.join(SERVER, "test", "arm-fk.json"), "w") as f:
    json.dump({"range": rng, "poses": ref}, f, indent=1)
