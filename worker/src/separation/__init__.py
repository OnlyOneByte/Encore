"""Separation: splitting a mix into the stems a room can sing over.

One engine per module, each behind the same processor seam:

  * `demucs` — htdemucs via the Demucs CLI. The default, and the fastest measured on CPU.
  * `roformer` — the BS-RoFormer family via `bs-roformer-infer`. Better on cymbal transients, and
    roughly 50x slower on CPU (measured: ~45 min vs ~50 s for a 2:51 song), so it is a GPU-box choice.

WHAT BELONGS HERE. Producing stems, and the audio policy around them: which container each stem is
stored in (BOTH stems lossless FLAC — the instrumental plays aloud and a second lossy
generation smears a crash cymbal, and the vocals stem is the GUIDING TRACK, a second audio element the TV
mixes UNDER the instrumental at up to full gain and pitch-shifts with the key, so it too plays aloud. The
retired rationale for the vocals being lossy AAC was that a guide mixed under a master tolerates
compression; both stems are FLAC now, so the two share one codec, one container, and a
sample-exact common start with no AAC priming-sample offset to trim). The
silence probe that refuses to publish a stem measured at the floor is a related audio-policy concern but
does not live here: `volumedetect_argv`/`parse_max_volume_db`/`is_silent`/`SILENCE_FLOOR_DB` are in
`processor.py`, consumed by `steps/separate.py`.

WHAT DOES NOT. Reading the stems back to describe the recording is `analysis/`. Getting the bytes in the
first place is `acquisition/`.

KNOWN SEAM PROBLEM, still recorded here but now pointed at the right sites. The yt-dlp half of this
has already been lifted out: S3 moved `download_argv`/`parse_ytdlp_progress` to `acquisition/fetch.py`
and removed the `from . import demucs as d` line from `roformer.py` (only `engines.py` still imports the
demucs module, and that is by design). What remains is the ffmpeg half. The argv builders
(`decode_argv`, `encode_flac_argv`) and the process plumbing
(`subprocess_runner`/`_iter_lines`/`_terminate`) still live in `demucs.py`, but they are not
demucs-specific: `steps/separate.py` decodes the input and encodes the outputs of a roformer process out
of them too, and `dial_home.py` builds the fetch and align runners on the same `subprocess_runner`.
Those are platform concerns (running a CLI, encoding audio) that ended up in an engine module because it
was the first to need them. Closing this means moving the ffmpeg builders and the subprocess runner into
a platform module and reducing `demucs.py` to demucs-specific argv, paths and progress parsing.
"""

from __future__ import annotations

__all__: list[str] = []
