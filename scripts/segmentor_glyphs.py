"""Export the five Segmentor fonts as outline data for the web tool.

Usage:  python scripts/segmentor_glyphs.py <folder with 20250528-Segmentor-0X.ttf>
Writes: fonts/segmentor-0X.json

Every Segmentor axis (AAAA–IIII, 0–1000) is a single linear master, so a
glyph at any setting is   default + sum(axis value 0..1 * delta of that axis).
For each glyph we store the default outline (points + on/off-curve flags +
contour ends), the advance width, and per axis the point and width deltas
(only for axes that move the glyph). Composite glyphs are flattened.
Needs fontTools.
"""
import json, sys, pathlib
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

src = pathlib.Path(sys.argv[1])
out = pathlib.Path(__file__).resolve().parent.parent / "fonts"
out.mkdir(parents=True, exist_ok=True)

# Characters the tool can show: Basic Latin, Romanian, common accents and
# punctuation. (Segmentor's letters are built from many segments, so the
# data is large; every extra character costs ~10–40 KB per style.)
WANTED = set(range(0x20, 0x7F)) | {ord(c) for c in "ăâîșțĂÂÎȘȚéèêëàáäöüçñßÉÀÄÖÜ’‘“”–—…«»€©°"}

def outline(font, name):
    glyf = font["glyf"]
    coords, ends, flags = glyf[name].getCoordinates(glyf)
    return [round(v) for xy in coords for v in xy], list(ends), "".join("1" if f & 1 else "0" for f in flags)

for i in range(1, 6):
    path = src / f"20250528-Segmentor-0{i}.ttf"
    base = TTFont(path)
    axes = [a.axisTag for a in base["fvar"].axes]
    cmap = {c: g for c, g in base.getBestCmap().items() if c in WANTED}
    default = instantiateVariableFont(TTFont(path), {a: 0 for a in axes})
    full = [instantiateVariableFont(TTFont(path), {a: (1000 if a == ax else 0) for a in axes}) for ax in axes]
    glyphs = {}
    for code, name in sorted(cmap.items()):
        p, ends, fl = outline(default, name)
        w = default["hmtx"][name][0]
        g = {"w": w, "e": ends, "f": fl, "p": p, "d": {}}
        for k, inst in enumerate(full):
            q, _, _ = outline(inst, name)
            if len(q) != len(p):
                raise SystemExit(f"point count differs: {name} axis {axes[k]}")
            dp = [b - a for a, b in zip(p, q)]
            dw = inst["hmtx"][name][0] - w
            if any(dp) or dw:
                g["d"][k] = {"p": dp, "w": dw}
        glyphs[chr(code)] = g
    hhea = default["hhea"]
    data = {"name": f"Segmentor-0{i}", "upm": default["head"].unitsPerEm, "asc": hhea.ascent, "desc": hhea.descent,
            "axes": axes, "glyphs": glyphs}
    f = out / f"segmentor-0{i}.json"
    f.write_text(json.dumps(data, separators=(",", ":")))
    print(f.name, len(glyphs), "glyphs", f.stat().st_size // 1024, "KB")
