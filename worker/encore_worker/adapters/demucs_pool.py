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


def _context(model: Any, chunk: Any, segment: Any) -> int:
    """Samples of song either side of a chunk that demucs's padding can read: half of up to one segment.

    A short final chunk is padded out to a whole segment (HTDemucs `valid_length`), so a chunk-length of
    context, enough for every other chunk, would leave zeros where `-j 1` reads the song (#1284 review).
    """
    seconds = segment if segment is not None else getattr(model, "segment", None)
    rate = getattr(model, "samplerate", None)
    whole = int(float(seconds) * rate) if seconds is not None and rate else 0
    return max(int(chunk.length), whole)


def _portable(chunk: Any, context: int) -> tuple[Any, int, int]:
    """The chunk with `context` samples of song either side, enough to pad it exactly as demucs would, rather
    than the whole song. As numpy, because torch would pass tensors through /dev/shm, which docker caps at
    64 MB by default (SIGBUS)."""
    total = chunk.tensor.shape[-1]
    start = max(0, chunk.offset - context)
    end = min(total, chunk.offset + chunk.length + context)
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
        import torch  # noqa: PLC0415

        self._workers = max(1, workers)
        # This process's threads are the separator's share (`thread_env`), split between the workers.
        self._threads = max(1, torch.get_num_threads() // self._workers)
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
        context = _context(model, chunk, kwargs.get("segment"))
        return _Tensor(self._pool.submit(_run, *_portable(chunk, context), kwargs))

    def shutdown(self, wait: bool = True) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=wait)
            self._pool = None


#: The line a `--serve` child prints when a song is done, then a JSON `{"ok": bool, "why": str}`.
DONE = "\x1eencore-separated"


def main(argv: list[str]) -> int:
    import demucs.apply  # noqa: PLC0415
    import demucs.separate  # noqa: PLC0415

    if argv[:1] == ["--serve"]:
        return serve()
    # demucs builds its `-j` pool by this name; ours stands in for it without being one.
    demucs.apply.ThreadPoolExecutor = ModelProcessPool  # type: ignore[misc,assignment]
    demucs.separate.main(argv)
    return 0


def serve() -> int:
    """Separate song after song, one `{"argv": [...]}` line on stdin each, keeping the model and its `-j` pool
    workers loaded between them (#1357): demucs reloads the model and builds a new pool every `main`, which
    was ~12 s of each song on the 32-core box. A song ends with a `DONE` line; stdin closing ends the
    child."""
    import json  # noqa: PLC0415
    import traceback  # noqa: PLC0415

    import demucs.apply  # noqa: PLC0415
    import demucs.separate  # noqa: PLC0415

    pools: dict[int, ModelProcessPool] = {}

    def pool(workers: int) -> ModelProcessPool:
        # One per `-j`, kept: the same model object reaches it every song, so its workers are not respawned.
        return pools.setdefault(workers, ModelProcessPool(workers))

    demucs.apply.ThreadPoolExecutor = pool  # type: ignore[misc,assignment]
    models: dict[tuple[str, str], Any] = {}
    load = demucs.separate.get_model_from_args

    def cached(args: Any) -> Any:
        key = (str(args.name), str(getattr(args, "repo", None)))
        if key not in models:
            models[key] = load(args)
        return models[key]

    demucs.separate.get_model_from_args = cached
    for line in sys.stdin:
        ok, why = True, ""
        try:
            demucs.separate.main(json.loads(line)["argv"])
        except SystemExit as exited:  # demucs exits on a file it cannot read
            ok, why = exited.code in (0, None), f"exit {exited.code}"
        except Exception as failed:  # noqa: BLE001 - reported to the worker, which retires this child
            traceback.print_exc()
            ok, why = False, f"{type(failed).__name__}: {failed}"
        print(f"{DONE} {json.dumps({'ok': ok, 'why': why})}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
