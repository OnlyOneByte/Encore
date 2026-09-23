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
    #: demucs-mlx's `-b/--batch-size`. MLX-ONLY (named for its engine; `engine_for`'s allowlist drops
    #: it for torch/roformer/audiosep) and unset by default on purpose: batching trades memory for
    #: throughput, so a value that helps a large-memory box can OOM a small one mid-song. No
    #: measurement exists yet for Apple Silicon (only CPU RoFormer batching has been benchmarked, and
    #: found worthless there — which does not transfer, since a saturated CPU and an under-utilised
    #: GPU behave oppositely). Unset means demucs-mlx's own default applies.
    mlx_batch_size: int | None = None
    #: Where the big model checkpoints live, shared across processes on this box. The roformer and
    #: audio-separator CLIs each auto-download their checkpoint on FIRST USE (hundreds of MB) into
    #: their own default location, which for a container without a mounted path repeats the download
    #: every fresh container. Pointing both at one directory under the media volume makes it once per box.
    #:
    #: ONE setting, two spellings, since the CLIs disagree: audio-separator wants `--model_file_dir`
    #: and bs-roformer-infer wants `--models_dir`. `engine_kwargs` emits both keys and `engine_for`'s
    #: per-engine allowlist keeps whichever applies.
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
            # Both spellings of the same directory; see `models_dir`. `engine_for` filters per engine, so
            # each CLI receives only the flag it actually understands.
            "model_file_dir": self.models_dir,
            "models_dir": self.models_dir,
            # Spelled as demucs-mlx's own constructor parameter; every other engine's allowlist drops it.
            "batch_size": self.mlx_batch_size,
        }
