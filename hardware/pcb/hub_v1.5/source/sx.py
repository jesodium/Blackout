"""Tiny s-expression reader/writer for KiCad files."""
import re

class Sym(str):
    """bare (unquoted) atom"""

_tok = re.compile(r'\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))', re.S)

def parse(text):
    pos = 0
    stack = [[]]
    n = len(text)
    while pos < n:
        m = _tok.match(text, pos)
        if not m:
            if text[pos:].strip() == "":
                break
            raise ValueError("bad sexpr at %d: %r" % (pos, text[pos:pos + 40]))
        pos = m.end()
        if m.group(1):
            stack.append([])
        elif m.group(2):
            x = stack.pop()
            stack[-1].append(x)
        elif m.group(3) is not None:
            stack[-1].append(m.group(3).replace('\\"', '"').replace("\\\\", "\\"))
        else:
            stack[-1].append(Sym(m.group(4)))
    return stack[0][0]

def q(s):
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'

def dump(x, ind=0):
    if isinstance(x, list):
        if not x:
            return "()"
        simple = all(not isinstance(e, list) for e in x)
        if simple:
            return "(" + " ".join(dump(e) for e in x) + ")"
        out = "(" + " ".join(dump(e) for e in x if not isinstance(e, list))
        for e in x:
            if isinstance(e, list):
                out += "\n" + "\t" * (ind + 1) + dump(e, ind + 1)
        return out + "\n" + "\t" * ind + ")"
    if isinstance(x, Sym):
        return str(x)
    if isinstance(x, bool):
        return "yes" if x else "no"
    if isinstance(x, (int, float)):
        if isinstance(x, float):
            s = ("%.4f" % x).rstrip("0").rstrip(".")
            return s if s not in ("-0", "") else "0"
        return str(x)
    return q(x)

def find(node, key):
    for e in node:
        if isinstance(e, list) and e and e[0] == key:
            return e
    return None

def findall(node, key):
    return [e for e in node if isinstance(e, list) and e and e[0] == key]
