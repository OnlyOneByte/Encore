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
from . import audiosep as a
from . import demucs as d
from . import mlx as m
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

    def derive_argvs(self, input_wav: str, out_dir: str, model: str) -> list[list[str]]:
        """Extra commands to run AFTER `separate_argv`, before `find_outputs` — each a full argv the
        step runs through the same runner, in order.

        The seam for an engine whose CLI does not itself produce the 2-stem
        `{no_vocals,vocals}` layout the rest of the pipeline reads. demucs and roformer produce it
        directly and return `[]` (nothing to derive). `MlxDemucsEngine` returns the single ffmpeg
        mix-minus pass that sums demucs-mlx's non-vocal stems into `no_vocals.wav`, because demucs-mlx
        has no `--two-stems` flag and emits four/six stems with no instrumental file.
        """
        ...


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
        # `backend` is the RESOLVED hardware backend this process runs through (backends.resolve_backend),
        # recorded into facts so the ledger matches the startup log — not a hardcoded class constant. The
        # torch CLI is the only demucs backend actually implemented here; MLX resolves to MlxDemucsEngine,
        # which refuses at construction rather than reaching this class under an "mlx" label.
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

    def derive_argvs(self, input_wav: str, out_dir: str, model: str) -> list[list[str]]:
        # demucs --two-stems writes no_vocals.wav directly; nothing to derive.
        return []


class MlxDemucsEngine:
    """The demucs family through `demucs-mlx` — Apple-Silicon Metal execution of the SAME htdemucs
    checkpoints, selected by `backends.resolve_backend` when MLX is available (Apple Silicon + the
    `demucs_mlx` package importable). an earlier change.

    The backend selection is genuinely wired: a Mac that resolves `mlx` builds THIS engine
    rather than silently building `DemucsEngine` under an "mlx" label, so `facts.backend` matches the
    startup log instead of announcing `mlx` while recording `torch`.

    THE CLI CONTRACT, measured, is CASE C (owner ruling on an earlier change): `demucs-mlx` has NO
    `--two-stems` and
    NO `--filename` flag, so it emits every source the model carries (4 for htdemucs/_ft, 6 for
    htdemucs_6s) into the demucs-native nested layout `<out>/<track-stem>/<source>.wav`, and there is no
    instrumental file. The instrumental is DERIVED by an ffmpeg mix-minus pass that sums the non-vocal
    stems (`amix ... normalize=0`, a true sum, not the level-halving default) into a `no_vocals.wav`
    sitting beside them — so `find_outputs` returns the same 2-stem shape the torch engine does and the
    rest of the pipeline (ProbeSilence, PublishStems) is untouched. All the MLX-specific behaviour is the
    pure argv/path/derivation helpers in `separation/mlx.py`; this class is the seam adapter.

    STILL REFUSES LOUDLY when MLX is genuinely unavailable — but that refusal is now UPSTREAM of
    construction, not at it: a box whose resolved backend is `mlx` has already passed
    `backend_available(MLX)` (Apple Silicon AND `demucs_mlx` importable, `backends.py`), and only such a
    box advertises `stems` (`capabilities.narrow_for_backend` reads `demucs_engine_backed_by("mlx")`,
    now True). A box without MLX either resolves to `torch` (never builds this) or, if `mlx` was
    explicitly configured on unsupported hardware, `resolve_backend` raises at worker startup before any
    engine is built. So the honest-degradation contract an earlier change established is preserved: an `mlx`
    label
    never runs a torch process, and unavailable MLX fails loud rather than downgrading silently.

    `input_wav` is stashed on the instance at `separate_argv` time so `derive_argvs` and `find_outputs`
    can compute the per-track output directory demucs-mlx names from the INPUT filename. The seam calls
    the three in that fixed order (separate → derive → find), so the stash is always set before it is
    read; it defaults to the conventional `input.wav` the DecodeToWav step always produces, so a direct
    unit call to `find_outputs` without a prior `separate_argv` still resolves the standard path.
    """

    id = "demucs"
    backend = "mlx"

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
        # The decoded input this process separates, set by separate_argv. demucs-mlx names its per-track
        # output folder from this filename (see separation/mlx.py), so derive_argvs/find_outputs need it.
        self._input_wav = "input.wav"

    def resolve_model(self, params: dict) -> str:
        return m.resolve_mlx_model(params, self._default_model)

    def input_wav(self, work: str) -> str:
        # Same convention as the torch engine: one WAV in the shared scratch dir. demucs-mlx separates a
        # named file (not a folder), so no dedicated directory is needed.
        return os.path.join(work, "input.wav")

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
        # demucs-mlx renders a tqdm bar (separate.py, `tqdm(...)`), same shape demucs uses, so reuse the
        # demucs percentage parser rather than a second copy of the same regex.
        return d.parse_demucs_progress(line)

    def derive_argvs(self, input_wav: str, out_dir: str, model: str) -> list[list[str]]:
        # The single mix-minus ffmpeg pass that builds no_vocals.wav from the model's non-vocal stems.
        return [m.mix_minus_instrumental_argv(out_dir, input_wav, model, self._ffmpeg)]

    def find_outputs(self, out_dir: str, model: str) -> dict[str, str | None]:
        inst = m.mlx_instrumental_path(out_dir, self._input_wav)
        vox = m.mlx_vocals_path(out_dir, self._input_wav)
        return {
            "instrumental": inst if os.path.exists(inst) else None,
            "vocals": vox if os.path.exists(vox) else None,
        }


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

    def derive_argvs(self, input_wav: str, out_dir: str, model: str) -> list[list[str]]:
        # bs-roformer-infer writes an instrumental stem directly; nothing to derive.
        return []


