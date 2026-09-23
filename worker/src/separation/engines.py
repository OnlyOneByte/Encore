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

Not a place to unify the argv builders or path helpers — those stay in `demucs.py`/`roformer.py`,
unchanged, since they encode measured behaviour of each CLI. This only lets one step ask every engine
the same four questions.
"""

from __future__ import annotations

import inspect
import os
from functools import cache
from typing import Protocol

from ..retry_policy import PermanentError
from ..vocabulary import StemFormat
from . import audiosep as a
from . import demucs as d
from . import mlx as m
from . import roformer as r


class SeparatorEngine(Protocol):
    """What `Separate` needs to know about an engine, and nothing more."""

    id: str
    backend: str

    #: The container this engine writes its RAW scratch stems in. DECLARED rather than inferred: demucs
    #: and demucs-mlx emit PCM WAV, audio-separator emits FLAC, and a reader that assumes WAV (stdlib
    #: `wave`) cannot open a FLAC — an unreadable container silently reads as "stems do not match"
    #: rather than naming the real cause. A fifth engine cannot ship without answering this.
    stem_format: StemFormat

    def resolve_model(self, params: dict) -> str: ...
    def input_wav(self, work: str) -> str: ...
    def separate_argv(self, input_wav: str, out_dir: str, model: str) -> list[str]: ...
    def parse_progress(self, line: str) -> int | None: ...
    def find_outputs(self, out_dir: str, model: str) -> dict[str, str | None]: ...

    def derive_argvs(self, input_wav: str, out_dir: str, model: str) -> list[list[str]]:
        """Extra commands to run AFTER `separate_argv`, before `find_outputs` — each a full argv the
        step runs through the same runner, in order.

        The seam for an engine whose CLI does not itself produce the 2-stem `{no_vocals,vocals}`
        layout. Only `MlxDemucsEngine` uses it (demucs-mlx has no `--two-stems` flag and emits four/six
        stems with no instrumental file). Every other CLI writes an instrumental directly, so `[]`
        (via `SeparatorDefaults`) is free.
        """
        ...


class SeparatorDefaults:
    """The two answers most engines give, so they are written once instead of four times.

    Separate from the `SeparatorEngine` Protocol above: the Protocol is the TYPE (matches
    STRUCTURALLY, so tests pass small fakes without a base class), and this is the shared CODE, with
    no abstract members of its own — the contract still lives in exactly one place.

    Inherit this for the defaults; override either method where the CLI genuinely differs (see
    `MlxDemucsEngine.derive_argvs` and `RoformerEngine.input_wav`).
    """

    def input_wav(self, work: str) -> str:
        """One named file in the shared scratch dir.

        Right for every CLI that separates the FILE it is given. Roformer overrides it because
        `bs-roformer-infer` separates a DIRECTORY.
        """
        return os.path.join(work, "input.wav")

    def derive_argvs(self, input_wav: str, out_dir: str, model: str) -> list[list[str]]:
        """Nothing to derive: this engine's CLI already wrote an instrumental stem."""
        return []


class DemucsEngine(SeparatorDefaults):
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
        stem_format: StemFormat = StemFormat.FLAC,
    ) -> None:
        self._default_model = default_model
        self._bin = demucs_bin
        self._device = device
        self._jobs = jobs
        self._overlap = overlap
        self._segment = segment
        self._shifts = shifts
        # DECLARED: the same value reaches both the argv and the output paths below.
        self.stem_format = stem_format
        # The RESOLVED hardware backend this process runs through (backends.resolve_backend), recorded
        # into facts so the ledger matches the startup log. MLX resolves to MlxDemucsEngine instead of
        # reaching this class under an "mlx" label.
        self.backend = backend

    def resolve_model(self, params: dict) -> str:
        """The checkpoint is per-JOB (the room's chosen model rides in params), not a worker constant.
        A raise here means the room asked for a model this build does not carry."""
        return d.resolve_demucs_model(params, self._default_model)

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
            stem_format=self.stem_format,
        )

    def parse_progress(self, line: str) -> int | None:
        return d.parse_demucs_progress(line)

    def find_outputs(self, out_dir: str, model: str) -> dict[str, str | None]:
        inst = d.demucs_no_vocals_path(out_dir, model, self.stem_format)
        vox = d.demucs_vocals_path(out_dir, model, self.stem_format)
        return {
            "instrumental": inst if os.path.exists(inst) else None,
            "vocals": vox if os.path.exists(vox) else None,
        }


