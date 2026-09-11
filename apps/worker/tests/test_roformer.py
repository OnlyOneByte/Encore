"""Roformer engine pure helpers + engine routing. The real BSRoformerSession cook is
REAL-ML/NET and unverified in this environment (see roformer.py's module warning), so these cover the
argv-free logic: model-token→slug resolution, output-stem discovery, and engine selection.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.separation import roformer  # noqa: E402
from tests.conftest import drain as _drain  # noqa: E402


def test_every_whitelist_token_resolves_to_a_real_registry_slug():
    """The assertion this replaces checked only that a slug STARTED WITH "roformer-model-", which a
    nonexistent slug satisfies — and one duly shipped (`mel-roformer-inst-v2` mapped to a slug absent
    from the registry). Check membership in the registry's actual slug set instead."""
    for token in roformer.ROFORMER_MODELS:
        slug = roformer.resolve_roformer_slug({"model": token})
        assert slug in roformer.ROFORMER_REGISTRY_SLUGS, f"{token} → {slug} is not a real slug"


def test_mel_band_tokens_are_not_offered():
    """bs_roformer's get_model_from_config implements only model_type == 'bs_roformer' and the package
    ships no mel_band module, so a mel-band token would be unrunnable however it were mapped."""
    assert not [t for t in roformer.ROFORMER_MODELS if "mel" in t]
    with pytest.raises(ValueError, match="unknown roformer model"):
        roformer.resolve_roformer_slug({"model": "mel-roformer-inst-v2"})


def test_every_whitelist_token_has_a_measured_cost():
    """A token without a cost entry silently loses its measured overlap/precision, which is how a
    checkpoint ends up running at a default nobody chose."""
    for token in roformer.ROFORMER_MODELS:
        cost = roformer.roformer_cost(token)
        assert cost is not None, f"{token} has no measured cost"
        assert cost["overlap"] >= 1
        assert cost["precision"] in ("fp32", "bf16")


def test_roformer_cost_is_none_for_unknown_token():
    assert roformer.roformer_cost("nope") is None


def test_resolve_roformer_slug_defaults_when_unset():
    assert roformer.resolve_roformer_slug({}) == roformer.ROFORMER_MODELS[roformer.DEFAULT_ROFORMER_MODEL]


def test_resolve_roformer_slug_rejects_unknown():
    with pytest.raises(ValueError, match="unknown roformer model"):
        roformer.resolve_roformer_slug({"model": "htdemucs"})  # a demucs token is unknown here


def test_find_roformer_stems_matches_case_insensitively(tmp_path):
    (tmp_path / "song_(Instrumental)_model.flac").write_text("x")
    (tmp_path / "song_(Vocals)_model.flac").write_text("x")
    assert roformer.find_roformer_instrumental(str(tmp_path)).endswith("_(Instrumental)_model.flac")
    assert roformer.find_roformer_vocals(str(tmp_path)).endswith("_(Vocals)_model.flac")


def test_find_roformer_instrumental_none_when_absent(tmp_path):
    assert roformer.find_roformer_instrumental(str(tmp_path)) is None
    assert roformer.find_roformer_instrumental(str(tmp_path / "nope")) is None


@pytest.mark.parametrize("slug", sorted(roformer.ROFORMER_REGISTRY_SLUGS))
def test_stem_discovery_is_not_fooled_by_a_slug_that_contains_the_other_role(tmp_path, slug):
    """bs-roformer-infer names its outputs `<name>_(Instrumental)_<slug>.<ext>` and
    `<name>_(Vocals)_<slug>.<ext>` — the resolved model slug is INSIDE the filename the discovery
    searches. Six of the ten registry slugs contain `vocals`/`instrumental`
    (roformer-model-bs-roformer-{vocals-by-gabox,vocals-resurrection-by-unwa,vocals-revive-by-unwa,
    vocals-revive-v2-by-unwa,vocals-revive-v3e-by-unwa,instrumental-resurrection-by-unwa}), so a bare
    substring match lets the instrumental file satisfy find_roformer_vocals (and, for the
    instrumental-named slug, the vocals file satisfy find_roformer_instrumental). Assert both stems
    resolve to their OWN role for every slug. RED on base for the six colliding slugs."""
    inst = tmp_path / f"input_(Instrumental)_{slug}.wav"
    vox = tmp_path / f"input_(Vocals)_{slug}.wav"
    inst.write_bytes(b"INST")
    vox.write_bytes(b"VOX")
    found_inst = roformer.find_roformer_instrumental(str(tmp_path))
    found_vox = roformer.find_roformer_vocals(str(tmp_path))
    assert found_inst == str(inst), f"{slug}: instrumental discovery returned {found_inst!r}"
    assert found_vox == str(vox), f"{slug}: vocals discovery returned {found_vox!r}"


