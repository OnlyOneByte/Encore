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

    def __init__(self, *, model: str | None = "htdemucs", device: str = "cpu", jobs: int = 1) -> None:
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
        self, *, model: str | None = "htdemucs", mlx_bin: str = "demucs-mlx", ffmpeg_bin: str = "ffmpeg"
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


# ── bs-roformer ──────────────────────────────────────────────────────────────────────────────────
# The UPGRADE engine: core's `DEFAULT_GLOBAL_SETTINGS.upgradeEngine` is `roformer`, so a `stems-upgrade`
# job routes on `stems:roformer`. Ported from the old worker's `separation/roformer.py`, slugs and all.
#
# Shelled out to as a CLI rather than imported, for the same reason demucs is: it keeps bs_roformer and its
# torch import out of this process, so a box that merely ADVERTISES the capability does not pay a multi-second
# import at startup.

#: Allowlist tokens -> bs-roformer-infer registry slugs. Worker-side, because the slug is a resolution detail
#: the core never needs to know.
#:
#: KNOWN MISMATCH, carried over deliberately: `bs-roformer-1297` resolves to a MULTI-stem checkpoint rather
#: than the 2-stem one that was benchmarked. NOT silently repointed — swapping the processed model without a
#: listening test is exactly what this note prevents.
ROFORMER_MODELS = {
    # THE 2-STEM INSTRUMENTAL MODEL, and the default. Its registry category is `instrumental`, so the
    # checkpoint targets the thing that actually plays in the room; the vocals arrive as the complement.
    # A `vocals`-category model is equally 2-stem but targets the reference track, which is the wrong way
    # round for karaoke — the master should be the modelled output, not the leftover.
    "bs-roformer-1297": "roformer-model-bs-roformer-instrumental-resurrection-by-unwa",
    # The previous mapping, KEPT so historical `job_attempts.model` rows still resolve to something real
    # rather than raising `UnknownModel` when an operator opens an old audit page. `multi-stem`, which is
    # why it is no longer what `bs-roformer-1297` selects.
    "bs-roformer-multistem": "roformer-model-bs-roformer-sw-by-jarredou",
}

#: Every slug bs-roformer-infer 0.1.5 actually carries, read out of its own `bs_models.json` and CHECKED IN.
#:
#: Exists so `ROFORMER_MODELS` is verifiable against REAL slugs rather than against a string-shape assertion.
#: The old worker's note records why: a shape assertion let a bad slug ship. Restored here after the port
#: dropped it — and it earned its place immediately, because the registry nests its entries under a "models"
#: key and a naive read reports every slug as missing.
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


#: How bs-roformer-infer 0.1.5 names its two outputs, and WHICH ROLE EACH ACTUALLY HOLDS — measured, not
#: assumed. Both were wrong in the ported code, and the second one dangerously so.
#:
#: MEASURED on `roformer-model-bs-roformer-instrumental-resurrection-by-unwa`, CPU, with a chords-only control
#: (no vocals in the input, so the instrumental stem must hold everything):
#:
#:     source           rms 0.03608
#:     _instrumental    rms 0.00086   <- 2.4% of the signal. NEAR-SILENT.
#:     _other           rms 0.03574   <- 99.1% of the signal. THIS is the instrumental.
#:
#: So `<name>_other.wav` carries the backing track and `<name>_instrumental.wav` carries the vocals residual.
#: The names are inverted relative to their contents for this model.
#:
#: WHY THIS MATTERS MORE THAN A TYPO. The ported code looked for `<name>_(Instrumental)_<slug>.<ext>`, which
#: this package version never writes — so discovery returned None and the job failed. That is the SAFE
#: failure. Had the pattern matched, the worker would have published the VOCALS as the karaoke backing track,
#: and the silence probe would have waved it through because the vocals stem is loud. Silent, and audible only
#: in the room.
#:
#: Keyed by model slug because the mapping is a property of the CHECKPOINT, not of the CLI: a
#: `vocals`-category
#: model targets the other stem, so assuming one global order is what created this bug in the first place.
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

    NEVER RUN END TO END in this environment: a real pass needs a ~700 MB first-use checkpoint download and
    tens of minutes of CPU. The argv builder and the stem discovery below are unit-tested; the process is not.

    That is why `build_separator` returns this only when the CLI is on PATH. Advertising a capability the box
    cannot honour is WORSE than not advertising it: the core then routes upgrade work here and receives demucs
    output labelled as roformer, which nothing downstream can contradict.
    """

    name = "roformer"

    def __init__(
        self, *, model: str | None = None, device: str | None = None, bin: str = "bs-roformer-infer"
    ) -> None:
        self._slug = resolve_roformer_slug(model)
        self._device = device
        self._bin = bin

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
) -> TorchDemucs | MlxDemucs | Roformer | Any | None:
    """The separator for the RESOLVED backend, or None when this box cannot build one.

    None rather than a raise: `host.capabilities` already declines to advertise `stems` on a box with no
    engine, so reaching here with an unbuildable backend means the two disagreed — and returning None
    makes that a refused job rather than a crashed process.

    `model` MAY BE None, meaning "this job named none, use the engine's default". That is distinct from the
    empty string and from a name: `resolve_model` and `resolve_roformer_slug` both RAISE on an explicit
    unknown name and fall back only on None, because silently separating with the default would publish a
    backing track the operator did not choose and would be indistinguishable from the one they asked for.
    """
    from encore_worker.host.hardware import binary_available, module_available

    # An explicit engine wins over the box's default backend: a `stems-upgrade` job names `roformer`, and
    # honouring the backend instead would separate with demucs and label the result as the upgrade.
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
            Roformer(model=model if model in ROFORMER_MODELS else None, device=device)
            if binary_available("bs-roformer-infer")
            else None
        )
    if backend == "mlx":
        if not binary_available(mlx_bin):
            return None
        return MlxDemucs(model=model, mlx_bin=mlx_bin, ffmpeg_bin=ffmpeg_bin)
    if not module_available("demucs"):
        return None
    return TorchDemucs(model=model, device=device)


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
