# Steam & Gold — make.fun food-picture-01

A steaming bowl of ramen in close-up: chopsticks lifting glossy
noodles from rich golden broth, a soft-boiled egg with a jammy yolk,
sliced chashu pork and spring onions, wisps of steam rising in warm
golden side light. One look and you want to eat it.

## How it works

`main.py` (Python 3.13, standard library only) copies the bundled
`entry.png` to `$MAKEFUN_OUTPUT_DIR/entry.png` (or `/output/entry.png`
when the variable is unset), then checks the copy's size matches the
source. No network, no randomness: every run writes identical bytes.

## Run it locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out python3 main.py
```

The image is 1024×683 (JPEG data in a `.png` name, which the
competition allows — the format is told apart by its first bytes).

## License

MIT — see `LICENSE`.