def test_roformer_argv_shape():
    argv = roformer.roformer_argv("/in", "/out", "roformer-model-x", device="cpu")
    assert argv[0] == "bs-roformer-infer"
    assert "--model" in argv and "roformer-model-x" in argv
    assert argv[argv.index("--input_folder") + 1] == "/in"
    assert argv[argv.index("--store_dir") + 1] == "/out"
    assert argv[argv.index("--device") + 1] == "cpu"


def test_roformer_argv_omits_device_when_unset():
    argv = roformer.roformer_argv("/in", "/out", "slug")
    assert "--device" not in argv  # let the CLI's own 'auto' default apply


# ── engine selection ──────────────────────────────────────────────────────────────
#
# Was EngineRouter, a second dispatch layer that picked a whole processor per engine. Choosing a separator
# is plan SELECTION now (docs/ARCHITECTURE.md §7.1): `engine_for` resolves it before the
# first step runs, and one Separate step asks whichever engine won the same four questions.


def test_engine_selection_reads_the_job_param_and_defaults_to_demucs():
    from src.plans import resolve_engines
    from src.runtime.ctx import ResolvedEngines
    from src.separation.engines import engine_for

    assert engine_for(resolve_engines({"engine": "roformer"}, ResolvedEngines()).separator).id == "roformer"
    assert engine_for(resolve_engines({"engine": "demucs"}, ResolvedEngines()).separator).id == "demucs"
    # a job from an older core with no engine param → demucs
    assert engine_for(resolve_engines({}, ResolvedEngines()).separator).id == "demucs"


def test_engine_selection_raises_for_an_engine_that_does_not_exist():
    """The CORE only routes a roformer cook to a worker advertising `stems:roformer`, so an unknown engine
    here is a routing bug rather than a user choice — it should be loud."""
    from src.separation.engines import engine_for

    with pytest.raises(RuntimeError, match="no separator engine"):
        engine_for("spleeter")


def test_a_None_config_value_does_not_override_an_engine_default():
    """`stems_runner` passes every separator knob through, and a worker with no opinion passes None.
    Forwarding it would replace the engine's own default with nothing — and for the model that means
    resolve_*_model() gets None as its fallback and fails on a job that carried no model."""
    from src.separation.demucs import DEFAULT_MODEL
    from src.separation.engines import engine_for

    eng = engine_for("demucs", demucs_model=None, jobs=None, device=None)
    assert eng.resolve_model({}) == DEFAULT_MODEL


