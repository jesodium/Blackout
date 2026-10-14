import pcbnew, re, sys, os
src, dst = sys.argv[1], sys.argv[2]
M = os.path.dirname(os.path.abspath(__file__)) + '/3d'
b = pcbnew.LoadBoard(src)
for f in b.GetFootprints():
    fp = str(f.GetFPID().GetLibItemName())
    m = f.Models()
    ph = re.match(r'JST_PH_B(\d)B-PH-SM4-TB', fp)
    gh = re.match(r'Giga_Header_(\dx\d+)_', fp)
    if ph:
        n = int(ph.group(1))
        m[0].m_Filename = '${KICAD10_3DMODEL_DIR}/Connector_JST.3dshapes/JST_PH_B%dB-PH-K_1x%02d_P2.00mm_Vertical.step' % (n, n)
        # IMPORTANT NOTE: THT housing stands in for the SMD part (no SM4-TB model exists); pin1 moved onto the SMD contact row
        m[0].m_Offset = pcbnew.VECTOR3D(-(n - 1), 2.5, 0)
    elif gh:
        m[0].m_Filename = '%s/PinSocket_%s_P2.54mm_Vertical.step' % (M, gh.group(1))
        # KiCad socket model puts column 2 at -2.54, Giga footprint has it at +2.54
        m[0].m_Offset = pcbnew.VECTOR3D(2.54 if gh.group(1) == '2x18' else 0, 0, 0)
b.Save(dst)
