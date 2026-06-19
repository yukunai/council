#!/usr/bin/env python3
"""Generate the council app icons from logo-source.png.

The source image is already framed at the desired logo scale, so we center-crop
it to a square before exporting the Tauri/macOS/Windows icon sizes.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SOURCE = HERE / "logo-source.png"
MASTER = HERE / "logo-master.png"

PNG_SIZES = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "StoreLogo.png": 50,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
}

ICONSET_SIZES = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png"),
]


def square_master(size: int = 1024) -> Image.Image:
    src = Image.open(SOURCE).convert("RGBA")
    side = min(src.width, src.height)
    left = (src.width - side) // 2
    top = (src.height - side) // 2
    cropped = src.crop((left, top, left + side, top + side))
    return cropped.resize((size, size), Image.LANCZOS)


def save_pngs(master: Image.Image) -> None:
    master.save(MASTER)
    for name, size in PNG_SIZES.items():
        master.resize((size, size), Image.LANCZOS).save(HERE / name)
    public = ROOT / "public"
    public.mkdir(exist_ok=True)
    master.resize((64, 64), Image.LANCZOS).save(public / "logo.png")


def save_ico(master: Image.Image) -> None:
    master.save(
        HERE / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


def save_icns(master: Image.Image) -> None:
    iconset = HERE / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    for size, name in ICONSET_SIZES:
        master.resize((size, size), Image.LANCZOS).save(iconset / name)
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(HERE / "icon.icns")], check=True)
    shutil.rmtree(iconset)


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"missing {SOURCE}")
    master = square_master()
    save_pngs(master)
    save_ico(master)
    save_icns(master)
    print("generated council icons from logo-source.png")


if __name__ == "__main__":
    main()
