#!/bin/bash
# v1.5 build: place from design.py, keep the v1.4 copper away from the new/moved parts, route the rest
set -e
D=$(cd $(dirname $0); pwd); O=$1
PY=~/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
J=$(brew --prefix openjdk)/bin/java
mkdir -p $O; cp $D/blackout_sensor_hub.kicad_dru $D/fp-lib-table $O/; cp $D/../kicad/blackout_sensor_hub.kicad_pro $O/
python3 $D/gen_sch.py $O
python3 $D/mklib.py $O >/dev/null
$PY $D/gen_pcb.py $O 2>&1 | grep -v "assert\|Fontconfig\|leak"
$PY $D/keep_route.py $D/../kicad/blackout_sensor_hub.kicad_pcb $O/blackout_sensor_hub.kicad_pcb J32 J33 R10 R11 R12 R13 D1 D2 F1 C1 C3 C4 C5 C6 ${DROP} 2>&1 | grep -v "assert\|Fontconfig\|leak"
$PY -c "
import pcbnew
b=pcbnew.LoadBoard('$O/blackout_sensor_hub.kicad_pcb')
pcbnew.ExportSpecctraDSN(b,'$O/route.dsn')" 2>&1 | grep -v "assert\|Fontconfig\|leak" || true
$J -Djava.awt.headless=true -jar $D/freerouting.jar -de $O/route.dsn -do $O/route.ses -mp ${MP:-100} -mt 1 --gui.enabled=false > $O/fr.log 2>&1
grep "Auto-routing stage completed" $O/fr.log | sed 's/.*final score/score/' | tail -2
$PY $D/fin.py $O/blackout_sensor_hub.kicad_pcb $O/route.ses $O/blackout_sensor_hub.kicad_pcb 2>&1 | grep -v "assert\|Fontconfig\|leak"
KC=~/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
$KC sch erc --severity-all -o $O/erc.rpt $O/blackout_sensor_hub.kicad_sch 2>&1 | grep -v Fontconfig
$KC pcb drc --severity-all --schematic-parity -o $O/drc.rpt $O/blackout_sensor_hub.kicad_pcb 2>&1 | grep -v Fontconfig
grep "^\[" $O/drc.rpt | cut -d: -f1 | sort | uniq -c || true
