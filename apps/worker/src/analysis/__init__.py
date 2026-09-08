"""Analysis: what a song IS, measured from its separated audio.

Not separation, and not lyrics. Separation splits a mix into stems; this reads those stems and reports
facts about the recording — musical key, and the vocal range a singer will actually be asked for:

  * `key_detect` — chromagram plus Krumhansl/Temperley correlation → pitch class + mode + confidence.
  * `vocal_range` — a pure-numpy pitch tracker over the vocals stem → lowest/highest voiced note.
  * `song_profile` — combines both into the one nullable JSON blob the core stores as `songProfile`.

WHY ITS OWN DOMAIN. This ran as an unnamed third stage inside separation, invoked from
`demucs.py` and `roformer.py` through two separate injectable `profiler` parameters. That gave it no
boundary and no visibility: its cost is invisible in `/metrics` because it is billed to SEPARATING, and
two call sites hand-assembling the same artifact dict is what let `songProfile` ship as a sibling of
`stems` where the core read it nested — a shape mismatch that would have stalled every cook at
"Separating vocals" forever, caught only by a parity guard added afterwards.

It is analysis of a recording, so it belongs beside neither the thing that produced the stems nor the
thing that reads the words. `docs/ARCHITECTURE.md` §7.1 makes it an explicit `KeyAndRange`
step in both separation plans, which is what finally makes it measurable.

PURE by construction: numpy in, dict out. No subprocess, no network, no torch.
"""

from __future__ import annotations

from .key_detect import detect_key
from .loudness import measure_lufs
from .song_profile import build_song_profile, empty_profile
from .vocal_range import PitchFrame, extract_pitch_track, summarize_range

__all__ = [
    "PitchFrame",
    "build_song_profile",
    "detect_key",
    "empty_profile",
    "extract_pitch_track",
    "measure_lufs",
    "summarize_range",
]