def test_the_demucs_default_cannot_reach_the_roformer_engine():
    """Issue #84 regression. `plans.stems_runner` forwards this worker's `demucs_model` (default
    "htdemucs") into `engine_for` on EVERY cook, roformer included (plans.py: the lone production caller).
    While the model slot was ONE engine-agnostic `default_model`, that demucs checkpoint reached
    `RoformerEngine` and replaced `DEFAULT_ROFORMER_MODEL` — a roformer cook carrying no `model` then
    raised `unknown roformer model 'htdemucs'` (a demucs name on a roformer engine) and the engine's
    declared default was unreachable.

    Model defaults are now per engine: `demucs_model` maps ONLY to demucs and `roformer_model` ONLY to
    roformer. This test drives the pre-fix production seam — a demucs checkpoint offered to the roformer
    engine — and asserts it does NOT become that engine's default.

    Fails on base: base's roformer branch admits a shared `default_model` AND accepts the demucs
    `demucs_model` is a no-op there, but the SHARED name that production actually forwarded
    (`default_model="htdemucs"`) is what stranded the default. So the load-bearing assertion is that the
    roformer engine, offered a demucs checkpoint through the model slot, still resolves its OWN default."""
    from src.separation.engines import engine_for
    from src.separation.roformer import DEFAULT_ROFORMER_MODEL, resolve_roformer_slug

    roformer_default_slug = resolve_roformer_slug({}, DEFAULT_ROFORMER_MODEL)

    # The pre-fix production seam: the demucs default was forwarded to EVERY engine via `default_model`.
    # After the fix that shared name no longer exists; a demucs checkpoint can only be offered as
    # `demucs_model`, which the roformer branch ignores. Either way the roformer engine must keep its own
    # default — never the demucs value.
    eng = engine_for(
        "roformer", default_model="htdemucs", demucs_model="htdemucs", roformer_bin="bs-roformer-infer"
    )
    assert eng.id == "roformer"
    assert eng.resolve_model({}) == roformer_default_slug, (
        "a demucs checkpoint reached the roformer engine and stranded DEFAULT_ROFORMER_MODEL"
    )

    # The roformer engine can still be given its OWN default explicitly.
    eng2 = engine_for("roformer", roformer_model=DEFAULT_ROFORMER_MODEL)
    assert eng2.resolve_model({}) == roformer_default_slug


# ── end-to-end roformer cook (fake bs-roformer-infer runner) ──────────────────────
#
# every test above is a pure-helper test — none constructs a stems job with
# `engine == "roformer"` and drives it through `plans.stems_runner`. So the four documented
# demucs/roformer differences (engines.py:1-20) and the resolved-slug `facts["model"]` were
# UNASSERTED, and a regression in the RoformerEngine seam (input handed the file not its dir,
# store_dir == input_folder, an output derived-not-discovered, facts recording the token) would
# ship on green. This drives the real engine (no `engine=` override on stems_runner → `pick`
# calls `engine_for("roformer", ...)` → a genuine RoformerEngine, NOT a demucs stand-in) with a
# fake `bs-roformer-infer` subprocess, and pins each difference.
import os as _os  # noqa: E402

from src import plans  # noqa: E402
from src.processor import CompleteResult, JobSpec, ProgressEvent  # noqa: E402
from src.retry_policy import is_retryable  # noqa: E402
from tests.cli_fakes import fake_cli_runner  # noqa: E402


def _roformer_fake_runner(
    store_writes: bool = True, write_vocals: bool = True, model_in_name: str = "sw-by-jarredou"
):
    """A fake runner scripting the real roformer cook shape: yt-dlp → ffmpeg decode → bs-roformer-infer
    → ffmpeg volumedetect probe → ffmpeg encode. It records every argv so the test can assert the seam
    (input WAV alone in its own dir, --store_dir a DIFFERENT dir from --input_folder), and writes the
    stems bs-roformer-infer would into --store_dir under names the engine could NOT have derived from the
    model token — so a passing discovery proves globbing, not a name template. `write_vocals=False`
    simulates a roformer run that produced the instrumental but not the vocals stem (best-effort path).

    The acquisition / volumedetect / encode branches (including the volumedetect branch that makes the
    silence probe real) live in the shared `fake_cli_runner`; only the bs-roformer-infer
    writes + tqdm progress are here."""
    calls: list[list[str]] = []

    async def roformer_handler(argv):
        store = argv[argv.index("--store_dir") + 1]
        _os.makedirs(store, exist_ok=True)
        if store_writes:
            # names that the engine's find_outputs must DISCOVER by globbing — the model slug in the
            # filename is NOT something find_roformer_* derives, so a match proves discovery.
            Path(_os.path.join(store, f"input_(Instrumental)_{model_in_name}.wav")).write_bytes(b"FAKE_INST")
            if write_vocals:
                Path(_os.path.join(store, f"input_(Vocals)_{model_in_name}.wav")).write_bytes(b"FAKE_VOX")
        # coarse tqdm progress — parse_progress returns None by design, so the step emits [0, 100]
        yield "  0%|          | 0/1 [00:00<?, ?it/s]"
        # an INTERMEDIATE tqdm pct — if RoformerEngine.parse_progress ever parsed tqdm (it must not,
        # tqdm is not a stable source), 47 would leak into the separating stream and red the coarse
        # assertion below. parse_progress returns None by design, so the step emits only 0 then 100.
        yield " 47%|████▋     | 1/2 [22:00<22:00]"
        yield "100%|██████████| 1/1 [45:00<00:00]"

    run = fake_cli_runner(handlers={"bs-roformer-infer": roformer_handler}, record=calls)
    return run, calls


