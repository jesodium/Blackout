#!/bin/bash
# full rebuild: schematic -> footprint lib -> placed PCB -> freerouting -> stitch/fill -> ERC/DRC
set -e
D=$(cd $(dirname $0); pwd); O=${1:-$D/out}
PY=~/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
KC=~/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
mkdir -p $O; cp $D/blackout_sensor_hub.kicad_dru $D/fp-lib-table $O/; [ -f $O/blackout_sensor_hub.kicad_pro ] || cp $D/../kicad/blackout_sensor_hub.kicad_pro $O/
python3 $D/gen_sch.py $O
python3 $D/mklib.py $O >/dev/null
$D/route.sh $O
$PY $D/fin.py $O/blackout_sensor_hub.kicad_pcb $O/route.ses $O/blackout_sensor_hub.kicad_pcb 2>&1 | grep -v "assert\|Fontconfig\|leak"
$KC sch erc --severity-all -o $O/erc.rpt $O/blackout_sensor_hub.kicad_sch 2>&1 | grep -v Fontconfig
$KC pcb drc --severity-all --schematic-parity -o $O/drc.rpt $O/blackout_sensor_hub.kicad_pcb 2>&1 | grep -v Fontconfig
grep "^\[" $O/drc.rpt | cut -d: -f1 | sort | uniq -c || true
