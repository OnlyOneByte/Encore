"""BS-RoFormer separation engine (B-8). Same Processor interface as DemucsProcessor, selected when a
stems job carries params.engine == 'roformer'. Uses the bs-roformer-infer package (inference-only,
MIT), which owns checkpoint download + sha256 verification and a repointable model registry.

INTEGRATION: bs-roformer-infer 0.1.5 exposes a CLI (`bs-roformer-infer`), not the README's
BSRoformerSession (that API is not in 0.1.5). So this engine shells the CLI as a subprocess — which
matches the demucs pattern exactly and keeps bs_roformer/torch OFF the dial-home process. `--model
<slug>` auto-resolves and sha256-downloads the checkpoint on first use, so there is no separate
download step. Flags confirmed against `bs-roformer-infer --help` on 0.1.5.

The PURE half (model-token→slug map, argv builder, output-stem resolver) has no torch and is
unit-tested. Only a worker advertising the `stems:roformer` capability builds this processor.

⚠️ A REAL COOK IS UNVERIFIED IN THIS ENVIRONMENT. A ~45-minute CPU cook plus the ~700MB first-run
checkpoint download are needed to confirm (a) the exact output-stem filenames bs-roformer-infer
writes into --store_dir, and (b) that each whitelist token maps to a live registry slug. The package
IMPORTS and pip-checks clean on the pinned torch 2.8 stack (verified); the end-to-end cook does not
run here. Until a network-enabled worker confirms it, a roformer cook only runs where an operator has
set the `stems:roformer` capability.
"""
from __future__ import annotations

import os
from typing import AsyncIterator

from .processor import (
	CompleteResult,
	JobSpec,
	ProgressEvent,
	instrumental_path,
	vocals_path,
	source_audio_path,
	INSTRUMENTAL_EXT,
	VOCALS_EXT,
)

# ── pure helpers (no torch, no session) ──────────────────────────────────────────

#: Our stable whitelist tokens (packages/shared/src/separators.ts) → bs-roformer-infer registry
#: slugs. Kept here, not in the shared TS, because the slug is a WORKER-side resolution detail the
#: core never needs to know — the core only validates the token. See the module warning about slug
#: verification.
ROFORMER_MODELS = {
	"bs-roformer-1297": "roformer-model-bs-roformer-sw-by-jarredou",
	"mel-roformer-inst-v2": "roformer-model-bs-roformer-fno-instrumental-by-pcunwa",
}

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



# ── IO: the processor (subprocess CLI; matches the demucs pattern, torch off dial-home) ───────────
class RoformerProcessor:
	"""Stems processor for engine='roformer'. Fetch source (yt-dlp/ffmpeg, reusing the demucs argv
	builders) → shell `bs-roformer-infer --model <slug>` (it auto-downloads + sha256-verifies the
	checkpoint on first use) → encode instrumental to FLAC and vocals to AAC at the same MediaStore
	paths the demucs engine uses, so playbackRef is engine-agnostic. Same async-generator contract as
	DemucsProcessor; the CLI runs as a subprocess so bs_roformer never imports into this process.

	⚠️ NOT yet verified end to end here — a ~45-min CPU cook plus the ~700MB first-run download are
	needed to confirm the exact output-stem filenames and the token→slug mapping. The plumbing mirrors
	DemucsProcessor and the CLI flags are confirmed against bs-roformer-infer 0.1.5 --help."""

	def __init__(self, *, device: str | None = None, flac_level: int = 8, roformer_bin: str = "bs-roformer-infer") -> None:
		self._device = device
		self._flac_level = flac_level
		self._roformer_bin = roformer_bin

	async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
		from . import demucs as d  # reuse fetch/encode argv builders + the subprocess runner

		slug = resolve_roformer_slug(job.params)  # raises on an unknown token (non-retryable)
		work = os.path.join(job.media_dir, "work", job.job_id)
		in_dir = os.path.join(work, "roformer_in")
		os.makedirs(in_dir, exist_ok=True)

		# ── stage 1: obtain + decode the source (identical to the demucs path) ──
		if d.is_local_source(job.source_uri):
			input_path = os.path.join(job.media_dir, job.source_uri)
			yield ProgressEvent(stage="downloading", pct=100)
		else:
			audio_dir = os.path.dirname(source_audio_path(job.media_dir, job.media_id))
			os.makedirs(audio_dir, exist_ok=True)
			out_tmpl = os.path.join(audio_dir, f"{job.media_id}.%(ext)s")
			async for line in d.subprocess_runner(d.download_argv(job.source_uri, out_tmpl, "yt-dlp")):
				pct = d.parse_ytdlp_progress(line)
				if pct is not None:
					yield ProgressEvent(stage="downloading", pct=pct)
			input_path = d.find_downloaded(audio_dir, job.media_id)
			if input_path is None:
				raise RuntimeError(f"download produced no audio for {job.media_id}")
		# bs-roformer-infer separates every WAV in --input_folder, so the decoded input is the only
		# file in its own dir (not the shared work/ dir, which holds the store output too).
		sep_input = os.path.join(in_dir, "input.wav")
		async for _ in d.subprocess_runner(d.decode_argv(input_path, sep_input)):
			pass

		# ── stage 2: separate (bs-roformer-infer CLI — subprocess, streams progress) ──
		store = os.path.join(work, "separated")
		os.makedirs(store, exist_ok=True)
		yield ProgressEvent(stage="separating", pct=0)
		async for _line in d.subprocess_runner(
			roformer_argv(in_dir, store, slug, device=self._device, bin=self._roformer_bin)
		):
			pass  # bs-roformer-infer's tqdm output is not a stable pct source; coarse 0→100 for now
		yield ProgressEvent(stage="separating", pct=100)

		# ── stage 3: encode + publish (FLAC instrumental, AAC vocals — B-7 policy) ──
		produced = find_roformer_instrumental(store)
		if produced is None:
			raise RuntimeError(f"roformer produced no instrumental in {store}")
		final = instrumental_path(job.media_dir, job.media_id)
		os.makedirs(os.path.dirname(final), exist_ok=True)
		async for _ in d.subprocess_runner(d.encode_flac_argv(produced, final, level=self._flac_level)):
			pass

		stems = {"instrumental": final}
		vocals_src = find_roformer_vocals(store)
		if vocals_src is not None:
			try:
				vocals_final = vocals_path(job.media_dir, job.media_id)
				async for _ in d.subprocess_runner(d.encode_stem_argv(vocals_src, vocals_final)):
					pass
				stems["vocals"] = vocals_final
			except Exception as exc:  # noqa: BLE001 — vocals is an enhancement, never fail the cook for it
				print(f"[worker] roformer vocals encode failed (non-fatal): {type(exc).__name__}", flush=True)

		yield CompleteResult(media_uri=final, artifacts={"stems": stems})
