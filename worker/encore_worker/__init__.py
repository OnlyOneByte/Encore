"""Encore worker - durable audio/lyrics processing as DBOS workflows.

Eight layers, dependencies pointing DOWN only: `protocol/`, `transport/`, `host/`, `adapters/`, `steps/`,
`workflows/`, `domain/`, `artifacts/`. What each may import, and the guard test that holds them to it:
docs/arch/05-worker.md §1 (XA-15), with the state machine in README.md.
"""

import os

# Here, before any submodule can import onnxruntime: its telemetry phones home and writes `:memory:.ses` into
# the working directory (#1307). `setdefault`, so an operator can still turn it back on.
os.environ.setdefault("ORT_DISABLE_TELEMETRY", "1")
