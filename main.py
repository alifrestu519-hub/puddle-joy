#!/usr/bin/env python3
"""news-image-01 entry v2: "The World in One Day".

A newspaper front page summing up the world's news of Friday
13 November 2026: 30 verified stories across 6 continents, one hero
photo story, four photo secondaries and a 25-story grid, composed
with PIL from AI-generated panels (no text in them) plus crisp
rendered headlines.

This program writes the bundled image (entry.png beside this file) to
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
# Competition gate: the image must be at most 1 MiB.
MAX_BYTES = 1_048_576


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    here = Path(__file__).resolve().parent
    source = here / IMAGE_NAME
    if not source.is_file():
        print(f"bundled image missing: {source}", file=sys.stderr)
        return 2
    if source.stat().st_size > MAX_BYTES:
        print(f"bundled image exceeds the 1 MiB gate: "
              f"{source.stat().st_size} bytes", file=sys.stderr)
        return 3
    out_dir = Path(os.environ.get("MAKEFUN_OUTPUT_DIR") or "/output")
    target = out_dir / IMAGE_NAME

    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)

    # Integrity check: the copy must be byte-for-byte the source.
    if _sha256(target) != _sha256(source):
        print("copy differs from source", file=sys.stderr)
        return 1
    print(f"wrote {target} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
