#!/usr/bin/env python3
"""Render the real `npm run redteam` output as a terminal-style PNG.

Reads mcp-server/redteam-report.json (written by the actual run) so the image
cannot drift from the suite. Nothing here is hand-typed.
"""
import json
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
REPORT = ROOT / "mcp-server" / "redteam-report.json"
OUT = ROOT / "demo" / "img" / "redteam-table.png"

BG = "#07080a"
CHROME = "#101216"
HAIRLINE = "#242728"
FG = "#c9d1d9"
DIM = "#6e7681"
GREEN = "#3fb950"
RED = "#f85149"
CYAN = "#58a6ff"
AMBER = "#d29922"

MONO = "/System/Library/Fonts/Menlo.ttc"


def font(size, index=0):
    return ImageFont.truetype(MONO, size, index=index)


def observed_label(refusal):
    """Same reduction the CLI applies, so the image matches the terminal."""
    if refusal is None:
        return "EXECUTED on production"
    for needle, label in (
        ("no simulation with id", "REFUSED no such simulation"),
        ("operation failed in sandbox", "REFUSED operation failed in clone"),
        ("rollback was NOT verified", "REFUSED rollback unverified"),
        ("graded this operation F", "REFUSED grade F"),
        ("production drifted since simulation", "REFUSED production drifted"),
    ):
        if needle in refusal:
            return label
    return refusal[:33]


def main():
    report = json.loads(REPORT.read_text())

    f_reg = font(19)
    f_bold = font(19, index=1)
    f_small = font(15)
    f_title = font(25, index=1)

    cols = [
        ("CASE", 5),
        ("ATTACK", 62),
        ("EXPECT", 9),
        ("OBSERVED", 34),
        ("PRODUCTION", 11),
        ("VERDICT", 7),
    ]
    ch_w = f_reg.getlength("M")
    gap = 2 * ch_w

    x_offsets = []
    x = 0
    for _, w in cols:
        x_offsets.append(x)
        x += w * ch_w + gap

    pad_x, pad_y = 42, 34
    header_h = 118
    row_h = 34
    body_h = header_h + 34 + 12 + row_h * len(report["results"]) + 78
    width = int(pad_x * 2 + x)
    height = int(pad_y * 2 + body_h)

    img = Image.new("RGB", (width, height), BG)
    d = ImageDraw.Draw(img)

    # window chrome
    d.rectangle([0, 0, width, 46], fill=CHROME)
    d.line([(0, 46), (width, 46)], fill=HAIRLINE)
    for i, c in enumerate(("#ff5f56", "#ffbd2e", "#27c93f")):
        d.ellipse([22 + i * 24, 17, 34 + i * 24, 29], fill=c)
    title = "npm run redteam"
    d.text(((width - f_small.getlength(title)) / 2, 16), title, font=f_small, fill=DIM)

    y = 46 + pad_y
    d.text((pad_x, y), "SafeRun  prove the gate", font=f_title, fill=FG)
    y += 40
    d.text(
        (pad_x, y),
        f"attacks run against the real execute path on a scratch database ({report['database']})",
        font=f_small,
        fill=DIM,
    )
    y += 22
    d.text((pad_x, y), report["ranAt"], font=f_small, fill=DIM)
    y += 40

    for (label, _), xo in zip(cols, x_offsets):
        d.text((pad_x + xo, y), label, font=f_bold, fill=CYAN)
    y += 28
    d.line([(pad_x, y), (width - pad_x, y)], fill=HAIRLINE)
    y += 12

    for r in report["results"]:
        control = r["expectation"] == "EXECUTION"
        attack = r["attack"]
        if len(attack) > 62:
            attack = attack[:61] + "\u2026"
        observed = observed_label(r["observedRefusal"])
        prod = "MUTATED" if not r["productionIntact"] else "unchanged"
        verdict = "PASS" if r["passed"] else "FAIL"

        cells = [
            (r["case"], AMBER if control else FG),
            (attack, DIM if control else FG),
            (r["expectation"], DIM),
            (observed, GREEN if control else FG),
            (prod, AMBER if control else DIM),
            (verdict, GREEN if r["passed"] else RED),
        ]
        for (text, color), xo in zip(cells, x_offsets):
            f = f_bold if color in (GREEN, RED) else f_reg
            d.text((pad_x + xo, y), text, font=f, fill=color)
        y += row_h

    y += 12
    d.line([(pad_x, y), (width - pad_x, y)], fill=HAIRLINE)
    y += 18
    d.text((pad_x, y), report["summary"], font=f_bold, fill=FG)
    y += 30
    verdict_line = (
        "PASS: every attack was refused and production was byte-identical afterwards."
        if report["allPassed"]
        else "FAIL: a gate did not hold."
    )
    d.text(
        (pad_x, y),
        verdict_line,
        font=f_bold,
        fill=GREEN if report["allPassed"] else RED,
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT)
    print(f"{OUT}  {img.size[0]}x{img.size[1]}")


if __name__ == "__main__":
    main()
