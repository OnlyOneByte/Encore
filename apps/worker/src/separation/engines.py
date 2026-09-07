"""The separator engines, behind one seam.

`Separate` is one step, and the two engines differ in real ways — not cosmetically. Enumerated here so
the step can be engine-agnostic without pretending the differences do not exist:

|                    | demucs                                  | roformer                                  |
|--------------------|-----------------------------------------|-------------------------------------------|
| decoded input      | one WAV anywhere in scratch             | must be ALONE in its own directory        |
| separate takes     | the input FILE                          | the input DIRECTORY                       |
| progress           | parseable percentages                   | tqdm, not a stable source → coarse 0→100  |
| output location    | DETERMINISTIC from the model name       | DISCOVERED by globbing the store          |

`roformer` separates every WAV in `--input_folder`, which is why its decoded input needs a dedicated
directory rather than the shared scratch dir that also holds its output.

WHAT THIS SEAM IS NOT. It is not a place to unify the argv builders or the path helpers — those stay in
`demucs.py` and `roformer.py`, unchanged, because they encode measured behaviour of two CLIs. This only
lets one step ask both engines the same four questions.
"""

from __future__ import annotations

import os
from typing import Protocol

from ..retry_policy import PermanentError
from . import demucs as d
from . import roformer as r


class SeparatorEngine(Protocol):
    """What `Separate` needs to know about an engine, and nothing more."""

    id: str
    backend: str

    def resolve_model(self, params: dict) -> str: ...
    def input_wav(self, work: str) -> str: ...
    def separate_argv(self, input_wav: str, out_dir: str, model: str) -> list[str]: ...
    def parse_progress(self, line: str) -> int | None: ...
    def find_outputs(self, out_dir: str, model: str) -> dict[str, str | None]: ...


class DemucsEngine:
    """htdemucs via the Demucs CLI. The default, and the fastest measured on CPU."""

    id = "demucs"

    def __init__(
        self,
        *,
        default_model: str = d.DEFAULT_MODEL,
        demucs_bin: str = "demucs",
        device: str | None = None,
        jobs: int | None = None,
        overlap: float | None = None,
        segment: int | None = None,
        shifts: int | None = None,
        backend: str = "torch",
    ) -> None:
        self._default_model = default_model
        self._bin = demucs_bin
        self._device = device
        self._jobs = jobs
        self._overlap = overlap
        self._segment = segment
        self._shifts = shifts
        # `backend` is the RESOLVED hardware backend this cook runs through (backends.resolve_backend),
        # recorded into facts so the ledger matches the startup log — not a hardcoded class constant. The
        # torch CLI is the only demucs backend actually implemented here; MLX resolves to MlxDemucsEngine,
        # which refuses at construction rather than reaching this class under an "mlx" label (#119).
        self.backend = backend

    def resolve_model(self, params: dict) -> str:
        """The checkpoint is per-JOB (the room's chosen model rides in params), not a worker constant.
        A raise here means the room asked for a model this build does not carry."""
        return d.resolve_demucs_model(params, self._default_model)

    def input_wav(self, work: str) -> str:
        return os.path.join(work, "input.wav")

    def separate_argv(self, input_wav: str, out_dir: str, model: str) -> list[str]:
        return d.demucs_argv(
            input_wav,
            out_dir,
            model,
            self._bin,
            device=self._device,
            jobs=self._jobs,
            overlap=self._overlap,
            segment=self._segment,
            shifts=self._shifts,
        )

    def parse_progress(self, line: str) -> int | None:
        return d.parse_demucs_progress(line)

    def find_outputs(self, out_dir: str, model: str) -> dict[str, str | None]:
        inst = d.demucs_no_vocals_path(out_dir, model)
        vox = d.demucs_vocals_path(out_dir, model)
        return {
            "instrumental": inst if os.path.exists(inst) else None,
            "vocals": vox if os.path.exists(vox) else None,
        }


class MlxDemucsEngine:
    """The demucs family through `demucs-mlx` — Apple-Silicon Metal execution of the SAME htdemucs
    checkpoints, selected by `backends.resolve_backend` when MLX is available (Apple Silicon + the
    `demucs_mlx` package importable).

    NOT YET IMPLEMENTED, and it refuses at construction on purpose (#119). The backend selection is now
    genuinely wired — a Mac that resolves `mlx` builds THIS engine rather than silently building
    `DemucsEngine` under an "mlx" label, which was the whole defect: the startup log announced `mlx`
    while `facts.backend` recorded `torch`, and the accelerated path never ran.

    The runtime is deferred because its CLI output contract cannot be verified without a real
    Apple-Silicon Mac with `demucs-mlx` installed: `demucs-mlx` may accept `--two-stems vocals` and
    yield the 2-stem `<model>/{vocals,no_vocals}.wav` layout the rest of the pipeline expects, OR it may
    emit four stems (vocals/drums/bass/other) with the instrumental derived as a mix-minus-vocals ffmpeg
    pass. Guessing that contract wrong would ship a broken instrumental on every Mac worker, so the
    implementation is tracked as a needs-owner / needs-repro follow-up.

    PermanentError (retryable=False, #443/#571/#583): an unimplemented backend is a deterministic
    configuration state — every retry fails identically — so it must fail fast and loud at worker
    startup rather than burn three attempts or, worse, downgrade silently to CPU torch.
    """

    id = "demucs"

    def __init__(self, **_kwargs: object) -> None:
        raise PermanentError(
            "mlx backend selected but the demucs-mlx engine is not implemented; "
            "set ENCORE_SEPARATOR_BACKEND=torch, or leave it unset to auto-select an available backend"
        )


