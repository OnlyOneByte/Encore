# The Encore worker

Python. Dials home to core over a WebSocket, takes one job at a time, and does the heavy lifting: download
audio, split it into stems, find the words, put the words on the clock.

This file is the map. **The reasoning lives in the module docstrings** — every file here opens with why it
is the way it is, and those are the primary documentation. What was missing was a way to tell which file to
open, which is what this is for. The pipeline itself is
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §7.

## Start here

```bash
python -m src            # or the long-standing python -m src.dial_home; both run the same loop
```

Two settings and everything else is measured:

```bash
ENCORE_CORE_WS='ws://localhost:3000/ws?role=worker' MEDIA_DIR=../media python -m src.dial_home
```

The worker connects **to** core, never the reverse. Read `dial_home.py` first: it is the protocol loop, and
every other file exists to serve one of its job types.

## The layout, and why it is shaped this way

Four layers. The arrows are the only direction imports may run, and
[`tests/test_worker_layers.py`](tests/test_worker_layers.py) fails the build if one runs the other way.

```
host/          what this BOX is            hardware, backends, capabilities, config, mediastore, ffmpeg
   |
runtime/       pure MECHANISM              ctx, step, plan, runner        (knows nothing about audio)
   |
plans.py       the ONE seam                the only module importing both runtime and steps
   |
steps/         thin ORCHESTRATION          acquire, separate, lyrics/, diarize, metadata, key_and_range
   |
domains        the actual WORK             lyrics/ separation/ analysis/ acquisition/ metadata/ diarize/
```

- **A domain never imports a step or the runtime.** It is testable with no plan and no job.
- **A domain never imports another domain.** They are siblings, not a hierarchy. Anything two of them need
  lives above them — `mlrt.py`'s `ML_LOCK` is the example, and it used to live inside `lyrics/`.
- **`plans.py` is the only place the mechanism meets the work.** If you are wiring a new step into a job,
  that is the file.
- **`host/` is read by everything and reads nothing.** Measured facts plus operator intent.

## Where things are

| I want to… | Read |
|---|---|
| see the whole protocol loop | `dial_home.py` |
| know what builds the job runners | `bootstrap.py` — the composition root, every import lazy on purpose |
| add or change a job type | `plans.py`, then `steps/` |
| understand what a box will accept | `host/capabilities.py` |
| change how stems are separated | `separation/engines.py`, then the per-CLI module beside it |
| follow how lyrics are chosen | `lyrics/grading.py` → `lyrics/registry.py` → `steps/lyrics/grade.py` |
| follow how lyrics are timed | `steps/lyrics/align.py` |
| find a shared enum or token | `vocabulary.py` |
| know why a job retried | `retry_policy.py` |

`steps/lyrics/` is a package rather than one file because the lyrics pipeline has six steps where every
other job type has one to four: `acquire` gets words, `grade` chooses which words, `align` puts them on
this recording's clock, `publish` hands them to core, and `pinned` is the re-time path the first three all
touch.

## The gates

All four must be clean. There is no CI on this repo, so these are the whole verification story.

```bash
pip install -r requirements-test.txt   # once — pytest, its two plugins, ruff, mypy
pytest -q                    # 1032 tests, asyncio_mode=auto
ruff check .                 # lint
ruff format --check .        # ruff is the formatter; there is no separate black
mypy                         # config in pyproject.toml
```

The tooling is declared in `requirements-test.txt`, separately from `requirements.txt`, so running the
gates costs five small pure-Python packages instead of a multi-GB torch stack — every heavy seam the suite
touches is faked. Add `-r requirements.txt` on top only to run a REAL job.

**RUN THIS ON PYTHON 3.12.** That is what the pins resolve against (`requirements.txt`'s own note says
"py3.12/aarch64", and mypy targets 3.12), and it is not a preference: `scipy==1.16.2` declares
`Requires-Python >=3.11`, so on a 3.10 interpreter pip refuses it outright — no wheel, no fallback. The
five loudness tests import it transitively through `pyloudnorm` and fail on that import rather than on any
logic.

**TEN tests are environment-bound, and a 3.10 box is one of the environments they bind against.** Measured
there: 1021 pass, 10 fail, 1 skipped. The five loudness cases and the real-encode guide-mix case need
`scipy` / `pyloudnorm` / `soundfile` (all in `requirements.txt`, none reachable on 3.10 per the paragraph
above). Three `test_hardware` cases read Linux cgroup and CPU-affinity interfaces macOS does not have, and
one demucs case asserts POSIX child-reaping semantics. None of the ten is a signal about the code — but do
not read a 1021 as green either, because the loudness half of `build_song_profile` is genuinely unverified
when they are skipped for the wrong reason.

**A green suite is the floor, not the bar.** This box has numpy and scipy only, so **no heavy seam is ever
executed here** — every test fakes torch, demucs, whisperx and pyannote. That is the right trade for
testing logic, and it is also how a broken `pyannote` keyword argument survived a green suite through an
entire release. When you change a seam that talks to a real model or a real CLI, the test proves the argv
or the kwarg; only a real job proves the integration.

## Things that will surprise you

- **The heavy imports are lazy, deliberately.** `bootstrap.py` imports torch, demucs and whisperx *inside*
  functions so a fetch-only box never pays for them. An import moved to the top of a module will load
  multi-GB of ML into a process that only shells out to yt-dlp.
- **Capabilities are probed, never declared.** `ENCORE_WORKER_CAPABILITIES` can only *narrow* what a box
  advertises. A capability whose tool is missing is reported as loudly as one that is present, because that
  line is what explains a song stuck at 0%.
- **`docs/ARCHITECTURE.md` §7.1 is generated.** Change a step's declared reads or writes and regenerate it
  with `python3 -m src.docgen --write`, or a test fails.
