"""python-audio-separator engine: its model registry, its argv, and where it writes stems.

Selected when a stems job carries `params.engine == 'audiosep'`, resolved by `engine_for` in
`separation/engines.py` before the first step runs. Uses the `python-audio-separator` package
(nomadkaraoke, MIT — DECISIONS.md), which wraps the UVR model family (MDX-Net, VR Arch, Demucs,
MDXC/RoFormer) and owns checkpoint download + the CLI.

WHY THIS ENGINE, ALONGSIDE `roformer`: audio-separator reaches the fast MEL-BAND RoFormer checkpoints
that `bs-roformer-infer` cannot. `bs_roformer`'s `get_model_from_config` implements only
`model_type == 'bs_roformer'` and ships no mel_band module, so every mel-band checkpoint is unreachable
through that package (see roformer.py's `#: KNOWN MISMATCH` note). audio-separator runs them as a
first-class MDXC path. The measured win is large: `mel instrumental_becruily` benchmarks at rt 1.28 on
the reference box (32-core Graviton 3, CPU) versus `bs_roformer-1297` at rt 13.29 — a 10.4x
RoFormer-family instrumental process, no GPU (docs/benchmarks/SUMMARY.md §4). Adopted ALONGSIDE
`bs-roformer-infer`, not replacing it — both engines, issue an earlier change owner ruling Q1(b)
(docs/DECISIONS.md).

INTEGRATION: audio-separator exposes a CLI (`audio-separator <input> --model_filename <ckpt>
--model_file_dir <dir> --output_dir <dir> --output_format FLAC`), confirmed against the repo's own
benchmark scripts (docs/benchmarks/scripts/{family_bench.sh,checkpoint_cost.py}). So this engine shells
the CLI as a subprocess — matching the demucs and roformer pattern, keeping torch/audio_separator OFF the
dial-home process. `--model_filename` auto-resolves and downloads the checkpoint on first use, so there is
no separate download step.

PURE, all of it: the model-token→checkpoint-filename map, the argv builder, and the output-stem
discovery. No torch, no subprocess, no orchestration — `steps/separate.py` runs the job. The two places
this engine differs from demucs (its input is a single named FILE, and its outputs must be DISCOVERED by
globbing the output dir rather than derived from the model name) are the same shape roformer already
carries, stated in `engines.py`.

⚠️ A REAL PROCESS IS UNVERIFIED IN THIS ENVIRONMENT — the identical caveat roformer.py carries.
audio-separator
is not installed on the dev/CI box (aarch64), and a real process plus the first-run checkpoint download need a
network-enabled worker. The package's CLI contract and the checkpoint filename are confirmed against the
repo's committed benchmark scripts; the end-to-end process does not run here. Until a network-enabled worker
confirms the exact output-stem filenames, an audiosep process only runs where an operator has set the
`stems:audiosep` capability (which is advertised only when the dep is present — capabilities.py).

⚠️ The `instrumental_becruily` checkpoint ships as a LIVE-SELECTABLE model with TWO caveats the owner
accepted knowingly (owner ruling Option A): it has no prior ear-approval (only
`bs-roformer-1297` has a published SDR and an owner listening test — SUMMARY.md §4), and its model weights
may carry non-commercial / research licence terms on their Hugging Face card (DECISIONS.md's MIT clearance
covers the PACKAGES surveyed, not the individual checkpoint weights). Both were flagged and the owner took
the call.
"""

from __future__ import annotations

import os

from ..retry_policy import BoundaryError

# ── pure helpers (no torch, no subprocess) ───────────────────────────────────────

#: Our stable whitelist tokens (src/lib/contract/lyrics/separators.ts) → audio-separator
#: `--model_filename` checkpoint filenames. Kept here, not in the shared TS, because the checkpoint
#: filename is a WORKER-side resolution detail the core never needs to know — the core only validates
#: the token. The filename is the exact string audio-separator resolves and downloads; it is the one the
#: repo's benchmark scripts measured (docs/benchmarks/scripts/checkpoint_cost.py).
AUDIOSEP_MODELS = {
    "instrumental_becruily": "mel_band_roformer_instrumental_becruily.ckpt",
}

