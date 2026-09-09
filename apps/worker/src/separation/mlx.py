"""demucs-mlx: the argv, the progress parsing, the stem paths its CLI produces, and the mix-minus
derivation that turns its four stems into the two the pipeline expects.

PURE, like `demucs.py` — argv builders and path resolvers only, nothing here runs a job.

WHY THIS EXISTS AS ITS OWN MODULE, not a flag on `demucs.py`. `demucs-mlx` is a different CLI with a
different output contract, MEASURED against its published contract (README + `demucs_mlx/separate.py`
on `ssmall256/demucs-mlx`), not assumed to match the torch `demucs` CLI:

  * NO `--two-stems`. It always emits every source the model carries — four for htdemucs / htdemucs_ft
    (drums, bass, other, vocals), six for htdemucs_6s (adds piano, guitar). There is no flag to ask it
    for a 2-stem vocals/no_vocals split, so the instrumental does not exist as a file and must be
    DERIVED.
  * NO `--filename` template. The torch engine flattens its output to `<out>/<model>/<stem>.wav` with
    `--filename {stem}.{ext}`; demucs-mlx has no such flag and writes the demucs-native nested layout
    `<out>/<track-stem>/<source>.wav`, where `<track-stem>` is the input filename without its
    extension (`separate.py`: `track_out = out_dir / path.stem`). So the decoded input is named
    `input.wav` and the stems land in `<out>/input/{vocals,drums,bass,other}.wav`.
  * Flags it DOES take: `-n/--name`, `-o/--out`, `--overlap`, `--shifts`, `--segment`, `-b/--batch-size`.
    No `-d/--device` (MLX targets Metal on Apple Silicon and its own CPU fallback; there is no torch
    device string to pass) and no `-j/--jobs` (it parallelises with `-b`/`--write-workers`, not demucs's
    per-chunk model-copy jobs).

THE MIX-MINUS DERIVATION. The rest of the pipeline wants ONE instrumental WAV (`no_vocals.wav`) plus the
isolated vocals. demucs-mlx gives four stems, so the instrumental is `drums + bass + other` summed with
`amix`. The one trap, and the reason `normalize=0` is not optional: `amix` NORMALISES by default, dividing
the sum by the input count — three stems summed with the default would come out at a THIRD of the level, a
quiet instrumental that sounds merely "turned down" rather than broken, so it would pass a naive listen and
ship. `normalize=0` makes `amix` a true sum, which is the level the source had. Summing the non-vocal stems
(rather than phase-subtracting vocals from the source mix) is deliberate: the stems are the model's own
decomposition of the identical resampled input, so they are sample-aligned by construction, whereas a
phase-subtraction against the pre-separation mix depends on exact phase/level alignment that mlx-audio-io's
resample step does not guarantee. The residual energy the model assigns to none of drums/bass/other is left
out — an accepted, small loss versus the correctness risk of a misaligned subtraction.
"""

from __future__ import annotations

import os

from ..retry_policy import BoundaryError

DEFAULT_MODEL = "htdemucs"

# The demucs-family checkpoints demucs-mlx carries AND this engine will run. Intersection of the
# torch engine's whitelist (packages/shared/src/lyrics/separators.ts, mirrored in demucs.py DEMUCS_MODELS)
# with the models demucs-mlx ships — the same three, so an mlx cook resolves the exact checkpoint a
# torch cook would. Defence in depth: the core validates engine+model before enqueue, but a worker
# must never shell `demucs-mlx -n <arbitrary>` from a job param.
MLX_MODELS = ("htdemucs", "htdemucs_ft", "htdemucs_6s")

# The non-vocal sources of a 4-stem htdemucs/htdemucs_ft model, summed to form the instrumental.
# htdemucs_6s adds "piano" and "guitar"; see mlx_instrumental_sources below, which derives the set
# from the model rather than hardcoding four names.
_FOUR_STEM_INSTRUMENTAL = ("drums", "bass", "other")
_SIX_STEM_EXTRA = ("piano", "guitar")


def resolve_mlx_model(params: dict, default: str = DEFAULT_MODEL) -> str:
    """Pick the demucs-mlx checkpoint for a job: the whitelisted `params['model']`, else the worker
    default. An explicit-but-unknown model raises non-retryable (BoundaryError, like resolve_demucs_model)
    rather than shelling an arbitrary name."""
    requested = params.get("model")
    if requested is None or requested == "":
        return default
    if requested not in MLX_MODELS:
        raise BoundaryError(f"unknown demucs-mlx model {requested!r}; expected one of {MLX_MODELS}")
    return requested


