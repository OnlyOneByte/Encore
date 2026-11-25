"""torch demucs with `-j` chunks run in worker PROCESSES, each with its own copy of the model (#1130).

    python -m encore_worker.adapters.demucs_pool <demucs.separate argv>

demucs's own `-j` runs chunks on threads that share one model, and on CPU a chunk intermittently came back
NaN, saved as a silent song (#1125). This runs `demucs.separate` unchanged except for that pool: its
chunking, overlap blending, shifts and file writing are demucs's own, and only where a chunk is computed
moves. docs/arch/05-worker.md §2.6 has the measurement.
"""

from __future__ import annotations

import atexit
import multiprocessing
import os
import sys
from concurrent.futures import Future, ProcessPoolExecutor
from typing import Any

#: The model this worker process was given, set once by `_start`.
_MODEL: Any = None


def _start(model: bytes, threads: int) -> None:
    import io  # noqa: PLC0415

    import torch  # noqa: PLC0415

    global _MODEL
    torch.set_num_threads(threads)
    _MODEL = torch.load(io.BytesIO(model), weights_only=False)


def _bytes(model: Any) -> bytes:
    """The model serialised by value, for the same /dev/shm reason as `_portable`."""
    import io  # noqa: PLC0415

    import torch  # noqa: PLC0415

    buffer = io.BytesIO()
    torch.save(model, buffer)
    return buffer.getvalue()


def _run(audio: Any, offset: int, length: int, kwargs: dict[str, Any]) -> Any:
    import torch  # noqa: PLC0415
    from demucs.apply import TensorChunk, apply_model  # noqa: PLC0415

    chunk = TensorChunk(torch.from_numpy(audio), offset, length)
    return apply_model(_MODEL, chunk, **kwargs).numpy()


def _portable(chunk: Any) -> tuple[Any, int, int]:
    """The chunk over just enough of the song to pad it exactly as demucs would, not the whole song.

    `TensorChunk.padded` takes up to one segment of context from either side, so a slice one chunk wider on
    each side pads identically. As numpy, because torch would pass tensors through /dev/shm, which docker
    caps at 64 MB by default (SIGBUS).
    """
    total = chunk.tensor.shape[-1]
    start = max(0, chunk.offset - chunk.length)
    end = min(total, chunk.offset + 2 * chunk.length)
    return chunk.tensor[..., start:end].numpy().copy(), chunk.offset - start, chunk.length


class _Tensor(Future[Any]):
    """The worker's numpy result as the tensor demucs expects from `future.result()`."""

    def __init__(self, inner: Future[Any]) -> None:
        super().__init__()
        self._inner = inner

    def result(self, timeout: float | None = None) -> Any:
        import torch  # noqa: PLC0415

        return torch.from_numpy(self._inner.result(timeout))


class ModelProcessPool:
    """Stands in for the `ThreadPoolExecutor(num_workers)` demucs builds for `-j` on CPU.

    demucs submits `apply_model(model, chunk, **kwargs)`; the model goes to each worker once, when the pool
    starts, and only the chunk travels per submit. A bag of models runs its members one after another, so a
    new member replaces the pool rather than sharing it.
    """

    def __init__(self, workers: int) -> None:
        self._workers = max(1, workers)
        self._threads = max(1, (os.cpu_count() or 1) // self._workers)
        env = os.environ.get("OMP_NUM_THREADS", "")
        if env.isdigit() and int(env) > 0:
            self._threads = max(1, int(env) // self._workers)
        self._model: Any = None
        self._pool: ProcessPoolExecutor | None = None
        atexit.register(self.shutdown)

    def submit(self, fn: Any, model: Any, chunk: Any, **kwargs: Any) -> Future[Any]:
        if model is not self._model:
            self.shutdown()
            self._model = model
            # spawn, not fork: a child forked from a process that has run OpenMP can hang in libgomp.
            self._pool = ProcessPoolExecutor(
                self._workers,
                mp_context=multiprocessing.get_context("spawn"),
                initializer=_start,
                initargs=(_bytes(model), self._threads),
            )
        assert self._pool is not None
        kwargs.pop("pool", None)
        return _Tensor(self._pool.submit(_run, *_portable(chunk), kwargs))

    def shutdown(self, wait: bool = True) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=wait)
            self._pool = None


def main(argv: list[str]) -> int:
    import demucs.apply  # noqa: PLC0415
    import demucs.separate  # noqa: PLC0415

    demucs.apply.ThreadPoolExecutor = ModelProcessPool
    demucs.separate.main(argv)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