DEFAULT_AUDIOSEP_MODEL = "instrumental_becruily"


def resolve_audiosep_checkpoint(params: dict, default: str = DEFAULT_AUDIOSEP_MODEL) -> str:
    """Map the job's whitelist model token to an audio-separator checkpoint filename. An explicit-but-
    unknown token raises (job fails non-retryable) rather than silently separating with the default —
    the identical contract as resolve_demucs_model / resolve_roformer_slug. A silent substitution would
    ship a different instrumental than the room asked for."""
    token = params.get("model") or default
    checkpoint = AUDIOSEP_MODELS.get(token)
    if checkpoint is None:
        # BoundaryError subclasses ValueError (drop-in for pytest.raises(ValueError)) but carries the
        # shared structured retryable = False, so an unknown token fails fast via retry_policy instead of
        # burning three process attempts on a token that can never resolve — same as an earlier change gave
        # demucs.
        raise BoundaryError(f"unknown audiosep model {token!r}; expected one of {sorted(AUDIOSEP_MODELS)}")
    return checkpoint


def _find_audiosep_stem(out_dir: str, marker: str) -> str | None:
    """audio-separator writes `<name>_(Stem)_<model>.<ext>` into --output_dir (the UVR default output
    template) — e.g. `input_(Instrumental)_mel_band_roformer_instrumental_becruily.flac`. Match the
    DELIMITED role marker (`_(instrumental)_` / `_(vocals)_`), not a bare `"instrumental"` / `"vocal"`
    substring: the model filename is part of the output name and itself contains `instrumental` (and
    other checkpoints contain `vocals`), so a bare substring test lets the instrumental file satisfy the
    vocals search and vice-versa — the exact `_find_roformer_stem` trap. The marker sits before
    the model name and is unaffected by it. Listing is sorted so the pick is deterministic (os.listdir
    order is unspecified), matching roformer.py and acquisition/fetch.py:find_downloaded. Matched
    case-insensitively so an upstream output-naming tweak does not silently break the pickup (the exact
    template is confirmed by a real process)."""
    if not os.path.isdir(out_dir):
        return None
    needle = marker.lower()
    for name in sorted(os.listdir(out_dir)):
        low = name.lower()
        if needle in low and low.endswith((".wav", ".flac")):
            return os.path.join(out_dir, name)
    return None


def find_audiosep_instrumental(out_dir: str) -> str | None:
    """Return the instrumental stem audio-separator wrote into out_dir, or None. See _find_audiosep_stem
    for why the delimited `_(Instrumental)_` marker is matched, not `instrumental`."""
    return _find_audiosep_stem(out_dir, "_(instrumental)_")


def find_audiosep_vocals(out_dir: str) -> str | None:
    """Return the vocals stem audio-separator wrote into out_dir, or None. See _find_audiosep_stem for
    why the delimited `_(Vocals)_` marker is matched, not `vocal`."""
    return _find_audiosep_stem(out_dir, "_(vocals)_")


def audiosep_argv(
    input_wav: str,
    out_dir: str,
    checkpoint: str,
    *,
    model_file_dir: str | None = None,
    bin: str = "audio-separator",
) -> list[str]:
    """audio-separator CLI argv. Confirmed against docs/benchmarks/scripts/family_bench.sh:

        audio-separator <input> --model_filename <ckpt> --model_file_dir <dir> \\
            --output_dir <dir> --output_format FLAC

    Unlike bs-roformer-infer's `--input_folder`, audio-separator takes the input FILE as its positional
    argument, so no dedicated input directory is needed. `--model_filename` auto-resolves and downloads
    the checkpoint on first use. `--output_format FLAC` matches the lossless stem the pipeline publishes;
    the stems still pass through the pipeline's own FLAC encode (PublishStems) for a uniform container.
    `--model_file_dir` points at the shared host-side checkpoint cache when set, so the ~hundreds-of-MB
    download happens once per box, not once per process."""
    argv = [
        bin,
        input_wav,
        "--model_filename",
        checkpoint,
        "--output_dir",
        out_dir,
        "--output_format",
        "FLAC",
    ]
    if model_file_dir:
        argv += ["--model_file_dir", model_file_dir]
    return argv
