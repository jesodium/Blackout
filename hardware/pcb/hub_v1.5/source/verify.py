"""verify.py <routed board> : Giga-safety asserts on the finished copper (run with KiCad's python).
Fails loudly if any Giga header pin can see 5V, or the v1.5 ports are wired wrong."""
import sys
import pcbnew
from pcbnew import ToMM

b = pcbnew.LoadBoard(sys.argv[1])
pad = {}
for fp in b.GetFootprints():
    for p in fp.Pads():
        if p.GetNumber():
            pad[(fp.GetReference(), p.GetNumber())] = p.GetNetname()
val = {fp.GetReference(): fp.GetValue() for fp in b.GetFootprints()}

FIVE = {"+5V", "+5V_FUSED", "RLY_VCC", "MQ135_AO5V"}
GIGA = ["J1", "J2", "J3", "J4", "J5", "J6", "J7"]
for (ref, num), net in pad.items():
    if ref in GIGA and net in FIVE:
        assert (ref, num) == ("J1", "5"), "5V on Giga pin %s.%s (%s)" % (ref, num, net)

# gyro: 3V3 power, Wire1, same pins as the BME280 port
assert [pad[("J32", n)] for n in "1234"] == ["+3V3", "GND", "I2C1_SCL", "I2C1_SDA"]
assert pad[("J2", "1")] == "I2C1_SCL" and pad[("J2", "2")] == "I2C1_SDA"
# MQ135: 5V heater, DO open, AO only through the divider to A1
assert [pad[("J33", n)] for n in "124"] == ["+5V_FUSED", "GND", "MQ135_AO5V"]
assert pad[("J33", "3")].startswith("unconnected")
assert sorted([pad[("R12", "1")], pad[("R12", "2")]]) == ["MQ135_AO", "MQ135_AO5V"] and val["R12"] == "10k"
assert sorted([pad[("R13", "1")], pad[("R13", "2")]]) == ["GND", "MQ135_AO"] and val["R13"] == "15k"
assert pad[("J3", "2")] == "MQ135_AO"
users = sorted(k for k, n in pad.items() if n == "MQ135_AO5V")
assert users == [("J33", "4"), ("R12", "1")] or users == [("J33", "4"), ("R12", "2")], users
vmax = 5.25 * 15 / (10 + 15)
assert vmax < 3.3, vmax
# GPS: 3V3 power, its TX only through the 1k into D19 (Serial2 RX), D18 straight to its RX
assert [pad[("J28", n)] for n in "1234"] == ["+3V3", "GND", "GPS_TXO", "UART2_TX"]
assert sorted([pad[("R14", "1")], pad[("R14", "2")]]) == ["GPS_TXO", "UART2_RX"] and val["R14"] == "1k"
assert pad[("J6", "5")] == "UART2_TX" and pad[("J6", "6")] == "UART2_RX"
assert sorted(k for k, n in pad.items() if n == "GPS_TXO") == [("J28", "3"), ("R14", "1")] or \
       sorted(k for k, n in pad.items() if n == "GPS_TXO") == [("J28", "3"), ("R14", "2")]
# 5V only reaches the Giga through the fuse
assert sorted(k for k, n in pad.items() if n == "+5V") == [("F1", "1"), ("J1", "5")]
# power tracks kept their 0.5 mm class
thin = [ToMM(t.GetWidth()) for t in b.GetTracks() if t.GetClass() == "PCB_TRACK" and t.GetNetname() in ("+5V", "+5V_FUSED") and ToMM(t.GetWidth()) < 0.5]
print("5V tracks under 0.5 mm:", len(thin), "min", min(thin) if thin else "-")
print("verify ok: no Giga pin sees 5V, A1 max %.2f V, gyro on Wire1 3V3, MQ135 heater on fused 5V, GPS on Serial2 3V3" % vmax)
