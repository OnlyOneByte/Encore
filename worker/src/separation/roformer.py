"""BS-RoFormer separation engine: its model registry, its argv, and where it writes stems.

Selected when a stems job carries `params.engine == 'roformer'`, resolved by `engine_for` in
`separation/engines.py`. Uses the bs-roformer-infer package (inference-only, MIT), which owns
checkpoint download + sha256 verification and a repointable model registry.

INTEGRATION: bs-roformer-infer 0.1.5 exposes a CLI (`bs-roformer-infer`), not the README's
BSRoformerSession (not in 0.1.5). This engine shells the CLI as a subprocess, matching the demucs
pattern and keeping bs_roformer/torch OFF the dial-home process. `--model <slug>` auto-resolves and
sha256-downloads the checkpoint on first use.

PURE, all of it: the model-token->slug map, the argv builder, and output-stem discovery. No torch, no
subprocess, no orchestration.

A REAL PROCESS IS UNVERIFIED IN THIS ENVIRONMENT: confirming the exact output-stem filenames and that
each allowlist token maps to a live registry slug needs a ~45-minute CPU process plus a ~700MB
first-run checkpoint download. The package imports and pip-checks clean; a roformer process only runs
where an operator has explicitly set the `stems:roformer` capability.
"""

from __future__ import annotations

import os

from ..retry_policy import BoundaryError

#: Our stable allowlist tokens (src/lib/contract/lyrics/separators.ts) -> bs-roformer-infer registry
#: slugs. Kept here, not in the shared TS, since the slug is a WORKER-side resolution detail the core
#: never needs to know.
#:
#: KNOWN MISMATCH: the token `bs-roformer-1297` resolves to a multi-stem checkpoint ("BS Roformer SW
#: by jarredou"), NOT the 2-stem checkpoint that was actually benchmarked and quality-approved —
#: bs-roformer-infer 0.1.5's registry (ROFORMER_REGISTRY_SLUGS, ten models) does not carry the
#: approved checkpoint at all. Deliberately NOT silently repointed to some other slug: swapping the
#: processed model without a listening test is the failure this note exists to prevent.
ROFORMER_MODELS = {
    "bs-roformer-1297": "roformer-model-bs-roformer-sw-by-jarredou",
}

#: Every slug bs-roformer-infer 0.1.5 can actually resolve, read out of its own
#: `bs_roformer/data/bs_models.json`. Checked in so `ROFORMER_MODELS` is verifiable by a unit test
#: against real slugs, not a `starts with "roformer-model-"` string-shape assertion (which is how a
#: nonexistent slug shipped once).
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

#: Measured execution settings per allowlist token — the worker-side mirror of `SeparatorCost` in
#: src/lib/contract/lyrics/separators.ts. `precision` is per-token, not globally derivable: bf16 is
#: faster than fp32 on this checkpoint but SLOWER measured on mel-band models, and fp16 on CPU has no
#: kernels and is much slower than fp32.
#:
#: NEITHER VALUE IS APPLIED TODAY: bs-roformer-infer 0.1.5's CLI has no overlap flag and no precision
#: flag, and its inference loop has no autocast at all. Recorded here as measured intent so the
#: numbers are not lost.
ROFORMER_COST = {
    "bs-roformer-1297": {"overlap": 4, "precision": "bf16", "rt_factor": 8.28},
}


def roformer_cost(token: str) -> dict | None:
    """Measured execution settings for a allowlist token, or None when the token is unknown. Returns
    None rather than a default because a fabricated cost would be indistinguishable from a measured
    one at the call site."""
    return ROFORMER_COST.get(token)


DEFAULT_ROFORMER_MODEL = "bs-roformer-1297"


def resolve_roformer_slug(params: dict, default: str = DEFAULT_ROFORMER_MODEL) -> str:
    """Map the job's allowlist model token to a bs-roformer-infer registry slug. An explicit-but-
    unknown token raises (job fails non-retryable) rather than silently separating with the default —
    same contract as resolve_demucs_model."""
    token = params.get("model") or default
    slug = ROFORMER_MODELS.get(token)
    if slug is None:
        # BoundaryError subclasses ValueError but carries structured retryable=False, so an unknown
        # model fails fast via retry_policy instead of burning three attempts on a token that can
        # never resolve.
        raise BoundaryError(f"unknown roformer model {token!r}; expected one of {sorted(ROFORMER_MODELS)}")
    return slug


def _find_roformer_stem(store_dir: str, marker: str) -> str | None:
    """bs-roformer-infer writes `<name>_(Instrumental)_<slug>.<ext>` and `<name>_(Vocals)_<slug>.<ext>`
    into store_dir. Match the DELIMITED role marker, not a bare `"instrumental"`/`"vocal"` substring:
    several registry slugs themselves contain those words (e.g. `...-vocals-by-gabox`), so a bare
    substring test would let the instrumental file satisfy the vocals search and vice-versa. Listing
    is sorted so the pick is deterministic (os.listdir order is unspecified)."""
    if not os.path.isdir(store_dir):
        return None
    needle = marker.lower()
    for name in sorted(os.listdir(store_dir)):
        low = name.lower()
        if needle in low and low.endswith((".wav", ".flac")):
            return os.path.join(store_dir, name)
    return None


def find_roformer_instrumental(store_dir: str) -> str | None:
    """Return the instrumental stem bs-roformer-infer wrote into store_dir, or None. See
    _find_roformer_stem for why the delimited `_(Instrumental)_` marker is matched, not `instrumental`."""
    return _find_roformer_stem(store_dir, "_(instrumental)_")


def find_roformer_vocals(store_dir: str) -> str | None:
    """Return the vocals stem bs-roformer-infer wrote into store_dir, or None. See _find_roformer_stem
    for why the delimited `_(Vocals)_` marker is matched, not `vocal`."""
    return _find_roformer_stem(store_dir, "_(vocals)_")


def roformer_argv(
    input_folder: str,
    store_dir: str,
    slug: str,
    *,
    device: str | None = None,
    models_dir: str | None = None,
    bin: str = "bs-roformer-infer",
) -> list[str]:
    """bs-roformer-infer CLI argv. `--model <slug>` auto-resolves + sha256-downloads the checkpoint on
    first use (no separate download step). `--input_folder` holds the decoded input.wav; every WAV in
    it is separated into `--store_dir`. Device defaults to the CLI's own 'auto' when unset."""
    argv = [bin, "--model", slug, "--input_folder", input_folder, "--store_dir", store_dir]
    if device:
        argv += ["--device", device]
    if models_dir:
        argv += ["--models_dir", models_dir]
    return argv