def _rspec(tmp_path, **params):
    params.setdefault("engine", "roformer")
    return JobSpec(
        job_id="jr",
        media_id="mr",
        job_type="stems",
        source_uri="https://www.youtube.com/watch?v=rof",
        params=params,
        media_dir=str(tmp_path),
    )


@pytest.mark.asyncio
async def test_a_roformer_cook_runs_the_real_roformer_engine_end_to_end(tmp_path):
    """Drives a stems job with engine=roformer through plans.stems_runner and asserts the four
    documented demucs/roformer differences plus the resolved-slug fact — the coverage #86 is about.

    No `engine=` override, so stems_runner resolves the REAL RoformerEngine from params.engine; the
    fake runner only stands in for the bs-roformer-infer SUBPROCESS, not the engine."""
    runner, calls = _roformer_fake_runner()
    proc = plans.stems_runner(runner=runner)  # no engine= override → real RoformerEngine from params
    events = await _drain(proc, _rspec(tmp_path, model="bs-roformer-1297"))

    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1, "the roformer cook must publish"
    facts = completes[0].facts

    # (fact) the engine that ran is roformer, its backend is the CLI, not torch
    assert facts["engine"] == "roformer"
    assert facts["backend"] == "bs-roformer-infer"

    # (difference 4 / the reason facts.model exists) model is the RESOLVED SLUG, never the token
    assert facts["model"] == "roformer-model-bs-roformer-sw-by-jarredou"
    assert facts["model"] != "bs-roformer-1297", "facts must record the resolved slug, not the token"

    # locate the bs-roformer-infer invocation and its two directory flags
    rof = [c for c in calls if c[0] == "bs-roformer-infer"]
    assert len(rof) == 1, "the roformer CLI ran exactly once"
    argv = rof[0]
    input_folder = argv[argv.index("--input_folder") + 1]
    store_dir = argv[argv.index("--store_dir") + 1]

    # (difference 1) the decoded input WAV lands ALONE in its own dedicated directory (roformer_in),
    #                because bs-roformer-infer separates EVERY wav in --input_folder
    assert _os.path.basename(input_folder) == "roformer_in"
    assert _os.listdir(input_folder) == ["input.wav"], "input must be alone in its own dir"

    # (difference 2) separate takes the input DIRECTORY, and --store_dir is a DIFFERENT dir — putting
    #                output where input lives would re-separate the output on a second pass
    assert store_dir != input_folder, "store_dir must not be the input folder"
    # store_dir and input_folder are SIBLINGS under the same work dir (work/separated vs work/roformer_in),
    # not one nested in the other — so store's parent is that shared work dir, never the input folder itself.
    assert _os.path.dirname(store_dir.rstrip("/")).rstrip("/") != input_folder.rstrip("/")
    assert _os.path.dirname(store_dir.rstrip("/")).rstrip("/") == _os.path.dirname(
        input_folder.rstrip("/")
    ).rstrip("/")
    assert _os.path.basename(store_dir) == "separated"

    # (difference 4) outputs are DISCOVERED by globbing, not derived from the model name: the published
    #                instrumental resolves to the discovered file (its name carries a slug the helper
    #                could not have derived), proving find_outputs globbed the store
    inst = completes[0].artifacts["stems"]["instrumental"]
    assert inst.endswith("mr-instrumental.flac")
    assert Path(inst).exists()
    # the isolated vocals stem — the guiding track the TV mixes under the instrumental — is ALSO
    # published (mirrors the demucs cook test); without this the engine can map find_roformer_vocals
    # onto None and every roformer cook silently drops its guiding track with the suite still green.
    vox = completes[0].artifacts["stems"]["vocals"]
    assert vox.endswith("mr-vocals.flac")  # #480: vocals stem is lossless FLAC
    assert Path(vox).exists()

    # (difference 3) roformer's parse_progress returns None, so the child's tqdm percentages must NEVER
    # leak into progress — the only NON-terminal pct run_stage may emit for this stage is a time-based
    # keepalive, and roformer's is held at 0 (its last-known pct) so the bar never moves off 0 until the
    # closing 100. The invariant is therefore: no INTERMEDIATE (0 < pct < 100) value ever appears. This
    # does NOT pin the event COUNT — pinning [0, 100] would forbid the keepalive that #435 added to keep
    # a 45-minute pass from being reaped at the 30 s lease.
    seps = [e.pct for e in events if isinstance(e, ProgressEvent) and e.stage == "separating"]
    assert 0 in seps and 100 in seps
    assert not any(0 < p < 100 for p in seps), f"roformer must never leak an intermediate pct, got {seps}"


