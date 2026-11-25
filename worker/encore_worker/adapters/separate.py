"""Source separation: demucs (torch), demucs-mlx (Apple Silicon), and the mix-minus derivation.

THREE ENGINES, ONE CONTRACT. Each produces an instrumental and a vocals stem at known paths, and nothing
downstream knows which ran. Their CLIs genuinely differ, which is why this is not one function with
flags — see `MlxDemucs` for the three ways demucs-mlx departs from torch demucs.

ARGV IS PURE, output paths are pure, running is separate. That split is what makes a flag whose absence
only shows up on a real 45-minute separation assertable in a millisecond.
"""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from typing import Any

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

#: torch demucs redraws its tqdm bar every chunk, so this long silent is a hang (`cli.Stalled`). Generous,
#: because loading the model prints nothing. Only torch demucs: demucs-mlx and bs-roformer-infer have not
#: been seen to print steadily, so they keep `run`'s wall-clock deadline alone.
DEMUCS_IDLE_SEC = 300.0


def demucs_argv(
    input_wav: str, out_dir: str, model: str = "htdemucs", *, device: str = "cpu", jobs: int = 1
) -> list[str]:
    """torch demucs argv, asking for TWO stems only.

    `--two-stems=vocals` is the whole reason this engine is cheaper than the mlx path: demucs writes
    `vocals.wav` and `no_vocals.wav` directly, so no mix-minus pass is needed. `-n` is the model and
    reaches a subprocess, which is why `resolve_model` gates it. `sys.executable`, not `python` from PATH:
    `capabilities` probed demucs in THIS interpreter, and a service manager's PATH may have no `python`.
    `-j` above 1 on CPU runs through `demucs_pool`: demucs's own threads share one model and returned NaN.
    """
    pooled = jobs > 1 and device == "cpu"
    return [
        sys.executable,
        "-m",
        "encore_worker.adapters.demucs_pool" if pooled else "demucs.separate",
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


def thread_env(threads: int) -> dict[str, str]:
    """A separator child's thread count, or nothing (it inherits this process's) when 0."""
    return {"OMP_NUM_THREADS": str(threads), "MKL_NUM_THREADS": str(threads)} if threads else {}


class TorchDemucs:
    """`Separator` over torch demucs."""

    name = "demucs"

    def __init__(
        self, *, model: str | None = "htdemucs", device: str = "cpu", jobs: int = 1, threads: int = 0
    ) -> None:
        self._model = resolve_model(model)
        self._device = device
        self._jobs = jobs
        self._threads = threads

    @property
    def model(self) -> str:
        return self._model

    def separate(self, input_wav: str, out_dir: str, *, on_progress: ProgressSink | None = None) -> Stems:
        run(
            demucs_argv(input_wav, out_dir, self._model, device=self._device, jobs=self._jobs),
            on_progress=on_progress,
            idle_sec=DEMUCS_IDLE_SEC,
            env=thread_env(self._threads),
        )
        return demucs_paths(out_dir, input_wav, self._model)

    def prefetch(self) -> None:
        """Download the checkpoint into torch's hub cache, which the per-job demucs child reads, so the first
        song does not. The loaded copy is dropped: each job runs demucs in its own process anyway."""
        from demucs.pretrained import get_model  # noqa: PLC0415 - lazy, as every ML import here

        get_model(self._model)


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

    `normalize=0` IS LOAD-BEARING — `amix` averages by default — and SUMMING the model's own stems beats
    phase-subtracting vocals from the mix (docs/arch/05-worker.md §2.5).
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
        self, *, model: str | None = "htdemucs", mlx_bin: str = "demucs-mlx", ffmpeg_bin: str = "ffmpeg"
    ) -> None:
        self._model = resolve_model(model)
        self._bin = mlx_bin
        self._ffmpeg = ffmpeg_bin

    @property
    def model(self) -> str:
        return self._model

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


# ── bs-roformer ──────────────────────────────────────────────────────────────────────────────────
# The UPGRADE engine (core's `upgradeEngine`), shelled out to as a CLI rather than imported so a box that
# merely ADVERTISES the capability pays no import (docs/arch/05-worker.md §2.1).

#: Allowlist tokens -> bs-roformer-infer registry slugs, worker-side because the slug is a resolution detail
#: core never needs. The checkpoint mismatch carried here deliberately rather than silently repointed is in
#: docs/benchmarks/stem-separation/README.md, "Models under test".
ROFORMER_MODELS = {
    # THE 2-STEM INSTRUMENTAL MODEL and the default: its category targets the thing that plays in the room,
    # so the karaoke master is the modelled output rather than the leftover.
    "bs-roformer-1297": "roformer-model-bs-roformer-instrumental-resurrection-by-unwa",
    # The previous mapping, KEPT so historical `job_attempts.model` rows still resolve to something real.
    "bs-roformer-multistem": "roformer-model-bs-roformer-sw-by-jarredou",
}

