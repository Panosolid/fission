"""The Image workspace's oracle: Pillow, a widely trusted image library,
writes small PNG and JPEG files and then reads back their pixel size and
density on its own. The TypeScript readers in workspaces/image must agree
with Pillow on every file (workspaces/image/test/oracle.test.ts), the way
the kernel is checked against OpenCascade.

Run from the repo root (needs Pillow):
    python3 prototypes/oracle/image_fixtures.py workspaces/image/test/fixtures

It rewrites the files and oracle.json in that folder; commit both.
"""

import json
import sys
from pathlib import Path

from PIL import Image

# (file name, width, height, save options)
CASES = [
    ("png-300dpi.png", 20, 10, {"dpi": (300, 300)}),
    ("png-254dpi.png", 200, 100, {"dpi": (254, 254)}),
    ("png-72dpi-odd.png", 7, 3, {"dpi": (72, 72)}),
    ("png-no-size.png", 5, 4, {}),
    ("jpeg-300dpi.jpg", 20, 10, {"dpi": (300, 300), "quality": 90}),
    ("jpeg-96dpi-progressive.jpg", 33, 17, {"dpi": (96, 96), "progressive": True}),
    ("jpeg-no-size.jpg", 8, 8, {}),
]


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    results = []
    for name, w, h, options in CASES:
        image = Image.new("RGB", (w, h))
        image.putdata([((x * 37) % 256, (y * 53) % 256, (x + y) % 256) for y in range(h) for x in range(w)])
        path = out / name
        image.save(path, **options)
        with Image.open(path) as back:
            dpi = back.info.get("dpi")
            # Pillow reports JFIF "aspect only" (units 0) as jfif_unit 0 with no dpi.
            if back.format == "JPEG" and back.info.get("jfif_unit", 0) == 0:
                dpi = None
            results.append({
                "file": name,
                "format": {"PNG": "png", "JPEG": "jpeg"}[back.format],
                "width": back.width,
                "height": back.height,
                "dpi": [float(dpi[0]), float(dpi[1])] if dpi else None,
            })
    (out / "oracle.json").write_text(json.dumps({"pillow": Image.__version__, "files": results}, indent=2) + "\n")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