class MlxDemucsEngine(SeparatorDefaults):
    """The demucs family through `demucs-mlx` — Apple-Silicon Metal execution of the SAME htdemucs
    checkpoints, selected by `backends.resolve_backend` when MLX is available (Apple Silicon + the
    `demucs_mlx` package importable). A Mac that resolves `mlx` builds THIS engine rather than
    silently building `DemucsEngine` under an "mlx" label, so `facts.backend` matches the startup log.

    THE CLI CONTRACT, measured: `demucs-mlx` has NO `--two-stems` and NO `--filename` flag, so it
    emits every source the model carries (4 for htdemucs/_ft, 6 for htdemucs_6s) into the
    demucs-native nested layout `<out>/<track-stem>/<source>.wav`, with no instrumental file. The
    instrumental is DERIVED by an ffmpeg mix-minus pass that sums the non-vocal stems (a true sum, not
    the level-halving default) into `no_vocals.wav`, so `find_outputs` returns the same 2-stem shape
    the torch engine does. All MLX-specific behaviour is the pure helpers in `separation/mlx.py`; this
    class is the seam adapter.

    STILL REFUSES LOUDLY when MLX is genuinely unavailable, but UPSTREAM of construction: a box whose
    resolved backend is `mlx` has already passed `backend_available(MLX)`, and only such a box
    advertises `stems`. A box without MLX either resolves to `torch` (never builds this) or, if `mlx`
    was explicitly configured on unsupported hardware, `resolve_backend` raises at worker startup
    before any engine is built — an `mlx` label never runs a torch process.

    `input_wav` is stashed on the instance at `separate_argv` time so `derive_argvs`/`find_outputs`
    can compute the per-track output directory from the INPUT filename; the seam always calls the
    three in that fixed order (separate -> derive -> find), so the stash is set before it is read.
    """

    id = "demucs"
    backend = "mlx"

    #: WAV, and NOT configurable: demucs-mlx has no output format flag. The derived instrumental
    #: COULD be re-encoded to FLAC, but that would hand back a FLAC instrumental beside a WAV vocals
    #: stem, and the guide mix — which folds the two together — depends on them sharing one container.
    stem_format = StemFormat.WAV

    def __init__(
        self,
        *,
        default_model: str = m.DEFAULT_MODEL,
        mlx_bin: str = "demucs-mlx",
        ffmpeg_bin: str = "ffmpeg",
        overlap: float | None = None,
        segment: int | None = None,
        shifts: int | None = None,
        batch_size: int | None = None,
    ) -> None:
        self._default_model = default_model
        self._bin = mlx_bin
        self._ffmpeg = ffmpeg_bin
        self._overlap = overlap
        self._segment = segment
        self._shifts = shifts
        self._batch_size = batch_size
        # The decoded input this process separates, set by separate_argv: demucs-mlx names its
        # per-track output folder from this filename, so derive_argvs/find_outputs need it.
        self._input_wav = "input.wav"

    def resolve_model(self, params: dict) -> str:
        return m.resolve_mlx_model(params, self._default_model)

    def separate_argv(self, input_wav: str, out_dir: str, model: str) -> list[str]:
        self._input_wav = input_wav
        return m.mlx_argv(
            input_wav,
            out_dir,
            model,
            self._bin,
            overlap=self._overlap,
            segment=self._segment,
            shifts=self._shifts,
            batch_size=self._batch_size,
        )

    def parse_progress(self, line: str) -> int | None:
        # demucs-mlx renders the same tqdm-bar shape demucs uses, so reuse its percentage parser.
        return d.parse_demucs_progress(line)

    def derive_argvs(self, input_wav: str, out_dir: str, model: str) -> list[list[str]]:
        return [m.mix_minus_instrumental_argv(out_dir, input_wav, model, self._ffmpeg)]

    def find_outputs(self, out_dir: str, model: str) -> dict[str, str | None]:
        inst = m.mlx_instrumental_path(out_dir, self._input_wav)
        vox = m.mlx_vocals_path(out_dir, self._input_wav)
        return {
            "instrumental": inst if os.path.exists(inst) else None,
            "vocals": vox if os.path.exists(vox) else None,
        }