#: Every slug bs-roformer-infer 0.1.5 carries, read out of its own `bs_models.json` and CHECKED IN, so
#: `ROFORMER_MODELS` is verifiable against REAL slugs rather than against a string-shape assertion — which
#: once let a bad slug ship.
ROFORMER_REGISTRY_SLUGS = frozenset(
    {
        "roformer-model-bs-roformer-chorus-male-female-by-sucial",
        "roformer-model-bs-roformer-de-reverb",
        "roformer-model-bs-roformer-instrumental-resurrection-by-unwa",
        "roformer-model-bs-roformer-male-female-by-aufr33",
        "roformer-model-bs-roformer-sw-by-jarredou",
        "roformer-model-bs-roformer-vocals-by-gabox",
        "roformer-model-bs-roformer-vocals-resurrection-by-unwa",
        "roformer-model-bs-roformer-vocals-revive-by-unwa",
        "roformer-model-bs-roformer-vocals-revive-v2-by-unwa",
        "roformer-model-bs-roformer-vocals-revive-v3e-by-unwa",
    }
)

#: Each slug's registry CATEGORY. Recorded as data because it decides how many stems come back, which is the
#: difference between "find the instrumental file" and "find four files and sum three of them". A separator
#: whose category changed under a stable token would break stem discovery with no error at the swap point.
ROFORMER_SLUG_CATEGORY = {
    "roformer-model-bs-roformer-instrumental-resurrection-by-unwa": "instrumental",
    "roformer-model-bs-roformer-sw-by-jarredou": "multi-stem",
}

DEFAULT_ROFORMER_MODEL = "bs-roformer-1297"


def resolve_roformer_slug(token: str | None, default: str = DEFAULT_ROFORMER_MODEL) -> str:
    """An allowlist token to a registry slug. An explicit-but-unknown token RAISES rather than falling back.

    Same contract as `resolve_model`: silently separating with the default would publish a backing track the
    operator did not choose, and it would be indistinguishable from the one they asked for.
    """
    chosen = token or default
    slug = ROFORMER_MODELS.get(chosen)
    if slug is None:
        raise UnknownModel(f"unknown roformer model {chosen!r}; expected one of {sorted(ROFORMER_MODELS)}")
    return slug


def roformer_argv(
    input_folder: str,
    store_dir: str,
    slug: str,
    *,
    device: str | None = None,
    bin: str = "bs-roformer-infer",
) -> list[str]:
    """bs-roformer-infer CLI argv.

    `--model <slug>` auto-resolves AND sha256-downloads the checkpoint on first use, so there is no separate
    download step. `--input_folder` is a DIRECTORY, not a file: every WAV inside it is separated, which is why
    the caller stages the decoded input alone in its own directory.
    """
    argv = [bin, "--model", slug, "--input_folder", input_folder, "--store_dir", store_dir]
    if device:
        argv += ["--device", device]
    return argv


#: `{model slug: (instrumental suffix, vocals suffix)}` for bs-roformer-infer 0.1.5, MEASURED from the audio
#: rather than read off the filenames, which are inverted for the one entry here. Keyed by slug because the
#: mapping is the CHECKPOINT's. docs/benchmarks/stem-separation/README.md has the rms control.
ROFORMER_STEM_SUFFIXES: dict[str, tuple[str, str]] = {
    # slug -> (instrumental suffix, vocals suffix)
    "roformer-model-bs-roformer-instrumental-resurrection-by-unwa": ("_other", "_instrumental"),
}

#: For a slug with no measured entry. Deliberately NOT a guess at the inverted order: an unmeasured model
#: should fail loudly in discovery rather than risk publishing vocals as the master.
UNMEASURED_STEMS: tuple[str, str] = ("", "")


def roformer_stem_roles(slug: str) -> tuple[str, str]:
    """`(instrumental_suffix, vocals_suffix)` for a slug, or empty strings when it has not been measured."""
    return ROFORMER_STEM_SUFFIXES.get(slug, UNMEASURED_STEMS)


def _find_by_suffix(store_dir: str, suffix: str) -> str | None:
    """The output file whose stem name ENDS with `suffix`, before its extension.

    Anchored at the end rather than matched anywhere, because `_instrumental` and `_other` both appear inside
    other candidate names in this package's output set, and a substring test would cross them.

    Sorted, because `os.listdir` order is unspecified and the pick must be deterministic.
    """
    if not suffix or not os.path.isdir(store_dir):
        return None
    for name in sorted(os.listdir(store_dir)):
        root, ext = os.path.splitext(name)
        if ext.lower() in (".wav", ".flac") and root.endswith(suffix):
            return os.path.join(store_dir, name)
    return None


def find_roformer_instrumental(store_dir: str, slug: str) -> str | None:
    """The BACKING TRACK — measured per slug, never inferred from the filename. See ROFORMER_STEM_SUFFIXES."""
    return _find_by_suffix(store_dir, roformer_stem_roles(slug)[0])


