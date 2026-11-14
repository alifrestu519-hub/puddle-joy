# The Day in Pictures — make.fun news-image-01

A newspaper front page summing up the world's news of Friday 13
November 2026 in four pictures: Nvidia's CEO resigns, Ukraine fires
nearly 1,200 drones at Russia, US flights are grounded then resume
after an FAA halt, and China runs unannounced Pacific drills around
Taiwan. Headlines are rendered as crisp text over four clean editorial
illustrations, so the day reads at a glance.

## How it works

`main.py` (Python 3.13, standard library only) copies the bundled
`entry.png` to `$MAKEFUN_OUTPUT_DIR/entry.png` (or `/output/entry.png`
when the variable is unset), then checks the copy's size matches the
source. No network, no randomness: every run writes identical bytes.

## Run it locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out python3 main.py
```

The image is 1024×1024, 197,427 bytes (JPEG data in a `.png` name,
which the competition allows — the format is told apart by its first
bytes).

## Sources

Associated Press, Reuters, BBC, The Guardian — events of 13 November
2026.

## License

MIT — see `LICENSE`.
