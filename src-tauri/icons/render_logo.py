#!/usr/bin/env python3
"""Render the council app icon to a transparent RGBA PNG (no white background).
Monogram 'C': dark rounded square + a blue-gradient C stroke with round caps."""
from PIL import Image, ImageDraw, ImageFilter
import numpy as np
import math

S = 2                      # supersample factor for antialiasing
W = 1024 * S
def sc(v): return int(round(v * S))

base = Image.new("RGBA", (W, W), (0, 0, 0, 0))

# rounded-square background, vertical gradient, clipped to a rounded-rect mask
margin, rad = sc(64), sc(196)
mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([margin, margin, W - margin, W - margin], radius=rad, fill=255)
top, bot = np.array([42, 48, 64]), np.array([21, 23, 29])
ys = np.clip((np.arange(W) - margin) / (W - 2 * margin), 0, 1)
row = (top[None, :] * (1 - ys[:, None]) + bot[None, :] * ys[:, None]).astype(np.uint8)
grad = np.repeat(row[:, None, :], W, axis=1)
base.paste(Image.fromarray(grad, "RGB").convert("RGBA"), (0, 0), mask)

# --- C monogram mask: arc open on the right + rounded end caps ---
Cx, Cy, R = sc(512), sc(512), sc(300)
stroke = sc(122)
cmask = Image.new("L", (W, W), 0)
cd = ImageDraw.Draw(cmask)
cd.arc([Cx - R, Cy - R, Cx + R, Cy + R], 55, 305, fill=255, width=stroke)
cap = stroke // 2
for a in (55, 305):
    ex = Cx + R * math.cos(math.radians(a))
    ey = Cy + R * math.sin(math.radians(a))
    cd.ellipse([ex - cap, ey - cap, ex + cap, ey + cap], fill=255)

# soft glow behind the C
glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
glow.paste((106, 163, 255, 150), (0, 0), cmask)
base.alpha_composite(glow.filter(ImageFilter.GaussianBlur(sc(26))))

# diagonal gradient fill (light top-left -> accent bottom-right) through the mask
c1, c2 = np.array([176, 214, 255]), np.array([74, 140, 240])
xx, yy = np.meshgrid(np.arange(W), np.arange(W))
t = np.clip((xx + yy) / (2 * W), 0, 1)
cg = (c1[None, None, :] * (1 - t[..., None]) + c2[None, None, :] * t[..., None]).astype(np.uint8)
base.paste(Image.fromarray(cg, "RGB").convert("RGBA"), (0, 0), cmask)

base.resize((1024, 1024), Image.LANCZOS).save("logo-master.png")
print("wrote logo-master.png (transparent RGBA, monogram C)")
