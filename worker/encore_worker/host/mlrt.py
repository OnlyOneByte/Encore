"""The ML runtime's one process-wide lock.

WHY ONE LOCK AND NOT ONE PER MODEL. The point is not mutual exclusion between checkpoints — it is that a
box with `ENCORE_WORKER_CONCURRENCY > 1` must not load two multi-GB models at once, nor run two inferences
that each expect the accelerator to themselves. Two jobs loading whisperx and demucs simultaneously on a
10 GB card is an OOM that reads as a model bug, and the second job's failure looks unrelated to the first
job's existence.

WHY IT LIVES IN `host/` rather than beside a model. Three users across two concerns: forced alignment, ASR,
and diarization. A lock shared by two concerns is not one of them lending it to the other; it is a property
of the PROCESS. The old worker learned this the hard way — it lived in the aligner, which forced the
diarizer to import from the lyrics module and created the only cross-domain import in that codebase.

AN RLock, NOT A Lock, because a loader may call into another guarded helper on the same thread — building
an aligner resolves a device, which may itself take the lock. A plain `Lock` self-deadlocks there.

NOT AN asyncio LOCK. Every guarded call runs inside `asyncio.to_thread`, so the contention is between OS
threads, not coroutines. An `asyncio.Lock` would not exclude anything here.
"""

from __future__ import annotations

import threading

#: Held while an ML model is LOADED or RUN. See the module docstring for why it is process-wide.
ML_LOCK = threading.RLock()
