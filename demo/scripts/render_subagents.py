#!/usr/bin/env python3
"""Render the subagent fan-out from the real session log.

Reads docs/evidence/turn-v2-subagents.sse and shows the two read-only threads
the root agent spawned, with the JSON each one actually returned. The prompt
excerpt, thread names and counts are read from the log, not typed here.
"""
import json
import pathlib
import textwrap

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
SSE = ROOT / "docs" / "evidence" / "turn-v2-subagents.sse"
OUT = ROOT / "demo" / "img" / "subagent-fanout.png"

BG = "#07080a"
HAIR = "#242728"
PANEL = "#0d1117"
FG = "#e6edf3"
DIM = "#8b949e"
MUTED = "#6e7681"
BLUE = "#6a5cff"
GREEN = "#3fb950"

SANS = "/System/Library/Fonts/Helvetica.ttc"
MONO = "/System/Library/Fonts/Menlo.ttc"
SCALE = 2


def sans(sz, bold=False):
    return ImageFont.truetype(SANS, sz * SCALE, index=1 if bold else 0)


def mono(sz, bold=False):
    return ImageFont.truetype(MONO, sz * SCALE, index=1 if bold else 0)


def load():
    created, done = [], {}
    for line in SSE.read_text().splitlines():
        if not line.startswith("data:"):
            continue
        try:
            o = json.loads(line[5:])
        except json.JSONDecodeError:
            continue
        if o.get("type") == "thread.created":
            created.append(o["agent_info"])
        elif o.get("type") == "thread.done":
            done[o["title"]] = o["state"]["output"]["content"]
    return created, done


def main():
    created, done = load()
    img = Image.new("RGB", (1500 * SCALE, 676 * SCALE), BG)
    d = ImageDraw.Draw(img)

    def text(x, y, s, f, fill=FG, anchor="la"):
        d.text((x * SCALE, y * SCALE), s, font=f, fill=fill, anchor=anchor)

    def box(x, y, w, h, outline=HAIR, fill=PANEL):
        d.rounded_rectangle(
            [x * SCALE, y * SCALE, (x + w) * SCALE, (y + h) * SCALE],
            radius=8 * SCALE,
            fill=fill,
            outline=outline,
            width=SCALE,
        )

    text(48, 36, "The root agent fans out read-only threads before it touches anything", sans(22, True))
    text(
        48,
        68,
        "Each subagent gets the read-only tool and an explicit ban on the two write tools. Counts come back verified, not assumed.",
        sans(13),
        DIM,
    )

    # root
    box(48, 122, 1404, 96, outline=BLUE)
    text(72, 140, "root agent  (thread: main)", sans(15, True), BLUE)
    text(
        72,
        168,
        "preparing a destructive DELETE on the pagila production database, needs verified per-table row counts",
        sans(12),
        DIM,
    )
    text(1428, 140, f"{len(created)} threads spawned", mono(12), MUTED, anchor="ra")

    # constraint line, quoted from the real subagent prompt
    ban = "You must NEVER call execute_approved_operation or simulate_operation."
    assert any(ban in a["input"] for a in created), "ban line missing from log"
    box(48, 238, 1404, 44, fill="#0b0f14")
    text(72, 252, "every subagent prompt carries:", sans(12), MUTED)
    text(300, 252, f'"{ban}"', mono(12), GREEN)

    # threads
    y = 310
    for i, agent in enumerate(created):
        x = 48 + i * 716
        name = agent["name"]
        box(x, y, 688, 290)
        text(x + 22, y + 20, name, mono(14, True), FG)
        text(x + 22, y + 46, "read-only subagent", sans(11), MUTED)
        d.line(
            [(x + 22) * SCALE, (y + 70) * SCALE, (x + 666) * SCALE, (y + 70) * SCALE],
            fill=HAIR,
            width=SCALE,
        )

        text(x + 22, y + 84, "returned", sans(11, True), GREEN)
        payload = done.get(name, "")
        # keep only the JSON block the subagent returned
        if "```json" in payload:
            payload = payload.split("```json", 1)[1].split("```", 1)[0]
        lines = [ln for ln in payload.strip().splitlines()]
        for j, ln in enumerate(lines[:16]):
            text(x + 22, y + 108 + j * 16, ln[:74], mono(11), FG if ln.strip() else DIM)

        d.line(
            [
                (x + 344) * SCALE,
                (y - 28) * SCALE,
                (x + 344) * SCALE,
                (y - 4) * SCALE,
            ],
            fill=MUTED,
            width=SCALE,
        )

    text(
        48,
        620,
        "Those counts are what the root agent then scoped the operation against. It did not estimate them itself.",
        sans(12),
        DIM,
    )

    img.resize((1500, 676), Image.LANCZOS).save(OUT)
    print(f"{OUT.name}  1500x676  threads={[a['name'] for a in created]}")


if __name__ == "__main__":
    main()
