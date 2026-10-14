import adsk.core, adsk.fusion, json
OUT='/Users/jesus/Documents/WRO 2026/Blackout-Explorations/hardware/sim/tools/raw/'  # Fusion runs this via MCP, no __file__
def run(context):
    app=adsk.core.Application.get(); d=adsk.fusion.Design.cast(app.activeProduct); r=d.rootComponent
    def dump(name,occ):
        V=[];I=[];n=0
        def bodies(o):
            for b in o.bRepBodies:
                if b.isVisible: yield b
            for c in o.childOccurrences:
                if c.isVisible: yield from bodies(c)
        for b in bodies(occ):
            mc=b.meshManager.createMeshCalculator(); mc.setQuality(adsk.fusion.TriangleMeshQualityOptions.LowQualityTriangleMesh)
            tm=mc.calculate(); V+=list(tm.nodeCoordinatesAsDouble); I+=[i+n for i in tm.nodeIndices]; n+=tm.nodeCount
        if occ.component.meshBodies.count:
            for b in occ.component.meshBodies:
                if b.isVisible:
                    tm=b.displayMesh; T=occ.transform2
                    c=list(tm.nodeCoordinatesAsDouble)
                    for k in range(0,len(c),3):
                        p=adsk.core.Point3D.create(c[k],c[k+1],c[k+2]); p.transformBy(T); c[k:k+3]=[p.x,p.y,p.z]
                    V+=c; I+=[i+n for i in tm.nodeIndices]; n+=tm.nodeCount
        json.dump({'v':V,'i':I},open(OUT+name.replace(':','_')+'.json','w')); return n
    ch=r.occurrences.itemByName('chassis-mk3:1')
    for c in ch.childOccurrences:
        if c.isVisible: print(c.name,dump(c.name,c))
    for o in r.occurrences:
        if o.isVisible and o.name!='chassis-mk3:1': print(o.name,dump(o.name,o))
