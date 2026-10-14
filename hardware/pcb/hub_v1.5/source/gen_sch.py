import os, uuid, copy, sys
from sx import parse, dump, Sym, find, findall
import design

KI = os.path.expanduser("~/Applications/KiCad/KiCad.app/Contents/SharedSupport")
OUT = sys.argv[1] if len(sys.argv) > 1 else "out"
PROJ = "blackout_sensor_hub"
NS = uuid.UUID("6b1e8d52-0000-4000-8000-b1ac0b1ac0de")

def U(*k):
    return str(uuid.uuid5(NS, "/".join(map(str, k))))

_libcache = {}
def load_lib(lib):
    if lib in _libcache:
        return _libcache[lib]
    p = os.path.join(KI, "symbols", lib + ".kicad_sym")
    d = os.path.join(KI, "symbols", lib + ".kicad_symdir")
    syms = {}
    if os.path.isfile(p):
        t = parse(open(p).read())
        for s in findall(t, "symbol"):
            syms[s[1]] = s
    elif os.path.isdir(d):
        for f in os.listdir(d):
            if f.endswith(".kicad_sym"):
                t = parse(open(os.path.join(d, f)).read())
                for s in findall(t, "symbol"):
                    syms[s[1]] = s
    else:
        raise FileNotFoundError(lib)
    _libcache[lib] = syms
    return syms

def get_symbol(libid):
    lib, name = libid.split(":")
    syms = load_lib(lib)
    s = copy.deepcopy(syms[name])
    ext = find(s, "extends")
    if ext:
        parent = get_symbol(lib + ":" + ext[1])
        # parent graphics + child properties
        props = {p[1]: p for p in findall(s, "property")}
        new = [Sym("symbol"), libid]
        for e in parent[2:]:
            if isinstance(e, list) and e[0] == "property" and e[1] in props:
                new.append(props.pop(e[1]))
            elif isinstance(e, list) and e[0] == "symbol":
                e = copy.deepcopy(e)
                pn = parent[1].split(":")[1]
                e[1] = e[1].replace(pn, name, 1)
                new.append(e)
            else:
                new.append(e)
        for p in props.values():
            new.append(p)
        return new
    s[1] = libid
    return s

def pins_of(sym):
    out = {}
    for sub in findall(sym, "symbol"):
        for p in findall(sub, "pin"):
            at = find(p, "at")
            num = find(p, "number")[1]
            out[num] = (float(at[1]), float(at[2]), int(float(at[3])) if len(at) > 3 else 0)
    return out

def eff(size=1.27, hide=False, justify=None):
    e = [Sym("effects"), [Sym("font"), [Sym("size"), size, size]]]
    if justify:
        e.append([Sym("justify")] + [Sym(j) for j in justify.split()])
    if hide:
        e.append([Sym("hide"), Sym("yes")])
    return e

def prop(name, val, x, y, hide=False, ang=0, justify=None):
    return [Sym("property"), name, val, [Sym("at"), x, y, ang], eff(hide=hide, justify=justify)]

G = 1.27
def snap(v):
    return round(v / G) * G

items = []
lib_syms = {}
root = U("root")

ROT90 = {"Device:R", "Device:C", "Device:Polyfuse"}

def spins(libid):
    """pin offsets in SCHEMATIC coords (y down) + pin angle, after the symbol's rotation"""
    rot = 90 if libid in ROT90 else 0
    out = {}
    for num, (px, py, pa) in pins_of(get_symbol(libid)).items():
        if rot == 90:
            px, py, pa = -py, px, (pa + 90) % 360
        out[num] = (px, -py, pa)
    return out, rot

