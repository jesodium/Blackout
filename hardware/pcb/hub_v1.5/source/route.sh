#!/bin/bash
# route.sh <outdir> : place -> DSN -> freerouting -> SES import
set -e
D=$(cd $(dirname $0); pwd); O=$1
PY=~/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
J=$(brew --prefix openjdk)/bin/java
$PY $D/gen_pcb.py $O 2>&1 | grep -v "assert\|Fontconfig\|leak"
$PY -c "
import pcbnew
b=pcbnew.LoadBoard('$O/blackout_sensor_hub.kicad_pcb')
pcbnew.ExportSpecctraDSN(b,'$O/route.dsn')" 2>&1 | grep -v "assert\|Fontconfig\|leak" || true
$J -Djava.awt.headless=true -jar $D/freerouting.jar -de $O/route.dsn -do $O/route.ses -mp ${MP:-100} -mt 1 --gui.enabled=false > $O/fr.log 2>&1
grep -E "Net '|  - " $O/fr.log | tail -20
grep "Auto-routing stage completed" $O/fr.log | sed 's/.*final score/score/'