def find_roformer_vocals(store_dir: str, slug: str) -> str | None:
    """The vocals stem, for alignment and the guide mix."""
    return _find_by_suffix(store_dir, roformer_stem_roles(slug)[1])


class Roformer:
    """`Separator` over the bs-roformer-infer CLI.

    NEVER RUN END TO END in this environment — a real pass needs a ~700 MB download and tens of minutes of
    CPU — so the argv builder and the stem discovery are unit-tested and the process is not. `build_separator`
    returns this only when the CLI is on PATH (docs/arch/05-worker.md §9.1).
    """

    name = "roformer"

    def __init__(
        self,
        *,
        model: str | None = None,
        device: str | None = None,
        bin: str = "bs-roformer-infer",
        threads: int = 0,
    ) -> None:
        self._threads = threads
        self._slug = resolve_roformer_slug(model)
        #: The allowlist TOKEN, which is what core names and records; the slug is a resolution detail.
        self._token = model or DEFAULT_ROFORMER_MODEL
        self._device = device
        self._bin = bin

    @property
    def model(self) -> str:
        return self._token

    def separate(self, input_wav: str, out_dir: str, *, on_progress: ProgressSink | None = None) -> Stems:
        # `--input_folder` separates EVERY wav in the directory, so the input is staged alone. Without this a
        # second job's scratch in the same tree would be separated too, silently doubling the runtime.
        staged = os.path.join(out_dir, "roformer-in")
        store = os.path.join(out_dir, "roformer-out")
        os.makedirs(staged, exist_ok=True)
        os.makedirs(store, exist_ok=True)
        target = os.path.join(staged, os.path.basename(input_wav))
        if os.path.abspath(target) != os.path.abspath(input_wav):
            shutil.copy2(input_wav, target)

        run(
            roformer_argv(staged, store, self._slug, device=self._device, bin=self._bin),
            on_progress=on_progress,
            env=thread_env(self._threads),
        )

        instrumental = find_roformer_instrumental(store, self._slug)
        if instrumental is None:
            raise SeparationFailed(
                f"bs-roformer-infer exited 0 but wrote no instrumental stem into {store!r} — "
                f"found {sorted(os.listdir(store)) if os.path.isdir(store) else 'nothing'}"
            )
        return Stems(
            instrumental_path=instrumental,
            vocals_path=find_roformer_vocals(store, self._slug),
            engine="roformer",
        )


class SeparationFailed(RuntimeError):
    """An engine exited successfully but produced nothing usable.

    RETRYABLE: the usual cause is a truncated checkpoint download or a killed subprocess, both of which a
    second attempt can fix. A genuinely broken registry slug raises `UnknownModel` at construction instead.
    """

    retryable = True


def build_separator(
    backend: str,
    *,
    model: str | None = "htdemucs",
    device: str = "cpu",
    mlx_bin: str,
    ffmpeg_bin: str,
    engine: str | None = None,
    zoo_model_dir: str = "",
    demucs_jobs: int = 1,
    threads: int = 0,
) -> TorchDemucs | MlxDemucs | Roformer | Any | None:
    """The separator for the RESOLVED backend, or None when this box cannot build one — a refused job rather
    than a crashed process, `host.capabilities` having already declined to advertise `stems`.

    `model` MAY BE None, meaning "this job named none": the resolvers RAISE on an explicit unknown name and
    fall back only on None (docs/arch/05-worker.md §2.4).
    """
    from encore_worker.host.hardware import binary_available, module_available

    # An explicit engine wins over the box's default backend (docs/arch/05-worker.md §2.4).
    if engine == "audiosep":
        if not module_available("audio_separator"):
            return None
        from encore_worker.adapters import zoo  # noqa: PLC0415
        from encore_worker.adapters.audiosep import ZooSeparator  # noqa: PLC0415

        # No default checkpoint for the zoo, unlike demucs: there are ~135 and no single one is the obvious
        # choice, so the best-published-score entry is used when a job names none. `catalogue()` is sorted
        # by upstream instrumental SDR, so [0] IS that entry.
        token = model or (zoo.catalogue()[0].token if zoo.catalogue() else None)
        if token is None:
            return None
        return ZooSeparator(token=token, model_file_dir=zoo_model_dir, device=device)
    if engine == "roformer":
        return (
            Roformer(model=model if model in ROFORMER_MODELS else None, device=device, threads=threads)
            if binary_available("bs-roformer-infer")
            else None
        )
    if backend == "mlx":
        if not binary_available(mlx_bin):
            return None
        return MlxDemucs(model=model, mlx_bin=mlx_bin, ffmpeg_bin=ffmpeg_bin)
    if not module_available("demucs"):
        return None
    return TorchDemucs(model=model, device=device, jobs=demucs_jobs, threads=threads)


__all__ = [
    "DEMUCS_MODELS",
    "ROFORMER_MODELS",
    "Roformer",
    "SeparationFailed",
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
