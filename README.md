# The World in One Day — news-image-01 (v2)

One image that sums up the world's news of Friday 13 November 2026:
**30 verified stories across 6 continents on one front page.**

- Hero: Europe joins the Ukraine peace talks (five-country team agreed
  in Dublin; work begins on the war's largest prisoner exchange).
- Four photo secondaries: Iran's claimed radar strike in Bahrain, U.S.
  flights resuming after the FAA ground stop, Taiwan on China's Pacific
  drills, Ebola cases passing 11,000.
- A 25-story grid grouped by continent (N. America 6, S. America 1,
  Europe 7, Africa 2, Asia 13, Oceania 1), each story with a headline,
  a one-line summary and a continent tag. Every story was checked
  against reporting of 13 November 2026 (BBC, Al Jazeera, Reuters, AP);
  unverified claims are attributed, never stated as fact.

## How it was made

The image was composed with PIL: AI-generated editorial panels (no text
in them) plus crisp rendered headlines, so every word in the image is
legible. The composer script and the six candidate layouts it produced
live outside this repository; this repo holds only the winning image
and the program that delivers it.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out python3 main.py
```

Writes `out/entry.png` (1024x1024 JPEG data, ~300 KB, within the
competition's 1 MiB gate). Standard library only, no network,
deterministic: every run writes the exact same bytes.

## License

MIT — see LICENSE.
