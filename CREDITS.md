# Credits

Encore's own code is under the PolyForm Noncommercial License 1.0.0 (see [`LICENSE`](LICENSE)).
The third-party material (code and media) below is not: each item keeps its own licence, and PolyForm
does not apply to it. Where a licence asks for its notice to travel with the copy, the licence text sits
beside it.

## Code

| What | Where in this repo | Licence | Copyright | Licence text |
| --- | --- | --- | --- | --- |
| [shadcn-svelte](https://github.com/huntabyte/shadcn-svelte) components, vendored and edited | `core/src/lib/components/ui/` | MIT | Hunter Johnston, CokaKoala, shadcn | [`LICENSE`](core/src/lib/components/ui/LICENSE) |
| [Lucide](https://github.com/lucide-icons/lucide) icon geometry, copied as path data; some of these icons are derived from [Feather](https://github.com/feathericons/feather) | `core/src/lib/ui/icons.ts` | ISC; the Feather-derived ones also MIT | Lucide Icons and Contributors; Cole Bemis | [`icons.LICENSE`](core/src/lib/ui/icons.LICENSE) (lists the Feather-derived icons) |
| A patch to [svelte-adapter-bun](https://github.com/gornostay25/svelte-adapter-bun) 1.0.1, which carries lines of its `dist/index.js` | `core/patches/svelte-adapter-bun@1.0.1.patch` | MIT | Volodymyr Palamar | [`svelte-adapter-bun.LICENSE`](core/patches/svelte-adapter-bun.LICENSE) |

Installed dependencies (npm and PyPI packages) are not copied into this repo and keep their own licences;
`@lucide/svelte` is one of them, used by three of the vendored components.

## Data: Moby Hyphenator

`worker/encore_worker/domain/lyrics/data/mhyph.xz` is the Moby Hyphenator word list (Grady Ward's Moby
Project, Project Gutenberg ebook 3204), compressed. The repo records it as public domain
([`docs/arch/04-alignment.md`](docs/arch/04-alignment.md) §8).

## Model weights: MMS_FA

These weights are not in this repo; the worker downloads them at runtime. Their licence asks for
attribution, so they are credited here.

| Model | Source | Licence | Used for |
| --- | --- | --- | --- |
| **MMS_FA**, from _MMS: Scaling Speech Technology to 1,000+ Languages_, Pratap et al., Meta AI (2023), [arXiv:2305.13516](https://arxiv.org/abs/2305.13516) | [`torchaudio.pipelines.MMS_FA`](https://docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.MMS_FA.html), fetched by torchaudio into the local torch hub cache | [CC-BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) | forced alignment of romanised Chinese and Korean lyrics (the `mms-roman` route, [`docs/arch/04-alignment.md`](docs/arch/04-alignment.md) §14.2), used unmodified |

## Music: TheFatRat

The stem-separation and forced-alignment benchmarks use three songs by **TheFatRat**. The stems are
committed under `docs/benchmarks/benchmark-songs/`; each song's `truth-lines.json` holds its timed lyric
lines, taken from the official video's caption track.

| Song | Artist | Source | In this repo |
| --- | --- | --- | --- |
| Fly Away (feat. Anjulie) | TheFatRat | [YouTube](https://www.youtube.com/watch?v=cMg8KaMdDYo) | `tfr-flyaway/` |
| Mayday | TheFatRat & Laura Brehm | [YouTube](https://www.youtube.com/watch?v=DT61L8hbbJ4) | `tfr-mayday/` |
| The Chosen | TheFatRat | [YouTube](https://www.youtube.com/watch?v=9YHTVML4PTE) | `tfr-chosen/` |

Terms, as recorded in [`docs/benchmarks/stem-separation/README.md`](docs/benchmarks/stem-separation/README.md):
the tracks are released royalty-free *with attribution*, which is a licence condition rather than a
courtesy. Credit the artist in anything derived from this audio.

## Reaction artwork: Noto Emoji

`core/src/lib/assets/reactions/*.svg` are Noto Emoji artwork, Copyright Google LLC
([googlefonts/noto-emoji](https://github.com/googlefonts/noto-emoji)), used unmodified under the Apache
License 2.0. The licence and details are beside them in that folder (`LICENSE`, `README.md`).
