#!/usr/bin/env python3
"""Crop the real TrueForge session screenshots down to the part that carries
the point, so a Substack reader is not asked to hunt through a 2846px frame.

Every source here is a real capture from `demo/frames/` or `demo/frames-v2/`.
Nothing is redrawn; these are pixel crops plus an optional 2px border.

Note: `demo/frames/f*.png` is gitignored, so a fresh clone has the committed
crops in `demo/img/` but cannot re-run this script until those frames are
recaptured. `demo/frames/approval_gate.png` and `demo/frames-v2/` are tracked.
"""
import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "demo" / "img"
BORDER = "#242728"

# (source, output, box as fractions of (w, h), border?)
CROPS = [
    # Hero: the executed blast-radius report with the per-table delta table.
    ("demo/frames/f04.png", "hero-blast-radius.png", (0.33, 0.05, 1.0, 0.62)),
    # Tight: only the per-table row delta table.
    ("demo/frames/f04.png", "row-delta-table.png", (0.33, 0.175, 0.87, 0.60)),
    # The FK discovery that expanded the blast radius.
    ("demo/frames/f02.png", "fk-blast-radius.png", (0.295, 0.295, 0.855, 0.73)),
    # The agent asking before simulating, plus rollbackVerified: true.
    ("demo/frames/f03.png", "ask-user-question.png", (0.28, 0.135, 0.855, 0.50)),
    # rollbackVerified: true and rollbackResidue: [].
    ("demo/frames/f05.png", "rollback-verified.png", (0.28, 0.085, 0.855, 0.315)),
    # The harness approval gate: Allow / Deny, turn paused.
    ("demo/frames/approval_gate.png", "approval-gate.png", (0.34, 0.36, 0.87, 0.65)),
    # The execution receipt: redacted rollback, sha256 + length only.
    ("demo/frames-v2/f03.png", "execution-receipt.png", (0.32, 0.23, 0.82, 0.60)),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for src, name, box in CROPS:
        img = Image.open(ROOT / src)
        w, h = img.size
        l, t, r, b = box
        crop = img.crop((int(w * l), int(h * t), int(w * r), int(h * b)))
        framed = Image.new("RGB", (crop.width + 4, crop.height + 4), BORDER)
        framed.paste(crop, (2, 2))
        dst = OUT / name
        framed.save(dst)
        print(f"{name:26s} {framed.size[0]}x{framed.size[1]}  <- {src}")


if __name__ == "__main__":
    main()