def mlx_instrumental_sources(model: str = DEFAULT_MODEL) -> tuple[str, ...]:
    """The stem files that sum to the instrumental for this model — every source EXCEPT vocals.

    Four-stem models contribute drums/bass/other; the 6-source htdemucs_6s adds piano/guitar. Derived
    from the model name rather than hardcoded, so a 6s cook sums all five non-vocal stems instead of
    silently dropping piano and guitar from the backing track."""
    if model == "htdemucs_6s":
        return _FOUR_STEM_INSTRUMENTAL + _SIX_STEM_EXTRA
    return _FOUR_STEM_INSTRUMENTAL


def mlx_track_dir(out_dir: str, input_wav: str) -> str:
    """Where demucs-mlx writes this track's stems: `<out_dir>/<input-stem>/`.

    demucs-mlx names the per-track folder from the INPUT filename (`separate.py`: `out_dir / path.stem`),
    NOT the model — the one place its layout differs from what a model-name-keyed helper would guess. The
    decoded input is always `input.wav` (DecodeToWav → engine.input_wav), so this is `<out_dir>/input`."""
    stem = os.path.splitext(os.path.basename(input_wav))[0]
    return os.path.join(out_dir, stem)


def mlx_stem_path(out_dir: str, input_wav: str, source: str) -> str:
    """The path of one separated source WAV in the demucs-mlx nested layout."""
    return os.path.join(mlx_track_dir(out_dir, input_wav), f"{source}.wav")


def mlx_vocals_path(out_dir: str, input_wav: str) -> str:
    """The isolated vocals stem demucs-mlx writes — published as the guiding track, same as torch."""
    return mlx_stem_path(out_dir, input_wav, "vocals")


def mlx_instrumental_path(out_dir: str, input_wav: str) -> str:
    """Where the DERIVED instrumental is written. It sits BESIDE the model's real stems, named
    `no_vocals.wav` so the rest of the pipeline reads it exactly like the torch engine's instrumental —
    the derivation is the only thing that differs, the downstream contract is identical."""
    return mlx_stem_path(out_dir, input_wav, "no_vocals")


def mlx_argv(
    input_path: str,
    out_dir: str,
    model: str = DEFAULT_MODEL,
    mlx_bin: str = "demucs-mlx",
    *,
    overlap: float | None = None,
    segment: int | None = None,
    shifts: int | None = None,
    batch_size: int | None = None,
) -> list[str]:
    """demucs-mlx argv: separate `input_path` into `out_dir`.

    No `--two-stems` and no `--filename` — neither flag exists (see module docstring). The input file is
    the final positional, matching the CLI's `tracks` nargs. Every performance flag is optional and
    omitted when unset so demucs-mlx's own defaults apply."""
    argv = [mlx_bin, "-n", model, "-o", out_dir]
    if overlap is not None:
        argv += ["--overlap", str(overlap)]
    if segment is not None:
        argv += ["--segment", str(segment)]
    if shifts is not None:
        argv += ["--shifts", str(shifts)]
    if batch_size is not None:
        argv += ["-b", str(batch_size)]
    argv.append(input_path)
    return argv


def mix_minus_instrumental_argv(
    out_dir: str,
    input_wav: str,
    model: str = DEFAULT_MODEL,
    ffmpeg_bin: str = "ffmpeg",
) -> list[str]:
    """ffmpeg argv that sums the non-vocal stems into the instrumental `no_vocals.wav`.

    `amix=inputs=N:normalize=0` is a TRUE sum, not the default average — see the module docstring for
    why `normalize=0` is load-bearing (the default would emit the instrumental at 1/N level). Output is
    16-bit stereo PCM WAV, the same raw scratch format the torch engine's `no_vocals.wav` is, so
    ProbeSilence and PublishStems read it unchanged.
    """
    sources = mlx_instrumental_sources(model)
    argv: list[str] = [ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y"]
    for src in sources:
        argv += ["-i", mlx_stem_path(out_dir, input_wav, src)]
    argv += [
        "-filter_complex",
        f"amix=inputs={len(sources)}:normalize=0",
        "-c:a",
        "pcm_s16le",
        "-ac",
        "2",
        mlx_instrumental_path(out_dir, input_wav),
    ]
    return argv