@pytest.mark.asyncio
async def test_a_roformer_cook_that_produces_no_instrumental_fails_loudly(tmp_path):
    """The find_outputs discovery contract, from the failure side: if bs-roformer-infer writes nothing
    into --store_dir, the Separate step must raise rather than publish a phantom cook — the same guard
    demucs has, now proven to fire on the roformer path too."""
    runner, _ = _roformer_fake_runner(store_writes=False)
    proc = plans.stems_runner(runner=runner)
    with pytest.raises(RuntimeError, match="roformer produced no instrumental"):
        await _drain(proc, _rspec(tmp_path, model="bs-roformer-1297"))


@pytest.mark.asyncio
async def test_a_roformer_no_instrumental_failure_is_classified_non_retryable(tmp_path):
    """#571: reaching Separate's "produced no instrumental" raise means the CLI exited 0 and its
    output-filename contract is wrong — deterministic for that engine build, so every retry re-runs the
    same 2h11m pass and fails identically. The raise must be non-retryable so the core stops after one
    pass. Asserts the classification (PermanentError IS-A RuntimeError); reds on base where the bare
    RuntimeError classifies retryable=True."""
    runner, _ = _roformer_fake_runner(store_writes=False)
    proc = plans.stems_runner(runner=runner)
    with pytest.raises(RuntimeError) as exc:  # PermanentError IS-A RuntimeError
        await _drain(proc, _rspec(tmp_path, model="bs-roformer-1297"))
    assert is_retryable(exc.value) is False


@pytest.mark.asyncio
async def test_a_roformer_cook_missing_vocals_is_best_effort_still_publishes_instrumental(tmp_path):
    """The vocals-LESS half of the discovery contract — the roformer analogue of demucs's
    test_missing_vocals_is_best_effort_still_publishes_instrumental (test_demucs.py). When
    bs-roformer-infer writes the instrumental but no vocals output, find_roformer_vocals returns None
    (roformer.py:131,136 — a real production state, exactly as find_roformer_instrumental does), so
    RoformerEngine.find_outputs maps the `vocals` key onto None and the publish step drops null stems.
    The cook must still complete best-effort and publish the load-bearing instrumental, with the vocals
    key simply ABSENT — not a None value. Without this, a roformer cook could silently drop its guiding
    track on the best-effort path and every worker test stayed green (the half that
    #333 left open). Mirrors the demucs sibling's `"vocals" not in stems` shape, NOT
    `stems["vocals"] is None`."""
    runner, _ = _roformer_fake_runner(write_vocals=False)  # instrumental written, vocals output absent
    proc = plans.stems_runner(runner=runner)  # no engine= override → real RoformerEngine from params
    events = await _drain(proc, _rspec(tmp_path, model="bs-roformer-1297"))

    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1, "the roformer cook must still complete best-effort"
    stems = completes[0].artifacts["stems"]
    # the load-bearing output is published
    assert stems["instrumental"].endswith("mr-instrumental.flac")
    assert Path(stems["instrumental"]).exists()
    # the guiding track is simply ABSENT (key dropped), never a None value
    assert "vocals" not in stems