class AudioSepEngine:
    """The MEL-BAND RoFormer family via `python-audio-separator`.

    The fast RoFormer path `bs-roformer-infer` cannot reach: audio-separator runs mel-band checkpoints
    as a first-class MDXC path, and `mel instrumental_becruily` measures rt 1.28 on the reference box
    versus `bs_roformer-1297`'s rt 13.29 — a 10.4x RoFormer-family instrumental process, no GPU
    (docs/benchmarks/SUMMARY.md §4). Adopted ALONGSIDE roformer, not replacing it — both engines, issue
    an earlier change owner ruling Q1(b).

    Shape-wise it sits between demucs and roformer. Like demucs, its input is a single named WAV (not a
    dedicated input directory — audio-separator takes the input FILE as a positional argument, so it
    does not re-separate its own output the way bs-roformer-infer's `--input_folder` would). Like
    roformer, its outputs are DISCOVERED by globbing `--output_dir` for the delimited `_(Instrumental)_`
    / `_(Vocals)_` markers rather than derived from the model name. All the audio-separator-specific
    behaviour is the pure argv/path helpers in `separation/audiosep.py`; this class is the seam adapter.

    `parse_progress` returns None: audio-separator renders a tqdm bar, not a stable percentage source, so
    the step emits a coarse 0→100 exactly as roformer does.

    THE REAL PROCESS IS UNVERIFIED IN THIS ENVIRONMENT — the same accepted caveat roformer carries (see
    audiosep.py's module warning). audio-separator is not installed on the aarch64 dev/CI box; only a
    worker an operator gave the `stems:audiosep` capability runs it.
    """

    id = "audiosep"
    backend = "audio-separator"

    def __init__(
        self,
        *,
        default_model: str = a.DEFAULT_AUDIOSEP_MODEL,
        audiosep_bin: str = "audio-separator",
        model_file_dir: str | None = None,
    ) -> None:
        self._default_model = default_model
        self._bin = audiosep_bin
        self._model_file_dir = model_file_dir

    def resolve_model(self, params: dict) -> str:
        return a.resolve_audiosep_checkpoint(params, self._default_model)

    def input_wav(self, work: str) -> str:
        # A single named file in the shared scratch dir, like demucs — audio-separator separates the
        # FILE passed as its positional argument, not every file in a directory, so no dedicated dir.
        return os.path.join(work, "input.wav")

    def separate_argv(self, input_wav: str, out_dir: str, model: str) -> list[str]:
        return a.audiosep_argv(input_wav, out_dir, model, model_file_dir=self._model_file_dir, bin=self._bin)

    def parse_progress(self, line: str) -> int | None:
        return None  # tqdm output is not a stable pct source; the step emits a coarse 0→100

    def find_outputs(self, out_dir: str, model: str) -> dict[str, str | None]:
        return {
            "instrumental": a.find_audiosep_instrumental(out_dir),
            "vocals": a.find_audiosep_vocals(out_dir),
        }

    def derive_argvs(self, input_wav: str, out_dir: str, model: str) -> list[list[str]]:
        # audio-separator writes an instrumental stem directly; nothing to derive.
        return []


