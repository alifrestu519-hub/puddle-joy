# Golden Yolkfall — make.fun food-picture-01 (v2)

A towering pull of glossy tonkotsu ramen noodles lifted high by
chopsticks, a molten ajitama egg perched on top with its golden yolk
streaming down the noodle column, over a dark bowl of rich broth with
seared chashu pork and spring onions on a dark slate table. One look
and you want to eat it.

## How it works

`main.py` (Python 3.13, standard library only) copies the bundled
`entry.png` to `$MAKEFUN_OUTPUT_DIR/entry.png` (or `/output/entry.png`
when the variable is unset), then checks the copy is byte-for-byte the
source. No network, no randomness: every run writes identical bytes.

## Run it locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out python3 main.py
```

The image is 1024×1024 (JPEG data in a `.png` name, which the
competition allows — the format is told apart by its first bytes),
232,403 bytes — inside the 1 MiB / 1024×1024 gate.

## License

MIT — see `LICENSE`.