class RoformerEngine(SeparatorDefaults):
    """The BS-RoFormer family via `bs-roformer-infer`.

    Better on cymbal transients, and roughly 50x slower than htdemucs on CPU (measured: ~45 min against
    ~50 s for a 2:51 song), so it is a GPU-box choice rather than a default.
    """

    id = "roformer"
    backend = "bs-roformer-infer"

    #: WAV, and NOT configurable: `bs-roformer-infer` takes no output-format flag. `find_outputs`
    #: actually DISCOVERS stems by scanning for a delimited filename (`.wav` or `.flac`); this
    #: declaration exists so a reader does not have to read the glob to know what to expect.
    stem_format = StemFormat.WAV

    def __init__(
        self,
        *,
        default_model: str = r.DEFAULT_ROFORMER_MODEL,
        roformer_bin: str = "bs-roformer-infer",
        device: str | None = None,
        models_dir: str | None = None,
    ) -> None:
        self._default_model = default_model
        self._bin = roformer_bin
        self._device = device
        self._models_dir = models_dir  # where the ~700MB checkpoint is cached

    def resolve_model(self, params: dict) -> str:
        return r.resolve_roformer_slug(params, self._default_model)

    def input_wav(self, work: str) -> str:
        """A DEDICATED directory, because bs-roformer-infer separates every WAV in --input_folder — the
        shared scratch dir also holds its output, so a single input.wav there would be re-separated."""
        in_dir = os.path.join(work, "roformer_in")
        os.makedirs(in_dir, exist_ok=True)
        return os.path.join(in_dir, "input.wav")

    def separate_argv(self, input_wav: str, out_dir: str, model: str) -> list[str]:
        return r.roformer_argv(
            os.path.dirname(input_wav),
            out_dir,
            model,
            device=self._device,
            models_dir=self._models_dir,
            bin=self._bin,
        )

    def parse_progress(self, line: str) -> int | None:
        return None  # tqdm output is not a stable pct source; the step emits a coarse 0→100

    def find_outputs(self, out_dir: str, model: str) -> dict[str, str | None]:
        return {
            "instrumental": r.find_roformer_instrumental(out_dir),
            "vocals": r.find_roformer_vocals(out_dir),
        }


class AudioSepEngine(SeparatorDefaults):
    """The MEL-BAND RoFormer family via `python-audio-separator`. Adopted ALONGSIDE roformer, not
    replacing it — both engines stay available.

    Shape-wise it sits between demucs and roformer. Like demucs, its input is a single named WAV (a
    positional FILE argument, so it does not re-separate its own output the way bs-roformer-infer's
    `--input_folder` would). Like roformer, its outputs are DISCOVERED by globbing `--output_dir` for
    delimited markers rather than derived from the model name. All audio-separator-specific behaviour
    is the pure helpers in `separation/audiosep.py`; this class is the seam adapter.

    `parse_progress` returns None: audio-separator renders a tqdm bar, not a stable percentage source.

    THE REAL PROCESS IS UNVERIFIED IN THIS ENVIRONMENT (same caveat roformer carries — see
    audiosep.py's module warning): audio-separator is not installed on the aarch64 dev/CI box; only a
    worker given the `stems:audiosep` capability runs it.
    """

    id = "audiosep"
    backend = "audio-separator"

    def __init__(
        self,
        *,
        default_model: str = a.DEFAULT_AUDIOSEP_MODEL,
        audiosep_bin: str = "audio-separator",
        model_file_dir: str | None = None,
        stem_format: StemFormat = StemFormat.FLAC,
    ) -> None:
        self._default_model = default_model
        self._bin = audiosep_bin
        self._model_file_dir = model_file_dir
        self.stem_format = stem_format

    def resolve_model(self, params: dict) -> str:
        return a.resolve_audiosep_checkpoint(params, self._default_model)

    def separate_argv(self, input_wav: str, out_dir: str, model: str) -> list[str]:
        return a.audiosep_argv(
            input_wav,
            out_dir,
            model,
            model_file_dir=self._model_file_dir,
            bin=self._bin,
            stem_format=self.stem_format,
        )

    def parse_progress(self, line: str) -> int | None:
        return None  # tqdm output is not a stable pct source; the step emits a coarse 0→100

    def find_outputs(self, out_dir: str, model: str) -> dict[str, str | None]:
        return {
            "instrumental": a.find_audiosep_instrumental(out_dir),
            "vocals": a.find_audiosep_vocals(out_dir),
        }


#: Constructor parameters a CALLER of `engine_for` may never set, excluded from every derived
#: allowlist below.
#:   * `default_model` — a per-JOB decision resolved by `engine.resolve_model(ctx.params)`; letting a
#:     caller replace it at construction would put a second, unvalidated owner on that decision.
#:   * `backend` — `engine_for` takes it as its own named argument; admitting it from `**kwargs` too
#:     would be a way to override the RESOLVED backend.
_FACTORY_OWNED = frozenset({"default_model", "backend"})


