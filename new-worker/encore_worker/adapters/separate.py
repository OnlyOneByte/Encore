"""Source separation: demucs (torch), demucs-mlx (Apple Silicon), and the mix-minus derivation.

THREE ENGINES, ONE CONTRACT. Each produces an instrumental and a vocals stem at known paths, and nothing
downstream knows which ran. Their CLIs genuinely differ, which is why this is not one function with
flags — see `MlxDemucs` for the three ways demucs-mlx departs from torch demucs.

ARGV IS PURE, output paths are pure, running is separate. That split is what makes a flag whose absence
only shows up on a real 45-minute separation assertable in a millisecond.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from encore_worker.adapters.cli import ToolFailed, run
from encore_worker.adapters.ports import ProgressSink

#: Checkpoints either demucs engine will run. A job may NOT name an arbitrary model: the name reaches a
#: subprocess, and an unvetted one is both a failure mode and an injection surface.
DEMUCS_MODELS = ("htdemucs", "htdemucs_ft", "htdemucs_6s")

#: The non-vocal sources of a 4-stem model, summed to make an instrumental. The 6-source model adds two.
_FOUR_STEM = ("drums", "bass", "other")
_SIX_STEM_EXTRA = ("piano", "guitar")


class UnknownModel(ValueError):
    """A model name that is not on the allowlist. `retryable = False` — re-resolving yields the same."""

    retryable = False


def resolve_model(requested: str | None, default: str = "htdemucs") -> str:
    """The checkpoint to run. An explicit-but-unknown name RAISES rather than falling back.

    Falling back silently would separate with a different model than the job asked for and report
    success, which is worse than refusing: the operator's setting would appear to work.
    """
    if not requested:
        return default
    if requested not in DEMUCS_MODELS:
        raise UnknownModel(f"unknown demucs model {requested!r}; expected one of {DEMUCS_MODELS}")
    return requested


def instrumental_sources(model: str) -> tuple[str, ...]:
    """The stems that sum to the instrumental, DERIVED from the model rather than hardcoded.

    A 6-source model that summed only four would silently drop piano and guitar from the backing track —
    audible as a thin mix, not as an error.
    """
    if model == "htdemucs_6s":
        return _FOUR_STEM + _SIX_STEM_EXTRA
    return _FOUR_STEM


@dataclass(frozen=True, slots=True)
class Stems:
    """Where a separator put its output. Satisfies `ports.SeparationResult`."""

    instrumental_path: str
    vocals_path: str | None = None
    engine: str = ""


# ── torch demucs ─────────────────────────────────────────────────────────────────────────────────


def demucs_argv(
    input_wav: str, out_dir: str, model: str = "htdemucs", *, device: str = "cpu", jobs: int = 1
) -> list[str]:
    """torch demucs argv, asking for TWO stems only.

    `--two-stems=vocals` is the whole reason this engine is cheaper than the mlx path: demucs writes
    `vocals.wav` and `no_vocals.wav` directly, so no mix-minus pass is needed. `-n` is the model and
    reaches a subprocess, which is why `resolve_model` gates it.
    """
    return [
        "python",
        "-m",
        "demucs.separate",
        "-n",
        model,
        "--two-stems=vocals",
        "-d",
        device,
        "-j",
        str(max(1, jobs)),
        "-o",
        out_dir,
        input_wav,
    ]


def demucs_paths(out_dir: str, input_wav: str, model: str = "htdemucs") -> Stems:
    """Where torch demucs writes: `<out>/<model>/<input-stem>/{vocals,no_vocals}.wav`."""
    stem = os.path.splitext(os.path.basename(input_wav))[0]
    base = os.path.join(out_dir, model, stem)
    return Stems(
        instrumental_path=os.path.join(base, "no_vocals.wav"),
        vocals_path=os.path.join(base, "vocals.wav"),
        engine="demucs",
    )


class TorchDemucs:
    """`Separator` over torch demucs."""

    name = "demucs"

    def __init__(self, *, model: str = "htdemucs", device: str = "cpu", jobs: int = 1) -> None:
        self._model = resolve_model(model)
        self._device = device
        self._jobs = jobs

    def separate(self, input_wav: str, out_dir: str, *, on_progress: ProgressSink | None = None) -> Stems:
        run(
            demucs_argv(input_wav, out_dir, self._model, device=self._device, jobs=self._jobs),
            on_progress=on_progress,
        )
        return demucs_paths(out_dir, input_wav, self._model)


# ── demucs-mlx ───────────────────────────────────────────────────────────────────────────────────


def mlx_argv(input_wav: str, out_dir: str, model: str = "htdemucs", mlx_bin: str = "demucs-mlx") -> list[str]:
    """demucs-mlx argv. THREE flags that torch demucs has do not exist here.

    No `--two-stems` (it always emits every source, so the instrumental must be DERIVED), no `-d/--device`
    (MLX targets Metal; there is no device string), and no `--filename` template (it writes a nested
    per-track layout keyed on the INPUT filename, not the model).
    """
    return [mlx_bin, "-n", model, "-o", out_dir, input_wav]


def mlx_track_dir(out_dir: str, input_wav: str) -> str:
    """`<out>/<input-stem>/` — named from the INPUT file, which is where its layout differs from torch's."""
    return os.path.join(out_dir, os.path.splitext(os.path.basename(input_wav))[0])