def place(part, X, Y):
    libid = part["lib"]
    if libid not in lib_syms:
        lib_syms[libid] = get_symbol(libid)
    pins, rot = spins(libid)
    ref = part["ref"]
    body = [Sym("symbol"), [Sym("lib_id"), libid], [Sym("at"), X, Y, rot], [Sym("unit"), 1],
            [Sym("exclude_from_sim"), Sym("no")], [Sym("in_bom"), Sym("no") if ref.startswith(("H", "JP", "TP")) else Sym("yes")],
            [Sym("on_board"), Sym("yes")], [Sym("dnp"), Sym("no")], [Sym("uuid"), U("sym", ref)]]
    angs = {p[2] for p in pins.values()}
    ys = [Y + p[1] for p in pins.values()] or [Y]
    xs = [X + p[0] for p in pins.values()] or [X]
    if not pins:                       # mounting hole
        rp, vp = (X, Y - 3.81, None), (X, Y + 3.81, None)
    elif 180 not in angs:              # nothing on the right: text goes right
        rp = (max(xs) + 3.81 if max(xs) > X else X + 3.81, min(ys) - 2.54, "left")
        vp = (rp[0], min(ys) - 0.76, "left")
    else:                              # text above
        top = min(ys) - (3.3 if 270 not in angs else 8.0)
        rp, vp = (X, top - 1.8, None), (X, top, None)
    body.append(prop("Reference", ref, rp[0], rp[1], justify=rp[2], ang=rot))
    body.append(prop("Value", part["value"], vp[0], vp[1], justify=vp[2], ang=rot))
    body.append(prop("Footprint", part["fp"], X, Y, hide=True))
    body.append(prop("Datasheet", "~", X, Y, hide=True))
    if part.get("lcsc"):
        body.append(prop("LCSC", part["lcsc"][0], X, Y, hide=True))
        body.append(prop("MPN", part["lcsc"][1], X, Y, hide=True))
    for num in pins:
        body.append([Sym("pin"), num, [Sym("uuid"), U("pin", ref, num)]])
    body.append([Sym("instances"), [Sym("project"), PROJ, [Sym("path"), "/" + root,
                 [Sym("reference"), ref], [Sym("unit"), 1]]]])
    items.append(body)
    names = part.get("names", {})
    for num, (px, py, pa) in pins.items():
        key = int(num) if num.isdigit() else num
        net = part["pins"].get(key, "__missing__")
        if net == "__missing__":
            raise KeyError("%s pin %s unassigned" % (ref, num))
        sx_, sy_ = X + px, Y + py
        la = {0: 180, 180: 0, 90: 270, 270: 90}[pa]
        if net is None:
            items.append([Sym("no_connect"), [Sym("at"), sx_, sy_], [Sym("uuid"), U("nc", ref, num)]])
            if names.get(key):
                items.append([Sym("text"), names[key], [Sym("exclude_from_sim"), Sym("no")],
                              [Sym("at"), sx_ + (-2.0 if la == 180 else 2.0), sy_, 0],
                              eff(1.0, justify="right" if la == 180 else "left"), [Sym("uuid"), U("nct", ref, num)]])
            continue
        just = {0: "left", 180: "right", 90: "left", 270: "right"}[la]
        items.append([Sym("global_label"), net, [Sym("shape"), Sym("passive")],
                      [Sym("at"), sx_, sy_, la], [Sym("fields_autoplaced"), Sym("yes")],
                      eff(justify=just), [Sym("uuid"), U("gl", ref, num)],
                      prop("Intersheetrefs", "${INTERSHEET_REFS}", sx_, sy_, hide=True)])
        if names.get(key):
            ll = len(net) * 1.0 + 3.2
            items.append([Sym("text"), names[key], [Sym("exclude_from_sim"), Sym("no")],
                          [Sym("at"), sx_ + (-ll if la == 180 else ll), sy_, 0],
                          eff(1.0, justify="right" if la == 180 else "left"), [Sym("uuid"), U("pn", ref, num)]])
    return min(ys), max(ys)

def note(txt, x, y, size=2.0):
    items.append([Sym("text"), txt, [Sym("exclude_from_sim"), Sym("no")], [Sym("at"), x, y, 0],
                  eff(size, justify="left"), [Sym("uuid"), U("note", txt[:30], x, y)]])

byref = {p["ref"]: p for p in design.parts}