class RoformerEngine:
    """The BS-RoFormer family via `bs-roformer-infer`.

    Better on cymbal transients, and roughly 50x slower than htdemucs on CPU (measured: ~45 min against
    ~50 s for a 2:51 song), so it is a GPU-box choice rather than a default.
    """

    id = "roformer"
    backend = "bs-roformer-infer"

    def __init__(
        self,
        *,
        default_model: str = r.DEFAULT_ROFORMER_MODEL,
        roformer_bin: str = "bs-roformer-infer",
        device: str | None = None,
    ) -> None:
        self._default_model = default_model
        self._bin = roformer_bin
        self._device = device

    def resolve_model(self, params: dict) -> str:
        return r.resolve_roformer_slug(params, self._default_model)

    def input_wav(self, work: str) -> str:
        """A DEDICATED directory, because bs-roformer-infer separates every WAV in --input_folder — the
        shared scratch dir also holds its output, so a single input.wav there would be re-separated."""
        in_dir = os.path.join(work, "roformer_in")
        os.makedirs(in_dir, exist_ok=True)
        return os.path.join(in_dir, "input.wav")

    def separate_argv(self, input_wav: str, out_dir: str, model: str) -> list[str]:
        return r.roformer_argv(os.path.dirname(input_wav), out_dir, model, device=self._device, bin=self._bin)

    def parse_progress(self, line: str) -> int | None:
        return None  # tqdm output is not a stable pct source; the step emits a coarse 0→100

    def find_outputs(self, out_dir: str, model: str) -> dict[str, str | None]:
        return {
            "instrumental": r.find_roformer_instrumental(out_dir),
            "vocals": r.find_roformer_vocals(out_dir),
        }


def engine_for(name: str, *, backend: str | None = None, **kwargs) -> SeparatorEngine:
    """The engine this job resolved to, executed through the resolved `backend`.

    Unknown names raise — the CORE only routes a roformer cook to a worker advertising `stems:roformer`, so
    an unknown name here is a routing bug rather than a user choice.

    `backend` is the hardware backend `backends.resolve_backend` picked for THIS worker (torch/mlx). It
    selects WHICH demucs implementation runs and is recorded into `facts.backend`, so the ledger matches
    the backend the startup log announced (#119). Before this it reached nothing but a print, so a Mac
    resolving `mlx` still built the torch `DemucsEngine` and recorded `torch` — the log lied. `mlx` now
    builds `MlxDemucsEngine`, which refuses loudly at construction until the demucs-mlx runtime is
    implemented; `torch` (or None, the portable default) builds the real `DemucsEngine`. Roformer runs
    only through its own CLI, so a backend other than that impl is not applicable to it.

    None-valued kwargs are DROPPED, not forwarded. A caller that has no opinion about `jobs` or a model
    passes None, and forwarding it would override the engine's own default with nothing — and for the model
    that means resolve_*_model() gets None as its fallback and fails on a job that carried no model.

    The model default is per ENGINE, not shared: a caller passes `demucs_model` and/or `roformer_model`,
    and only the matching engine's value is mapped to its `default_model`. A single engine-agnostic
    `default_model` slot let a caller hand one engine the OTHER engine's checkpoint name (issue #84: the
    lone production caller supplied the demucs default, which reached `RoformerEngine` and made
    `DEFAULT_ROFORMER_MODEL` unreachable — a roformer cook without a `model` then raised naming a demucs
    checkpoint). Keeping the names engine-specific makes that cross-wiring inexpressible.
    """
    given = {k: v for k, v in kwargs.items() if v is not None}
    if name == RoformerEngine.id:
        allowed = {"roformer_bin", "device"}
        kw = {k: v for k, v in given.items() if k in allowed}
        if "roformer_model" in given:
            kw["default_model"] = given["roformer_model"]
        return RoformerEngine(**kw)
    if name == DemucsEngine.id:
        if backend == "mlx":
            # Wired, not silent: an mlx-resolved cook builds the MLX engine, which raises at construction
            # until its runtime lands. This is what makes facts.backend honest — a torch DemucsEngine can
            # never be built under an "mlx" label (#119).
            return MlxDemucsEngine()
        allowed = {"demucs_bin", "device", "jobs", "overlap", "segment", "shifts"}
        kw = {k: v for k, v in given.items() if k in allowed}
        if "demucs_model" in given:
            kw["default_model"] = given["demucs_model"]
        # `backend` reaches facts unchanged (defaults to "torch"); an mlx cook never gets here.
        return DemucsEngine(backend=backend or "torch", **kw)
    # PermanentError (retryable=False): a name with no registered engine — "ensemble" on a box that
    # only has demucs, a typo — cannot be honoured by retrying. Subclasses RuntimeError so the
    # message and the exception type callers/tests match on are unchanged; #443.
    raise PermanentError(f"no separator engine: {name}")
