"""How a separator RUNS on this box, as one value instead of nine parameters.

One frozen value collapses the tuning knobs (`demucs_model`, `device`, `backend`, `jobs`, `overlap`,
`segment`, `shifts`, `stem_format`, `models_dir`, ...) to a single owner: adding one means editing
this dataclass and `config.separation_tuning`, not every call site that forwards kwargs — a
per-site-enumeration is how `model_file_dir`, `models_dir` and `batch_size` previously ended up
declared on an engine but reachable from nowhere.

NOT general worker config: `ffmpeg_bin`, `ytdlp_bin` and `flac_level` stay separate because they are
shared with plans that never separate anything (fetch encodes, align downloads captions). NOT a
resolver either — `WorkerConfig` still decides the values and `engine_for` still decides which of
them a given engine can honour; this type only carries them across the gap.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..vocabulary import StemFormat


@dataclass(frozen=True)
class SeparationTuning:
    """The separator's own settings, resolved once per worker.

    Frozen because it is threaded through several layers: a mutable one would let a plan closure or a
    step quietly retune the box for every later job on the same runner.

    Every field is optional and `None` means DEFER — omitted from the engine's kwargs entirely, so the
    CLI's own default applies rather than a value this worker invented. That is why the defaults here are
    `None` rather than demucs's documented numbers: duplicating them would mean this file silently going
    stale the next time demucs changes one.
    """

    #: The demucs-family checkpoint (`htdemucs`, …). Maps to the matching engine's `default_model`.
    model: str | None = None
    #: The demucs executable, for a box that ships it under another name or path.
    demucs_bin: str = "demucs"
    #: Ignored by demucs-mlx, which takes none.
    device: str | None = None
    #: The RESOLVED hardware backend (`torch` / `mlx`), which selects the engine class for demucs.
    backend: str | None = None
    #: Each holds its own model copy: memory for wall time.
    jobs: int | None = None
    #: Lower is faster, with a small quality cost at chunk seams.
    overlap: float | None = None
    #: Seconds. Smaller cuts peak accelerator memory on a tight box.
    segment: int | None = None
    #: Averages N shifted predictions: better, and proportionally slower.
    shifts: int | None = None
    #: Container for the RAW scratch stems. See `vocabulary.StemFormat`.
    stem_format: StemFormat = StemFormat.FLAC
    #: MLX-ONLY, and UNSET by default on purpose: batching trades memory for throughput, so a value that
    #: helps a large-memory box can OOM a small one mid-song, and no Apple Silicon measurement exists yet.
    mlx_batch_size: int | None = None
    #: Shared across processes on this box. Each CLI auto-downloads hundreds of MB on FIRST USE into its own
    #: default location, which for a container without a mounted path repeats every fresh container.
    #:
    #: ONE setting, TWO spellings, because the CLIs disagree: `engine_kwargs` emits both keys and
    #: `engine_for`'s per-engine allowlist keeps whichever applies.
    models_dir: str | None = None

    def engine_kwargs(self, *, device: str | None = None) -> dict[str, Any]:
        """The kwargs `engine_for` expects, with an optional per-JOB device override.

        `device` wins over the field when given, since `resolve_engines` folds `params['device']` over
        the worker's own and separation must honour the same answer alignment and diarization do.

        Keys whose value is `None` are still included: `engine_for` filters them itself, so one owner
        drops the empties rather than two.
        """
        return {
            "backend": self.backend,
            "demucs_model": self.model or None,
            "demucs_bin": self.demucs_bin,
            "device": device if device is not None else self.device,
            "jobs": self.jobs,
            "overlap": self.overlap,
            "segment": self.segment,
            "shifts": self.shifts,
            "stem_format": self.stem_format,
            # Both spellings of one directory; `engine_for` filters, so each CLI sees only its own flag.
            "model_file_dir": self.models_dir,
            "models_dir": self.models_dir,
            # Spelled as demucs-mlx's own parameter; every other allowlist drops it.
            "batch_size": self.mlx_batch_size,
        }