# layout: columns of (title, [refs])
columns = [
    (40, [("GIGA R1 SHIELD HEADERS (Mega footprint, male pins into the Giga)", ["J1", "J2", "J4", "J6", "J3", "J5"])]),
    (150, [("", ["J7"])]),
    (215, [("WIRE (D20/D21): ARM PCA9685 ONLY", ["J10", "JP1", "R1", "R2"]),
           ("WIRE1 (SDA1 D102 / SCL1 D101)", ["J12", "J13", "J14", "JP2", "R3", "R4"]),
           ("LCD 3.5in ILI9488 SPI (v1.4): D13 SCK / D11 MOSI / D0 CS / D1 DC", ["J11"])]),
    (300, [("WIRE2 (D9 SDA2 / D8 SCL2)", ["J15", "J16", "J17", "J27", "JP3", "R5", "R6"]),
           ("GPIO SENSORS (3V3 ONLY)", ["J18", "J19", "R7", "J20", "JP5", "TP1"])]),
    (385, [
           ("ACTUATORS", ["J21", "JP4", "J22"]),
           ("UARTS", ["J23", "R8", "J24", "JP7", "J25", "R9"]),
           ("v1.5: GYRO (WIRE1) + MQ135 (5V, AO / 10k-15k -> A1)", ["J32", "J33", "R12", "R13"])]),
    (470, [("5V: GIGA 5V PIN -> PTC", ["F1", "C1", "C2", "R11", "D2"]),
           ("3V3 (from Giga)", ["C3", "C4", "R10", "D1"]),
           ("SPARE GPIO (v1.1)", ["J30", "J31"]),
           ("AUX PORTS", ["J28", "J29"]),
           ("MECHANICAL", ["H1", "H2", "H3", "H4", "H5", "H6"])]),
]

used = set()
for x, groups in columns:
    y = 30.48
    for title, refs in groups:
        if title:
            note(title, x - 20, y)
            y += 7.62
        i = 0
        while i < len(refs):
            ref = refs[i]
            p = byref[ref]
            pins, _ = spins(p["lib"])
            ys = [v[1] for v in pins.values()] or [0]
            angs = {v[2] for v in pins.values()}
            if ref.startswith("H"):
                for k, rr in enumerate(refs[i:]):
                    place(byref[rr], snap(x - 10 + k * 10.16), snap(y + 5.08))
                    used.add(rr)
                y += 15
                break
            def lablen(pa):
                L = [len(str(p["pins"].get(int(n) if n.isdigit() else n) or "")) for n, v in pins.items() if v[2] == pa]
                return (max(L) * 0.95 + 3.0) if L and max(L) else 0
            head = max(3.0, lablen(270) + 1.5) if 270 in angs else (5.6 if 180 in angs else 3.0)
            Y = snap(y - min(ys) + head)
            place(p, snap(x), Y)
            used.add(ref)
            y = Y + max(ys) + max(4.0, lablen(90) + 1.5)
            i += 1
        y += 5.08

missing = set(byref) - used
assert not missing, missing

note("BLACKOUT -- Giga R1 WiFi shield. All sensor ports 3V3; 5V (from the Giga 5V pin) only on LIDAR, LCD, MQ135 heater and relay VCC (JP4).", 20, 12, 2.5)
note("Pin legends are from the DEVICE side on UART ports: device TX -> 'TX>' pin -> 1k -> Giga RX.", 20, 17, 1.8)

sch = [Sym("kicad_sch"), [Sym("version"), 20250114], [Sym("generator"), "eeschema"],
       [Sym("generator_version"), "9.0"], [Sym("uuid"), root], [Sym("paper"), "A2"],
       [Sym("title_block"), [Sym("title"), "BLACKOUT Sensor Hub"], [Sym("date"), "2026-09-23"],
        [Sym("rev"), "1.5"], [Sym("company"), "WRO 2026 - Blackout"],
        [Sym("comment"), 1, "Arduino Giga R1 WiFi shield: modular 3V3 sensor ports, 3 isolated I2C buses"]],
       [Sym("lib_symbols")] + list(lib_syms.values())] + items + [
       [Sym("sheet_instances"), [Sym("path"), "/", [Sym("page"), "1"]]],
       [Sym("embedded_fonts"), Sym("no")]]
os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, PROJ + ".kicad_sch"), "w").write(dump(sch) + "\n")
print("wrote schematic,", len(items), "items")
