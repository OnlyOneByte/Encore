"""How a separator RUNS on this box, as one value instead of nine parameters.

WHY THIS EXISTS. `demucs_model`, `demucs_bin`, `device`, `backend`, `jobs`, `overlap`, `segment`,
`shifts` and `stem_format` were nine separate keyword arguments, hand-enumerated at four sites: the
`WorkerConfig` fields they come from, `dial_home`'s `stems_runner(...)` call, `stems_runner`'s own
signature, and the `engine_for(...)` call inside its `pick` closure. Adding one knob meant editing all
four, and every one of them was a place to forget it — which is exactly what happened to
`model_file_dir`, `models_dir` and `batch_size`: each existed on an engine or its argv builder and was
reachable from nowhere.

The two checkpoint-cache flags are now wired, through `models_dir` below, and that is the payoff this type
was supposed to buy: one field here, one line in `config.separation_tuning`, and both CLIs receive it.

All three are now reachable. `batch_size` arrives as `mlx_batch_size` — named for its engine, because
demucs-mlx is the only CLI of the four with such a flag — and it is exposed with NO DEFAULT on purpose.
Reachable and unset are different things: the operator can now measure and choose, where before the flag
could not be supplied at all. Why no default, and the benchmark that would justify one, is on the field.

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
    #: demucs-mlx's `-b/--batch-size`. MLX-ONLY, and unset by default on purpose.
    #:
    #: Named for its engine because it reaches exactly one: the flag exists only on demucs-mlx, so a bare
    #: `batch_size` here would read as a knob the torch, roformer and audiosep engines also honour. They
    #: do not, and `engine_for`'s allowlist drops it for them.
    #:
    #: NO DEFAULT, pending a measurement. This repo's only batching data is SUMMARY.md §2 — BS-RoFormer on
    #: the 32-core Graviton box, batch 1 vs 4, 253s vs 247s, recorded as "batching is worthless (1.02x —
    #: 32 cores already saturate at batch 1)". That reasoning is exactly why it does not settle the MLX
    #: case: batching pays off when the device is UNDER-utilised at batch 1, which a saturated 32-core CPU
    #: is not and a Metal GPU waiting on per-call launch overhead may well be. Nothing on Apple Silicon has
    #: ever been measured here (SUMMARY.md's box table still says so), and the risk of guessing is
    #: asymmetric: batching trades memory for throughput, so a value that helps a 32 GB box can OOM a
    #: 16 GB one mid-song, which the room sees as a failed song. `docs/benchmarks/scripts/mlx_batch_bench.sh`
    #: produces the number; until it has been run, unset means demucs-mlx's own default applies.
    mlx_batch_size: int | None = None
    #: Where the big model checkpoints live, shared across processes on this box.
    #:
    #: The roformer and audio-separator CLIs each auto-download their checkpoint on FIRST USE — roughly
    #: 700 MB for roformer, hundreds of MB for audiosep — and each takes a flag saying where to keep it.
    #: Unset, each tool uses its own default location, which for a container is inside the container
    #: filesystem unless that path happens to be a mounted volume: the download then repeats on every
    #: fresh container. Pointing both at one directory under the media volume makes it once per box.
    #:
    #: ONE setting, two spellings, because the CLIs disagree: audio-separator wants `--model_file_dir`
    #: and bs-roformer-infer wants `--models_dir`. That is the CLIs' problem, not the operator's, so
    #: `engine_kwargs` emits both keys and `engine_for`'s per-engine allowlist keeps whichever applies.
    models_dir: str | None = None

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
            # Both spellings of the same directory; see `models_dir`. `engine_for` filters per engine, so
            # each CLI receives only the flag it actually understands.
            "model_file_dir": self.models_dir,
            "models_dir": self.models_dir,
            # Spelled as demucs-mlx's own constructor parameter; every other engine's allowlist drops it.
            "batch_size": self.mlx_batch_size,
        }
