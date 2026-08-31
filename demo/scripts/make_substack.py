#!/usr/bin/env python3
"""Generate demo/BLOG-POST-SUBSTACK.md from demo/BLOG-POST.md.

Substack cannot resolve relative image paths, so each markdown image becomes an
[IMAGE: path - caption] placeholder and the italic caption line that followed it
is folded into that placeholder. A numbered upload checklist goes on top, in the
same order the placeholders appear.

Deriving this instead of hand-writing it means the two files cannot drift.
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "demo" / "BLOG-POST.md"
DST = ROOT / "demo" / "BLOG-POST-SUBSTACK.md"

IMG = re.compile(r"^!\[(?P<alt>[^\]]*)\]\((?P<path>[^)]+)\)\s*$")


def main():
    lines = SRC.read_text().splitlines()
    out, shots = [], []
    i = 0
    while i < len(lines):
        m = IMG.match(lines[i])
        if not m:
            out.append(lines[i])
            i += 1
            continue

        path = m.group("path")
        # The caption is the italic block that follows, after one blank line.
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        caption = ""
        if j < len(lines) and lines[j].lstrip().startswith("*"):
            block = []
            while j < len(lines) and lines[j].strip():
                block.append(lines[j].strip())
                j += 1
            caption = " ".join(block).strip("*").strip()
            i = j
        else:
            caption = m.group("alt")
            i += 1

        shots.append((path, caption))
        out.append(f"[IMAGE: {path} - {caption}]")

    checklist = [
        "# Substack upload checklist",
        "",
        f"{len(shots)} images, in the order they appear below. Every path is relative to",
        "`demo/` in the repo. Upload each one at its placeholder and paste the caption",
        "into Substack's caption field, then delete this checklist before publishing.",
        "",
    ]
    for n, (path, caption) in enumerate(shots, 1):
        short = caption if len(caption) <= 96 else caption[:93].rstrip() + "..."
        checklist.append(f"{n}. `{path}`")
        checklist.append(f"   {short}")
    checklist += ["", "---", ""]

    DST.write_text("\n".join(checklist + out) + "\n")
    print(f"{DST.relative_to(ROOT)}  {len(shots)} placeholders")
    for n, (p, _) in enumerate(shots, 1):
        exists = (ROOT / "demo" / p).exists()
        print(f"  {n:2d}. {'ok ' if exists else 'MISSING'} {p}")


if __name__ == "__main__":
    main()
