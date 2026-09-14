"""How a separator RUNS on this box, as one value instead of nine parameters.

WHY THIS EXISTS. `demucs_model`, `demucs_bin`, `device`, `backend`, `jobs`, `overlap`, `segment`,
`shifts` and `stem_format` were nine separate keyword arguments, hand-enumerated at four sites: the
`WorkerConfig` fields they come from, `dial_home`'s `stems_runner(...)` call, `stems_runner`'s own
signature, and the `engine_for(...)` call inside its `pick` closure. Adding one knob meant editing all
four, and every one of them was a place to forget it — which is exactly what happened to
`model_file_dir`, `models_dir` and `batch_size`: they exist on the engines, they are reachable from
nowhere, and the checkpoint caches they point at therefore go unused in production.

One frozen value collapses that to a single edit, and makes the set of tuning knobs something you can
read in one place rather than reconstruct from four.

WHAT IT IS NOT. Not general worker config: `ffmpeg_bin`, `ytdlp_bin` and `flac_level` stay separate
parameters because they are shared with plans that never separate anything (fetch encodes, align
downloads captions), and folding them in here would imply the align plan needs separation tuning. Not a
resolver either — `WorkerConfig` still decides the values and `engine_for` still decides which of them a
given engine can honour. This type only carries them across the gap.
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
    #: Torch device string (`cpu`, `cuda`, `cuda:1`, `xpu`, `mps`). Ignored by demucs-mlx, which takes none.
    device: str | None = None
    #: The RESOLVED hardware backend (`torch` / `mlx`), which selects the engine class for demucs.
    backend: str | None = None
    #: Parallel chunk jobs. Each holds its own model copy — memory for wall time.
    jobs: int | None = None
    #: Chunk overlap. Lower is faster with a small quality cost at chunk seams.
    overlap: float | None = None
    #: Chunk length, in seconds. Smaller cuts peak accelerator memory on a tight box.
    segment: int | None = None
    #: Averages N shifted predictions: better, and proportionally slower.
    shifts: int | None = None
    #: Container for the RAW scratch stems. See `vocabulary.StemFormat`.
    stem_format: StemFormat = StemFormat.FLAC

    def engine_kwargs(self, *, device: str | None = None) -> dict[str, Any]:
        """The kwargs `engine_for` expects, with an optional per-JOB device override.

        `device` wins over the field when given, because `resolve_engines` folds `params['device']` over
        the worker's own and separation must honour the same answer alignment and diarization do. Passing
        `None` keeps this worker's resolved device.

        Keys whose value is `None` are still included: `engine_for` filters them itself (`{k: v for k, v
        in kwargs.items() if v is not None}`), so one owner drops the empties rather than two.
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
        }
