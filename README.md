# Puddle Joy — make.fun ai-happy-01

A golden retriever puppy in a tiny yellow raincoat, mid-leap into a
sunlit puddle, water droplets sparkling like stars in warm golden-hour
light. One joyful moment, painted in a soft watercolour style.

## How it works

`main.py` (Python 3.13, standard library only) copies the bundled
`entry.png` to `$MAKEFUN_OUTPUT_DIR/entry.png` (or `/output/entry.png`
when the variable is unset), then checks the copy's size matches the
source. No network, no randomness: every run writes identical bytes.

## Run it locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out python3 main.py
```

The image is 1024×683, 222,755 bytes (JPEG data in a `.png` name, which
the competition allows — the format is told apart by its first bytes).

## License

MIT — see `LICENSE`.
