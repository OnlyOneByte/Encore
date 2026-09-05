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
    backend = "torch"

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
    ) -> None:
        self._default_model = default_model
        self._bin = demucs_bin
        self._device = device
        self._jobs = jobs
        self._overlap = overlap
        self._segment = segment
        self._shifts = shifts

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


def engine_for(name: str, **kwargs) -> SeparatorEngine:
    """The engine this job resolved to.

    Unknown names raise — the CORE only routes a roformer cook to a worker advertising `stems:roformer`, so
    an unknown name here is a routing bug rather than a user choice.

    None-valued kwargs are DROPPED, not forwarded. A caller that has no opinion about `jobs` or
    `default_model` passes None, and forwarding it would override the engine's own default with nothing —
    which for `default_model` means resolve_*_model() gets None as its fallback and fails on a job that
    carried no model.
    """
    given = {k: v for k, v in kwargs.items() if v is not None}
    if name == RoformerEngine.id:
        return RoformerEngine(**{k: v for k, v in given.items() if k in {"default_model", "roformer_bin", "device"}})
    if name == DemucsEngine.id:
        allowed = {"default_model", "demucs_bin", "device", "jobs", "overlap", "segment", "shifts"}
        return DemucsEngine(**{k: v for k, v in given.items() if k in allowed})
    raise RuntimeError(f"no separator engine: {name}")
