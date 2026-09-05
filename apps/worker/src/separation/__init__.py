"""Separation: splitting a mix into the stems a room can sing over.

One engine per module, each behind the same processor seam:

  * `demucs` — htdemucs via the Demucs CLI. The default, and the fastest measured on CPU.
  * `roformer` — the BS-RoFormer family via `bs-roformer-infer`. Better on cymbal transients, and
    roughly 50x slower on CPU (measured: ~45 min vs ~50 s for a 2:51 song), so it is a GPU-box choice.

WHAT BELONGS HERE. Producing stems, and the audio policy around them: which container each stem is
stored in (instrumental FLAC because it plays aloud and a second lossy generation smears a crash cymbal;
vocals AAC because nothing plays it), and the silence probe that refuses to publish a stem measured at
the 16-bit floor.

WHAT DOES NOT. Reading the stems back to describe the recording is `analysis/`. Getting the bytes in the
first place is `acquisition/`.

KNOWN SEAM PROBLEM, recorded rather than fixed here. `roformer` does `from . import demucs as d` to
borrow the argv builders and the subprocess runner, and `acquisition/fetch` and `../whisperx` reach in
for the same things. Those are platform concerns (running a CLI, parsing yt-dlp progress) that ended up
living in an engine module because it was the first to need them.
`docs/archive/specs/SPEC-worker-pipeline.md` S3 lifts them out; this stage only moved files, so the borrowing is
unchanged and still ugly.
"""
from __future__ import annotations

__all__: list[str] = []
