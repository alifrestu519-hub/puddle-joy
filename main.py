#!/usr/bin/env python3
"""food-picture-01 entry v2: "Golden Yolkfall".

A towering pull of glossy tonkotsu ramen noodles lifted high by
chopsticks, a molten ajitama egg perched on top with its golden yolk
streaming down the noodle column, over a dark bowl of rich broth with
seared chashu and spring onions on a dark slate table.

Writes the bundled image (entry.png beside this file) to
$MAKEFUN_OUTPUT_DIR/entry.png, or /output/entry.png when the variable
is unset. Standard library only, no network, no randomness: every run
writes the exact same bytes, so the two grader runs are identical.
"""

import hashlib
import os
import shutil
import sys
from pathlib import Path

IMAGE_NAME = "entry.png"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _jpeg_dimensions(path: Path):
    """Best-effort JPEG dimension probe, pure standard library.

    Walks the JPEG markers to the first start-of-frame segment and
    returns (width, height). Returns None when the file is not a JPEG
    or the size markers cannot be found. Never raises: a probe failure
    must not fail the run, the gate scorer has the final word.
    """
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return None
    pos = 2
    while pos + 9 <= len(data):
        if data[pos] != 0xFF:
            return None
        marker = data[pos + 1]
        if marker == 0xD9:  # end of image before any size marker
            return None
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            pos += 2  # standalone markers carry no length field
            continue
        seg_len = int.from_bytes(data[pos + 2:pos + 4], "big")
        if seg_len < 2 or pos + 2 + seg_len > len(data):
            return None
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                      0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            height = int.from_bytes(data[pos + 5:pos + 7], "big")
            width = int.from_bytes(data[pos + 7:pos + 9], "big")
            return (width, height)
        pos += 2 + seg_len
    return None


def main() -> int:
    here = Path(__file__).resolve().parent
    source = here / IMAGE_NAME
    if not source.is_file():
        print(f"bundled image missing: {source}", file=sys.stderr)
        return 2
    out_dir = Path(os.environ.get("MAKEFUN_OUTPUT_DIR") or "/output")
    target = out_dir / IMAGE_NAME

    # Gate self-check: the competition allows at most 1024x1024 pixels.
    dims = _jpeg_dimensions(source)
    if dims is not None and (dims[0] > 1024 or dims[1] > 1024):
        print(f"bundled image too large: {dims[0]}x{dims[1]}", file=sys.stderr)
        return 3

    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)

    # Integrity check: the copy must be byte-for-byte the source.
    if _sha256(target) != _sha256(source):
        print("copy differs from source", file=sys.stderr)
        return 1
    size_note = f", {dims[0]}x{dims[1]}" if dims else ""
    print(f"wrote {target} ({target.stat().st_size} bytes{size_note})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