def mlx_stem_path(out_dir: str, input_wav: str, source: str) -> str:
    return os.path.join(mlx_track_dir(out_dir, input_wav), f"{source}.wav")


def mix_minus_argv(
    out_dir: str, input_wav: str, model: str = "htdemucs", ffmpeg_bin: str = "ffmpeg"
) -> list[str]:
    """Sum the non-vocal stems into `no_vocals.wav`.

    `normalize=0` IS LOAD-BEARING. ffmpeg's `amix` averages by default, dividing by the input count — so
    three stems would ship the instrumental at a third of its level. Quiet enough to sound merely "turned
    down" rather than broken, which is exactly the kind of defect that passes a casual listen.

    Summing the model's own stems rather than phase-subtracting vocals from the mix is deliberate: the
    stems are one decomposition of the same resampled input, so they are sample-aligned by construction.
    """
    sources = instrumental_sources(model)
    argv = [ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y"]
    for source in sources:
        argv += ["-i", mlx_stem_path(out_dir, input_wav, source)]
    argv += [
        "-filter_complex",
        f"amix=inputs={len(sources)}:normalize=0",
        "-c:a",
        "pcm_s16le",
        "-ac",
        "2",
        mlx_stem_path(out_dir, input_wav, "no_vocals"),
    ]
    return argv


class MlxDemucs:
    """`Separator` over demucs-mlx, with the instrumental derived by an ffmpeg mix-minus pass."""

    name = "demucs-mlx"

    def __init__(
        self, *, model: str = "htdemucs", mlx_bin: str = "demucs-mlx", ffmpeg_bin: str = "ffmpeg"
    ) -> None:
        self._model = resolve_model(model)
        self._bin = mlx_bin
        self._ffmpeg = ffmpeg_bin

    def separate(self, input_wav: str, out_dir: str, *, on_progress: ProgressSink | None = None) -> Stems:
        run(mlx_argv(input_wav, out_dir, self._model, self._bin), on_progress=on_progress)
        # The instrumental does not exist as a file until this runs — see `mix_minus_argv`.
        run(mix_minus_argv(out_dir, input_wav, self._model, self._ffmpeg))
        return Stems(
            instrumental_path=mlx_stem_path(out_dir, input_wav, "no_vocals"),
            vocals_path=mlx_stem_path(out_dir, input_wav, "vocals"),
            engine="demucs-mlx",
        )


def decode_argv(source: str, out_wav: str, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """Decode any input to the 44.1kHz stereo 16-bit WAV both separators expect.

    Normalising here rather than letting each engine cope means a variable-bitrate mp3 or an opus stream
    cannot produce a subtly different stem layout per engine.
    """
    return [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        source,
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "pcm_s16le",
        out_wav,
    ]


def build_separator(
    backend: str, *, model: str = "htdemucs", device: str = "cpu", mlx_bin: str, ffmpeg_bin: str
) -> TorchDemucs | MlxDemucs | None:
    """The separator for the RESOLVED backend, or None when this box cannot build one.

    None rather than a raise: `host.capabilities` already declines to advertise `stems` on a box with no
    engine, so reaching here with an unbuildable backend means the two disagreed — and returning None
    makes that a refused job rather than a crashed process.
    """
    from encore_worker.host.hardware import binary_available, module_available

    if backend == "mlx":
        if not binary_available(mlx_bin):
            return None
        return MlxDemucs(model=model, mlx_bin=mlx_bin, ffmpeg_bin=ffmpeg_bin)
    if not module_available("demucs"):
        return None
    return TorchDemucs(model=model, device=device)


__all__ = [
    "DEMUCS_MODELS",
    "MlxDemucs",
    "Stems",
    "ToolFailed",
    "TorchDemucs",
    "UnknownModel",
    "build_separator",
    "decode_argv",
    "demucs_argv",
    "demucs_paths",
    "instrumental_sources",
    "mix_minus_argv",
    "mlx_argv",
    "mlx_stem_path",
    "mlx_track_dir",
    "resolve_model",
    "run",
]