@cache
def _settable(cls: type) -> frozenset[str]:
    """Which of `cls.__init__`'s parameters `engine_for` will forward from its caller.

    DERIVED from the signature, not hand-listed: a literal allowlist per engine is a place to forget
    a parameter whenever one is added to a constructor. Cached since it reflects on four classes on a
    hot-ish path and the answer cannot change at runtime.
    """
    # `signature(cls)` is the CONSTRUCTOR's signature with `self` already removed.
    return frozenset(inspect.signature(cls).parameters) - _FACTORY_OWNED


def engine_for(name: str, *, backend: str | None = None, **kwargs) -> SeparatorEngine:
    """The engine this job resolved to, executed through the resolved `backend`.

    Unknown names raise: the core only routes a roformer process to a worker advertising
    `stems:roformer`, so an unknown name here is a routing bug, not a user choice.

    `backend` is the hardware backend `backends.resolve_backend` picked for THIS worker (torch/mlx).
    It selects WHICH demucs implementation runs and is recorded into `facts.backend`, so the ledger
    matches the startup log: `mlx` builds `MlxDemucsEngine`; `torch` (or None) builds `DemucsEngine`.
    Roformer and audiosep run only through their own CLIs, so a backend other than that impl does not
    apply to them.

    None-valued kwargs are DROPPED, not forwarded: a caller with no opinion about `jobs` or a model
    passes None, and forwarding it would override the engine's own default with nothing.

    The model default is per ENGINE, not shared: a caller passes `demucs_model`/`roformer_model`/
    `audiosep_model`, and only the matching engine's value maps to its `default_model`. A single
    engine-agnostic slot would let a caller hand one engine another engine's checkpoint name.

    The MLX branch reuses the demucs-family kwargs (`demucs_model`, `overlap`/`segment`/`shifts`,
    since mlx runs the same htdemucs checkpoints) but ignores `demucs_bin`/`device`/`jobs`: mlx has
    its own binary, takes no torch device string, and parallelises with `-b`, not demucs's `-j`.
    """
    given = {k: v for k, v in kwargs.items() if v is not None}
    if name == RoformerEngine.id:
        kw = {k: v for k, v in given.items() if k in _settable(RoformerEngine)}
        if "roformer_model" in given:
            kw["default_model"] = given["roformer_model"]
        return RoformerEngine(**kw)
    if name == AudioSepEngine.id:
        # `stem_format` is accepted here and by the torch demucs branch below only: those are the two
        # CLIs with an output-format flag. demucs-mlx and bs-roformer-infer declare a fixed format
        # instead, so a caller cannot ask them for a choice the CLI cannot honour.
        kw = {k: v for k, v in given.items() if k in _settable(AudioSepEngine)}
        if "audiosep_model" in given:
            kw["default_model"] = given["audiosep_model"]
        return AudioSepEngine(**kw)
    if name == DemucsEngine.id:
        if backend == "mlx":
            # facts.backend stays honest: a torch DemucsEngine can never be built under an "mlx" label.
            kw = {k: v for k, v in given.items() if k in _settable(MlxDemucsEngine)}
            if "demucs_model" in given:
                kw["default_model"] = given["demucs_model"]
            return MlxDemucsEngine(**kw)
        kw = {k: v for k, v in given.items() if k in _settable(DemucsEngine)}
        if "demucs_model" in given:
            kw["default_model"] = given["demucs_model"]
        return DemucsEngine(backend=backend or "torch", **kw)
    # PermanentError (retryable=False): a name with no registered engine cannot be honoured by
    # retrying.
    raise PermanentError(f"no separator engine: {name}")


def demucs_engine_backed_by(backend: str | None) -> bool:
    """Whether a demucs `SeparatorEngine` can actually be CONSTRUCTED and RUN through `backend`.

    The single source of truth for "does this backend have a demucs engine implementation", read by
    the capability-declaration site so the worker never advertises `stems` on a box whose resolved
    backend cannot build one. `torch`/None build `DemucsEngine`; `mlx` builds `MlxDemucsEngine`. Any
    other/unknown backend is not backed.

    A box only ever resolves to `mlx` after passing `backends.backend_available(MLX)`, so returning
    True here does not by itself advertise `stems` on a box that cannot run it.

    Kept next to `engine_for` so the two cannot drift: a new demucs backend must add a branch to
    both. Deliberately does NOT construct the engine (that would import torch just to answer a
    probe), staying cheap enough to run in the dial-home process alongside the import-free probes.
    """
    return backend in (None, "torch", "mlx")
