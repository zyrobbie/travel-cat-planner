"""Export runtime-only images from the approved PNG originals.

Requires Pillow. Never writes to an original path. Generated WebP files are
committed so Pages does not need Pillow during deployment.
"""
from pathlib import Path
from PIL import Image
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
CAT_SOURCE = ROOT / "ui-components-v1/assets"
DAILY_SOURCE = ROOT / "ui-daily-core-v1/assets"
CAT_OUT = CAT_SOURCE / "web"
DAILY_OUT = DAILY_SOURCE / "web"


def export(source: Path, out_dir: Path, stem: str, widths: tuple[int, ...], quality: int):
    original = source.read_bytes()
    with Image.open(source) as image:
        image.load()
        records = []
        for width in widths:
            height = round(image.height * width / image.width)
            resized = image.resize((width, height), Image.Resampling.LANCZOS)
            target = out_dir / f"{stem}-{width}.webp"
            target.parent.mkdir(parents=True, exist_ok=True)
            resized.save(target, format="WEBP", quality=quality, method=6)
            records.append({"path": str(target.relative_to(ROOT)), "width": width,
                            "height": height, "bytes": target.stat().st_size})
    return {"source": str(source.relative_to(ROOT)), "source_bytes": len(original),
            "source_sha256": hashlib.sha256(original).hexdigest(), "runtime": records}


def main():
    report = []
    for n in range(1, 5):
        cat = f"cat-{n:02d}"
        report.append(export(CAT_SOURCE / f"V1-cat-fullbody-{cat}.png", CAT_OUT,
                             cat, (320, 640), 86))
    report.append(export(DAILY_SOURCE / "V1-home-main-empty.png", DAILY_OUT,
                         "home-empty", (600, 1200), 83))
    for n in range(1, 5):
        cat = f"cat-{n:02d}"
        suffix = "-V1" if n == 3 else ""
        report.append(export(DAILY_SOURCE / f"V1-home-window-{cat}{suffix}.png", DAILY_OUT,
                             f"need-window-{cat}", (600, 1200), 83))
        report.append(export(DAILY_SOURCE / f"V1-postcard-rhine-{cat}.png", DAILY_OUT,
                             f"postcard-rhine-{cat}", (600, 1200), 83))
        report.append(export(DAILY_SOURCE / f"V1-cat-avatar-{cat}.png", DAILY_OUT,
                             f"avatar-{cat}", (160,), 88))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
