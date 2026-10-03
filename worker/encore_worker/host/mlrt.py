"""The ML runtime's one process-wide lock.

One lock rather than one per model, in `host/` rather than beside a model, reentrant, and a threading lock
rather than an asyncio one — each of those four is a decision, argued in docs/arch/05-worker.md §9.1.
"""

from __future__ import annotations

import threading

#: Held while an ML model is LOADED or RUN, process-wide (docs/arch/05-worker.md §9.1).
ML_LOCK = threading.RLock()
