#!/usr/bin/env python3
"""Render the council app icon to a transparent RGBA PNG (no white background).
'C of nodes': dark rounded square + five blue-gradient dots strung on a THIN
connecting ring with a gap on the right — the council's C, made of models."""
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

# shared diagonal accent gradient (light top-left -> accent bottom-right)
c1, c2 = np.array([188, 217, 255]), np.array([74, 140, 240])
xx, yy = np.meshgrid(np.arange(W), np.arange(W))
t = np.clip((xx + yy) / (2 * W), 0, 1)
cg = (c1[None, None, :] * (1 - t[..., None]) + c2[None, None, :] * t[..., None]).astype(np.uint8)
accent = Image.fromarray(cg, "RGB").convert("RGBA")

Cx, Cy, R = sc(512), sc(512), sc(300)

# thin connecting arc (the open ring), gap on the right — warm amber, so the
# blue dots read as beads strung on an orange wire.
line_w = sc(24)
amber = (246, 160, 26, 255)   # #F6A01A
lmask = Image.new("L", (W, W), 0)
ImageDraw.Draw(lmask).arc([Cx - R, Cy - R, Cx + R, Cy + R], 55, 305, fill=255, width=line_w)
base.paste(Image.new("RGBA", (W, W), amber), (0, 0), lmask)

# five node dots on the ring
dot = sc(80)
angles = [305, 250, 180, 110, 55]   # degrees (PIL: x=cos, y=sin, y down)
nodes = [(Cx + R * math.cos(math.radians(a)), Cy + R * math.sin(math.radians(a))) for a in angles]
nmask = Image.new("L", (W, W), 0)
nd = ImageDraw.Draw(nmask)
for (nx, ny) in nodes:
    nd.ellipse([nx - dot, ny - dot, nx + dot, ny + dot], fill=255)

# soft glow behind the nodes
glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
glow.paste((106, 163, 255, 150), (0, 0), nmask)
base.alpha_composite(glow.filter(ImageFilter.GaussianBlur(sc(26))))

# fill the nodes with the accent gradient (on top of the thin ring)
base.paste(accent, (0, 0), nmask)

base.resize((1024, 1024), Image.LANCZOS).save("logo-master.png")
print("wrote logo-master.png (C of nodes on a thin ring)")
