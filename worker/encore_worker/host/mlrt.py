"""The ML runtime's one process-wide lock.

One lock rather than one per model, in `host/` rather than beside a model, reentrant, and a threading lock
rather than an asyncio one — each of those four is a decision, argued in docs/arch/05-worker.md §9.1.
"""

from __future__ import annotations

import contextlib
import threading
from typing import Any

#: Held while an ML model is LOADED or RUN, process-wide (docs/arch/05-worker.md §9.1).
ML_LOCK = threading.RLock()


def accelerator_lock(device: str) -> contextlib.AbstractContextManager[Any]:
    """`ML_LOCK` on a GPU or MPS device, so a subprocess separator never shares the card with a model.
    Nothing on CPU, where the thread split shares the cores (docs/arch/05-worker.md §9.1)."""
    return ML_LOCK if device != "cpu" else contextlib.nullcontext()