def engine_for(name: str, *, backend: str | None = None, **kwargs) -> SeparatorEngine:
    """The engine this job resolved to, executed through the resolved `backend`.

    Unknown names raise — the CORE only routes a roformer process to a worker advertising `stems:roformer`, so
    an unknown name here is a routing bug rather than a user choice.

    `backend` is the hardware backend `backends.resolve_backend` picked for THIS worker (torch/mlx). It
    selects WHICH demucs implementation runs and is recorded into `facts.backend`, so the ledger matches
    the backend the startup log announced. Before this it reached nothing but a print, so a Mac
    resolving `mlx` still built the torch `DemucsEngine` and recorded `torch` — the log lied. `mlx` now
    builds `MlxDemucsEngine`, which runs the demucs-mlx CLI and derives the instrumental via a mix-minus
    ffmpeg pass; `torch` (or None, the portable default) builds the real `DemucsEngine`. Roformer
    runs only through its own CLI, so a backend other than that impl is not applicable to it.

    None-valued kwargs are DROPPED, not forwarded. A caller that has no opinion about `jobs` or a model
    passes None, and forwarding it would override the engine's own default with nothing — and for the model
    that means resolve_*_model() gets None as its fallback and fails on a job that carried no model.

    The model default is per ENGINE, not shared: a caller passes `demucs_model` and/or `roformer_model`,
    and only the matching engine's value is mapped to its `default_model`. A single engine-agnostic
    `default_model` slot let a caller hand one engine the OTHER engine's checkpoint name (issue an earlier
    change: the
    lone production caller supplied the demucs default, which reached `RoformerEngine` and made
    `DEFAULT_ROFORMER_MODEL` unreachable — a roformer process without a `model` then raised naming a demucs
    checkpoint). Keeping the names engine-specific makes that cross-wiring inexpressible. `audiosep_model`
    follows the same rule: it maps only to `AudioSepEngine`.

    `audiosep` (python-audio-separator) is the mel-band RoFormer engine, run through its own
    `audio-separator` CLI. Like roformer it is not a demucs backend — it is a distinct engine id with its
    own capability (`stems:audiosep`), so a `backend` other than its own CLI is not applicable to it.

    The MLX branch reuses the demucs-family kwargs: `demucs_model` maps to its `default_model` (mlx runs
    the same htdemucs checkpoints), and `overlap`/`segment`/`shifts` are the perf knobs demucs-mlx shares
    with demucs. It ignores `demucs_bin`/`device`/`jobs`: mlx has its own binary (`demucs-mlx`), takes no
    torch device string, and parallelises with `-b`, not demucs's `-j`.
    """
    given = {k: v for k, v in kwargs.items() if v is not None}
    if name == RoformerEngine.id:
        allowed = {"roformer_bin", "device"}
        kw = {k: v for k, v in given.items() if k in allowed}
        if "roformer_model" in given:
            kw["default_model"] = given["roformer_model"]
        return RoformerEngine(**kw)
    if name == AudioSepEngine.id:
        allowed = {"audiosep_bin", "model_file_dir"}
        kw = {k: v for k, v in given.items() if k in allowed}
        if "audiosep_model" in given:
            kw["default_model"] = given["audiosep_model"]
        return AudioSepEngine(**kw)
    if name == DemucsEngine.id:
        if backend == "mlx":
            # Wired, not silent: an mlx-resolved process builds the MLX engine, which runs demucs-mlx and
            # derives the instrumental. This is what makes facts.backend honest — a torch
            # DemucsEngine can never be built under an "mlx" label.
            allowed = {"overlap", "segment", "shifts"}
            kw = {k: v for k, v in given.items() if k in allowed}
            if "demucs_model" in given:
                kw["default_model"] = given["demucs_model"]
            return MlxDemucsEngine(**kw)
        allowed = {"demucs_bin", "device", "jobs", "overlap", "segment", "shifts"}
        kw = {k: v for k, v in given.items() if k in allowed}
        if "demucs_model" in given:
            kw["default_model"] = given["demucs_model"]
        # `backend` reaches facts unchanged (defaults to "torch"); an mlx process never gets here.
        return DemucsEngine(backend=backend or "torch", **kw)
    # PermanentError (retryable=False): a name with no registered engine — "ensemble" on a box that
    # only has demucs, a typo — cannot be honoured by retrying. Subclasses RuntimeError so the
    # message and the exception type callers/tests match on are unchanged; an earlier change.
    raise PermanentError(f"no separator engine: {name}")


def demucs_engine_backed_by(backend: str | None) -> bool:
    """Whether a demucs `SeparatorEngine` can actually be CONSTRUCTED and RUN through `backend`.

    The single source of truth for "does this backend have a demucs engine implementation", read by
    the capability-declaration site so the worker never advertises `stems` on a box whose resolved
    backend cannot build one. `torch` (and None, the portable default) build the real `DemucsEngine`;
    `mlx` builds `MlxDemucsEngine`, which runs the demucs-mlx CLI and derives the instrumental,
    so it IS backed. Any other/unknown backend is not backed.

    A box only ever resolves to `mlx` after passing `backends.backend_available(MLX)` — Apple Silicon
    AND `demucs_mlx` importable — so returning True here does not advertise `stems` on a box that
    cannot actually run it; the availability gate upstream still does that job, and an explicit `mlx`
    on unsupported hardware already raises at `resolve_backend` before this is consulted.

    Kept next to `engine_for` on purpose: `engine_for("demucs", backend=b)` builds an engine for exactly
    the values this returns True for, so the two cannot drift — a new demucs backend adds a branch to
    both. Deliberately does NOT construct the engine (that would import torch just to answer a probe),
    so it stays cheap enough to run in the dial-home process alongside the import-free capability
    probes.
    """
    return backend in (None, "torch", "mlx")
