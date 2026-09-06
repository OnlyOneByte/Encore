"""BS-RoFormer separation engine: its model registry, its argv, and where it writes stems.

Selected when a stems job carries `params.engine == 'roformer'`, resolved by `engine_for` in
`separation/engines.py` before the first step runs. Uses the bs-roformer-infer package (inference-only,
MIT), which owns checkpoint download + sha256 verification and a repointable model registry.

INTEGRATION: bs-roformer-infer 0.1.5 exposes a CLI (`bs-roformer-infer`), not the README's
BSRoformerSession (that API is not in 0.1.5). So this engine shells the CLI as a subprocess — which
matches the demucs pattern exactly and keeps bs_roformer/torch OFF the dial-home process. `--model
<slug>` auto-resolves and sha256-downloads the checkpoint on first use, so there is no separate
download step. Flags confirmed against `bs-roformer-infer --help` on 0.1.5.

PURE, all of it: the model-token→slug map, the argv builder, and the output-stem discovery. No torch, no
subprocess, no orchestration — `RoformerProcessor` was deleted in S3 and `steps/separate.py` runs the job.
The two places this engine genuinely differs from demucs (its input must be ALONE in a directory, and its
outputs must be DISCOVERED rather than derived from the model name) are stated in `engines.py`.

⚠️ A REAL COOK IS UNVERIFIED IN THIS ENVIRONMENT. A ~45-minute CPU cook plus the ~700MB first-run
checkpoint download are needed to confirm (a) the exact output-stem filenames bs-roformer-infer
writes into --store_dir, and (b) that each whitelist token maps to a live registry slug. The package
IMPORTS and pip-checks clean on the pinned torch 2.8 stack (verified); the end-to-end cook does not
run here. Until a network-enabled worker confirms it, a roformer cook only runs where an operator has
set the `stems:roformer` capability.
"""
from __future__ import annotations

import os

# ── pure helpers (no torch, no session) ──────────────────────────────────────────

#: Our stable whitelist tokens (packages/shared/src/separators.ts) → bs-roformer-infer registry
#: slugs. Kept here, not in the shared TS, because the slug is a WORKER-side resolution detail the
#: core never needs to know — the core only validates the token.
#:
#: ⚠️ KNOWN MISMATCH, verified against the installed package on 2026-09-03. The token
#: `bs-roformer-1297` resolves to `BS-Rofo-SW-Fixed.ckpt` (registry entry "BS Roformer SW by
#: jarredou", category multi-stem) — which is NOT `model_bs_roformer_ep_317_sdr_12.9755.ckpt`, the
#: 2-stem checkpoint that was actually benchmarked and quality-approved. bs-roformer-infer 0.1.5's
#: registry holds exactly ten models (see ROFORMER_REGISTRY_SLUGS) and the ep_317 checkpoint is not
#: among them, so this token cannot currently be pointed at the approved model through this package.
#: Deliberately NOT silently repointed to some other slug: swapping the cooked model without a
#: listening test is the failure this comment exists to prevent. The engine-package decision (adopt
#: python-audio-separator) is recorded in docs/DECISIONS.md.
#:
#: The former `mel-roformer-inst-v2` token is GONE. It mapped to
#: `roformer-model-bs-roformer-fno-instrumental-by-pcunwa`, which is absent from the registry, and
#: mel-band is unreachable regardless: bs_roformer's `get_model_from_config` implements only
#: `model_type == 'bs_roformer'`, and the package ships no mel_band module. It was an option the phone
#: offered that no worker could ever have satisfied.
ROFORMER_MODELS = {
	"bs-roformer-1297": "roformer-model-bs-roformer-sw-by-jarredou",
}

#: Every slug bs-roformer-infer 0.1.5 can actually resolve, read out of its own
#: `bs_roformer/data/bs_models.json`. Checked in so `ROFORMER_MODELS` is verifiable by a unit test
#: rather than by a string-shape assertion — the previous test asserted only that a slug *started
#: with* "roformer-model-", which is exactly why a nonexistent slug shipped.
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

#: Measured execution settings per whitelist token — the worker-side mirror of
#: `SeparatorCost` in packages/shared/src/separators.ts. Benchmarked on the reference box
#: (32-core Graviton 3, CPU) on 2026-09-03: 26.59s per 8s window at fp32, 16.55s at bf16.
#:
#: `precision` is per-token and NOT globally derivable: bf16 is 1.6× faster than fp32 on this
#: checkpoint, but measured 1.4–1.8× SLOWER on the mel-band models with an 8s window, and fp16 on CPU
#: is 6.5× slower than fp32 (no fp16 CPU kernels). A GPU backend overrides `precision` — fp16 is the
#: lever on Arc XMX and Apple MPS.
#:
#: ⚠️ NEITHER VALUE IS APPLIED TODAY. bs-roformer-infer 0.1.5's CLI takes only
#: model_type/config_path/model_path/model/models_dir/input_folder/store_dir/device/device_ids: there
#: is no overlap flag and no precision flag, and its `inference.py` contains no autocast at all.
#: `overlap` is reachable only indirectly, by writing a modified config YAML and passing
#: `--config_path` (its inference loop reads `config.inference.num_overlap`); `precision` is not
#: reachable without patching the package. Recorded here as the measured intent so the numbers are not
#: lost, and as concrete evidence for the engine-package decision.
ROFORMER_COST = {
	"bs-roformer-1297": {"overlap": 4, "precision": "bf16", "rt_factor": 8.28},
}


def roformer_cost(token: str) -> dict | None:
	"""Measured execution settings for a whitelist token, or None when the token is unknown. Returns
	None rather than a default because a fabricated cost would be indistinguishable from a measured
	one at the call site."""
	return ROFORMER_COST.get(token)


DEFAULT_ROFORMER_MODEL = "bs-roformer-1297"


def resolve_roformer_slug(params: dict, default: str = DEFAULT_ROFORMER_MODEL) -> str:
	"""Map the job's whitelist model token to a bs-roformer-infer registry slug. An explicit-but-
	unknown token raises (job fails non-retryable) rather than silently separating with the default —
	same contract as resolve_demucs_model."""
	token = params.get("model") or default
	slug = ROFORMER_MODELS.get(token)
	if slug is None:
		raise ValueError(f"unknown roformer model {token!r}; expected one of {sorted(ROFORMER_MODELS)}")
	return slug


def find_roformer_instrumental(store_dir: str) -> str | None:
	"""bs-roformer-infer writes `<name>_(Instrumental)_<model>.<ext>` (and a matching vocals file)
	into store_dir. Return the instrumental path, or None if none was produced. Matched case-
	insensitively on the stem name so a future output-naming tweak upstream does not silently break
	the pickup (the exact template is one of the things a real cook must confirm)."""
	if not os.path.isdir(store_dir):
		return None
	for name in os.listdir(store_dir):
		low = name.lower()
		if "instrumental" in low and low.endswith((".wav", ".flac")):
			return os.path.join(store_dir, name)
	return None


def find_roformer_vocals(store_dir: str) -> str | None:
	if not os.path.isdir(store_dir):
		return None
	for name in os.listdir(store_dir):
		low = name.lower()
		if "vocal" in low and low.endswith((".wav", ".flac")):
			return os.path.join(store_dir, name)
	return None


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
