#!/usr/bin/env python3
"""Render the SafeRun demo video.

This ffmpeg build has no drawtext and no subtitles filter, so every pixel of
text is composited with PIL and the video is encoded from a frame sequence.

What it adds over the previous slideshow:
  * a burned-in caption strip on every frame, synced to demo/narration.mp3
  * a real mouse cursor that travels to the Allow button and clicks it, with
    an expanding ripple, at the moment the narration says "a human clicks allow"
  * a 2-3% Ken Burns push so held frames never look frozen

Usage:  python3 render_demo.py        (run from demo/)
"""
import json
import os
import shutil
import subprocess

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FPS = 24
OUT = "out"
SEQ = os.path.join(OUT, "seq")
VIDEO = "saferun-demo.mp4"

FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf"
CAPTION_H = 120
CAPTION_ALPHA = int(0.72 * 255)
CAPTION_PT = 40

_img_cache = {}


def load(path):
    if path not in _img_cache:
        _img_cache[path] = Image.open(path).convert("RGB")
    return _img_cache[path]


def crop_box(im, zoom, pan):
    """16:9 crop window of `im` at the given zoom/pan. Returns (x0,y0,x1,y1)."""
    sw, sh = im.size
    target = W / H
    if sw / sh > target:
        ch, cw = sh, int(sh * target)
    else:
        cw, ch = sw, int(sw / target)
    zw, zh = cw / zoom, ch / zoom
    x0 = (sw - zw) / 2
    y0 = (sh - zh) * pan
    return (x0, y0, x0 + zw, y0 + zh)


def fit(im, zoom, pan):
    box = crop_box(im, zoom, pan)
    return im.resize((W, H), Image.LANCZOS, box=tuple(int(v) for v in box))


def map_point(im, zoom, pan, fx, fy):
    """Source-image fractional coords -> output frame pixel coords."""
    x0, y0, x1, y1 = crop_box(im, zoom, pan)
    sx, sy = fx * im.size[0], fy * im.size[1]
    return ((sx - x0) / (x1 - x0) * W, (sy - y0) / (y1 - y0) * H)


def wrap(draw, text, font, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= maxw:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def draw_caption(img, text, font):
    if not text:
        return img
    probe = ImageDraw.Draw(img)
    lines = wrap(probe, text, font, W - 160)
    lh = CAPTION_PT + 12
    bar_h = max(CAPTION_H, lh * len(lines) + 44)
    bar = Image.new("RGBA", (W, bar_h), (0, 0, 0, CAPTION_ALPHA))
    d = ImageDraw.Draw(bar)
    y = (bar_h - lh * len(lines)) / 2
    for ln in lines:
        tw = d.textlength(ln, font=font)
        # soft shadow keeps it legible over any background
        d.text(((W - tw) / 2 + 2, y + 2), ln, font=font, fill=(0, 0, 0, 190))
        d.text(((W - tw) / 2, y), ln, font=font, fill=(255, 255, 255, 255))
        y += lh
    img.alpha_composite(bar, (0, H - bar_h))
    ImageDraw.Draw(img).rectangle(
        [0, H - bar_h - 3, W, H - bar_h], fill=(124, 138, 255, 220))
    return img


CURSOR = [(0, 0), (0, 34), (9, 26), (15, 41), (21, 38), (15, 24), (25, 23)]


def draw_cursor(img, x, y, scale=1.7):
    d = ImageDraw.Draw(img)
    pts = [(x + px * scale, y + py * scale) for px, py in CURSOR]
    d.polygon([(px + 4, py + 4) for px, py in pts], fill=(0, 0, 0, 140))
    d.polygon(pts, fill=(255, 255, 255, 255), outline=(10, 10, 16, 255))
    return img


def draw_ripple(img, x, y, phase):
    r = 20 + 90 * phase
    a = int(220 * (1 - phase))
    ov = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    d.ellipse([x - r * 0.6, y - r * 0.6, x + r * 0.6, y + r * 0.6],
              fill=(150, 175, 255, int(a * 0.30)))
    d.ellipse([x - r, y - r, x + r, y + r], outline=(160, 185, 255, a), width=8)
    img.alpha_composite(ov)
    return img


def main():
    beats = json.load(open("storyboard.json"))
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(SEQ)
    font = ImageFont.truetype(FONT_PATH, CAPTION_PT)

    idx = 0
    click_frames = []
    for b in beats:
        dur = max(1, int(round((b["end"] - b["start"]) * FPS)))
        z1 = b.get("zoom", 1.0)
        z0 = b.get("zoom_from", 1.0)
        pan = b.get("pan", 0.0)
        click = b.get("click")
        src = load(b["img"])
        for k in range(dur):
            t = k / dur
            z = z0 + (z1 - z0) * t
            frame = fit(src, z, pan).convert("RGBA")
            if click:
                cx, cy = map_point(src, z, pan, click["x"], click["y"])
                at = click.get("at", 0.45)
                approach = min(1.0, t / max(at, 1e-3))
                ease = 1 - (1 - approach) ** 3
                sx, sy = cx - 330, cy + 250
                px, py = sx + (cx - sx) * ease, sy + (cy - sy) * ease
                if t >= at:
                    ph = min(1.0, (t - at) / 0.30)
                    frame = draw_ripple(frame, cx, cy, ph)
                    px, py = (cx + 3, cy + 3) if ph < 0.30 else (cx, cy)
                    click_frames.append(idx)
                frame = draw_cursor(frame, px, py)
            frame = draw_caption(frame, b.get("caption", ""), font)
            frame.convert("RGB").save(os.path.join(SEQ, "%05d.png" % idx))
            idx += 1
        print("  %-28s %6.2f-%6.2fs  %3d frames" % (
            b["img"], b["start"], b["end"], dur), flush=True)

    print("frames: %d  (%.2fs at %dfps)" % (idx, idx / FPS, FPS))
    if click_frames:
        print("click frames: %d-%d  (%.2fs-%.2fs)" % (
            click_frames[0], click_frames[-1],
            click_frames[0] / FPS, click_frames[-1] / FPS))

    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-framerate", str(FPS), "-i", os.path.join(SEQ, "%05d.png"),
        "-i", "narration.mp3",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart", VIDEO,
    ], check=True)
    print("wrote", VIDEO)


if __name__ == "__main__":
    main()
