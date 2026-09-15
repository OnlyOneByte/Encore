"""The ML runtime's one process-wide lock.

WHY IT IS NOT IN A DOMAIN. `ML_LOCK` serialises loading and running the heavy models: whisperx forced
alignment (`lyrics/aligner.py`), whisper ASR (`lyrics/asr.py`), and pyannote diarization
(`diarize/diarizer.py`). Three users, two domains.

It used to live in `lyrics/aligner.py` because alignment was the first thing that needed it, which made
`diarize/diarizer.py` import `..lyrics.timing` (that file is `lyrics/aligner.py` now) — the ONLY
domain-to-domain import in the whole worker, and
one no guard forbade. A lock shared by two domains is not a lyrics concern that diarize borrows; it is a
property of the process. So it lives at the root, where anything may read it and nothing owns it.

WHY ONE LOCK AND NOT ONE PER MODEL. The point is not mutual exclusion between checkpoints, it is that a
box with `ENCORE_WORKER_CONCURRENCY > 1` must not load two multi-GB models at once, or run two inferences
that each expect the accelerator to themselves. An RLock because a loader may call into another guarded
helper on the same thread.
"""

from __future__ import annotations

import threading

#: Held while an ML model is LOADED or RUN. See the module docstring for why it is process-wide.
ML_LOCK = threading.RLock()
