"""The stems flow and the separator adapters.

The argv tests carry most of the weight here, because the flags that matter are the ones whose absence
only shows up on a real 45-minute separation — `--two-stems`, and ffmpeg's `normalize=0`. Both have a
comment in the source explaining what breaks without them; these assert it.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from encore_worker.adapters import separate as sep
from encore_worker.adapters.separate import (
    DEMUCS_MODELS,
    MlxDemucs,
    Stems,
    TorchDemucs,
    UnknownModel,
    decode_argv,
    demucs_argv,
    demucs_paths,
    instrumental_sources,
    mix_minus_argv,
    mlx_argv,
    mlx_stem_path,
    resolve_model,
)
from encore_worker.host.config import Config
from encore_worker.protocol import frames as f
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import AudioRef, JobRef, PublishedStems
from encore_worker.workflows.stems import (
    SILENCE_FLOOR_DBFS,
    SilentInstrumental,
    StemsOutcome,
    UnverifiedInstrumental,
    run_stems,
)

JOB = JobRef(job_id="j1", media_id="m1", media_dir="/media/m1", source_uri="https://x.test/v")


# ── model allowlist ──────────────────────────────────────────────────────────────────────────────


def test_an_unset_model_takes_the_default() -> None:
    assert resolve_model(None) == "htdemucs"
    assert resolve_model("") == "htdemucs"


def test_an_explicit_unknown_model_raises_rather_than_falling_back() -> None:
    """Falling back silently would separate with a different model than asked and report success — so
    the operator's setting would appear to work."""
    with pytest.raises(UnknownModel, match="unknown demucs model"):
        resolve_model("htdemucs-turbo")


def test_the_allowlist_is_not_bypassed_by_a_path() -> None:
    """The name reaches a subprocess, so it is an injection surface as well as a failure mode."""
    for hostile in ("../../etc/passwd", "htdemucs; rm -rf /", "/abs/path"):
        with pytest.raises(UnknownModel):
            resolve_model(hostile)


@pytest.mark.parametrize("model", DEMUCS_MODELS)
def test_every_allowlisted_model_resolves(model: str) -> None:
    assert resolve_model(model) == model


def test_six_source_models_sum_five_stems_not_three() -> None:
    """A 6s model summing only four would silently drop piano and guitar from the backing track —
    audible as a thin mix, not as an error."""
    assert instrumental_sources("htdemucs") == ("drums", "bass", "other")
    assert set(instrumental_sources("htdemucs_6s")) == {"drums", "bass", "other", "piano", "guitar"}


# ── torch demucs ─────────────────────────────────────────────────────────────────────────────────


def test_torch_demucs_asks_for_two_stems_only() -> None:
    """The whole reason this engine is cheaper than the mlx path: no mix-minus pass is needed."""
    argv = demucs_argv("/w/input.wav", "/w/out", "htdemucs_ft", device="cuda", jobs=4)
    assert "--two-stems=vocals" in argv
    assert ["-n", "htdemucs_ft"] == argv[argv.index("-n") : argv.index("-n") + 2]
    assert ["-d", "cuda"] == argv[argv.index("-d") : argv.index("-d") + 2]
    assert argv[-1] == "/w/input.wav"


def test_job_count_is_never_below_one() -> None:
    """A zero would make demucs use no workers and hang rather than run single-threaded."""
    assert "-j" in demucs_argv("/w/i.wav", "/w/o", jobs=0)
    argv = demucs_argv("/w/i.wav", "/w/o", jobs=0)
    assert argv[argv.index("-j") + 1] == "1"


def test_torch_output_paths_are_keyed_on_the_model() -> None:
    stems = demucs_paths("/w/out", "/w/input.wav", "htdemucs")
    assert stems.instrumental_path == "/w/out/htdemucs/input/no_vocals.wav"
    assert stems.vocals_path == "/w/out/htdemucs/input/vocals.wav"


# ── demucs-mlx ───────────────────────────────────────────────────────────────────────────────────


def test_mlx_argv_omits_the_flags_that_do_not_exist() -> None:
    """demucs-mlx has no --two-stems, no -d/--device and no --filename. Passing any of them fails."""
    argv = mlx_argv("/w/input.wav", "/w/out", "htdemucs", "demucs-mlx-9")
    assert argv[0] == "demucs-mlx-9"
    for absent in ("--two-stems=vocals", "-d", "--device", "--filename"):
        assert absent not in argv


def test_mlx_output_is_keyed_on_the_input_filename_not_the_model() -> None:
    """The one place its layout differs from what a model-keyed helper would guess."""
    assert mlx_stem_path("/w/out", "/w/input.wav", "vocals") == "/w/out/input/vocals.wav"


def test_the_mix_minus_pass_is_a_true_sum_not_an_average() -> None:
    """THE load-bearing flag. ffmpeg's amix averages by default, dividing by the input count — three
    stems would ship the instrumental at a third of its level, quiet enough to sound merely "turned
    down" rather than broken."""
    argv = mix_minus_argv("/w/out", "/w/input.wav", "htdemucs")
    assert "amix=inputs=3:normalize=0" in argv
    assert argv.count("-i") == 3, "one input per non-vocal stem"
    assert argv[-1] == "/w/out/input/no_vocals.wav"


def test_a_six_source_mix_minus_sums_five_inputs() -> None:
    argv = mix_minus_argv("/w/out", "/w/input.wav", "htdemucs_6s")
    assert "amix=inputs=5:normalize=0" in argv
    assert argv.count("-i") == 5


def test_decode_normalises_to_one_format() -> None:
    """So a variable-bitrate mp3 and an opus stream cannot produce a different stem layout per engine."""
    argv = decode_argv("/w/original.webm", "/w/input.wav")
    assert ["-ar", "44100"] == argv[argv.index("-ar") : argv.index("-ar") + 2]
    assert ["-ac", "2"] == argv[argv.index("-ac") : argv.index("-ac") + 2]
    assert "pcm_s16le" in argv


def test_engine_names_are_distinct_and_recorded() -> None:
    """`facts.engine` must say what RAN, so a box separating on the wrong engine is detectable."""
    assert TorchDemucs().name != MlxDemucs().name


# ── the stems flow ───────────────────────────────────────────────────────────────────────────────


class Fake:
    """A `SeparateSteps` with a scriptable peak level."""

    def __init__(self, *, peak: float | None = -3.0, publish_raises: Exception | None = None) -> None:
        self.peak = peak
        self.publish_raises = publish_raises
        self.calls: list[str] = []

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        self.calls.append("acquire_audio")
        return AudioRef(path="/media/m1/original.mp3", duration_sec=200.0)

    async def decode_to_wav(self, job: JobRef, audio: AudioRef) -> str:
        self.calls.append("decode_to_wav")
        return "/media/m1/work/j1/input.wav"

    async def separate(self, job: JobRef, input_wav: str) -> AudioRef:
        self.calls.append("separate")
        return AudioRef(
            path="/media/m1/work/j1/no_vocals.wav",
            duration_sec=200.0,
            vocals_path="/media/m1/work/j1/vocals.wav",
        )

    async def probe_silence(self, job: JobRef, audio: AudioRef) -> float | None:
        self.calls.append("probe_silence")
        return self.peak

    async def measure_profile(self, job: JobRef, audio: AudioRef) -> dict[str, object]:
        self.calls.append("measure_profile")
        return {"keyTonic": 9, "keyMode": "minor", "loudnessLufs": -12.0}

    async def publish_stems(self, job: JobRef, audio: AudioRef) -> PublishedStems:
        self.calls.append("publish_stems")
        if self.publish_raises is not None:
            raise self.publish_raises
        return PublishedStems(
            instrumental="derived/stems/m1-instrumental.flac",
            vocals="derived/stems/m1-vocals.flac",
            guide_mix="derived/stems/m1-guidemix.flac",
        )


async def test_a_good_separation_publishes() -> None:
    fake = Fake(peak=-3.0)
    outcome = await run_stems(JOB, fake)

    assert outcome.refused is False
    assert outcome.published is not None
    # Every stem reported, not just the instrumental: an unreported ref is a file core can neither serve
    # nor ever clean up.
    assert outcome.published.instrumental.endswith("-instrumental.flac")
    assert outcome.published.vocals == "derived/stems/m1-vocals.flac"
    assert outcome.published.guide_mix == "derived/stems/m1-guidemix.flac"
    assert fake.calls == [
        "acquire_audio",
        "decode_to_wav",
        "separate",
        "probe_silence",
        "measure_profile",
        "publish_stems",
    ]


async def test_a_silent_instrumental_is_refused_before_publication() -> None:
    """It looks like a successful separation and sounds like a broken song, so shipping it moves the
    failure from this log to a living room."""
    fake = Fake(peak=-120.0)
    with pytest.raises(SilentInstrumental, match="silence floor"):
        await run_stems(JOB, fake)
    assert "publish_stems" not in fake.calls


async def test_refusal_is_not_retryable() -> None:
    """The same input through the same engine produces the same silence."""
    assert SilentInstrumental.retryable is False


async def test_a_quiet_but_audible_mix_is_not_refused() -> None:
    """16-bit silence measures near -91 dBFS; the floor leaves dither headroom so a genuinely quiet
    passage still publishes."""
    fake = Fake(peak=SILENCE_FLOOR_DBFS + 1.0)
    assert (await run_stems(JOB, fake)).refused is False


async def test_exactly_at_the_floor_is_refused() -> None:
    with pytest.raises(SilentInstrumental):
        await run_stems(JOB, Fake(peak=SILENCE_FLOOR_DBFS))


async def test_a_lost_lease_at_publish_is_a_normal_outcome() -> None:
    fake = Fake(publish_raises=NotOurJob("reassigned to w2"))
    outcome = await run_stems(JOB, fake)

    assert outcome.refused is True
    assert "abandoned before publishing" in outcome.why
    assert outcome.audio is not None, "the work still happened, even though it was not published"


def test_stems_result_satisfies_the_separation_result_port() -> None:
    """Structural, so an engine returning its own record type still fits the port."""
    stems = Stems(instrumental_path="/i.wav", vocals_path="/v.wav", engine="demucs")
    assert stems.instrumental_path and stems.vocals_path


def test_an_engine_with_no_vocals_stem_reports_none() -> None:
    """Which makes alignment fall back to the mix — an explicit retry, not a silent degradation."""
    assert Stems(instrumental_path="/i.wav").vocals_path is None


# ── the unverified case ──────────────────────────────────────────────────────────────────────────


async def test_an_unmeasurable_instrumental_is_refused_not_published() -> None:
    """The hole this closes. The earlier code returned 0.0 for "could not measure" — the loudest possible
    reading — so an unverifiable separation published as though it had passed the guard."""
    fake = Fake(peak=None)
    with pytest.raises(UnverifiedInstrumental, match="cannot be confirmed audible"):
        await run_stems(JOB, fake)
    assert "publish_stems" not in fake.calls


async def test_unverified_and_silent_are_caught_separately() -> None:
    """A silent separation and an unmeasurable one are different diagnoses: the first is a separation
    problem, the second a broken ffmpeg or an unreadable output file. Collapsing them sends an operator
    to the wrong place.

    Asserted by CATCHING rather than by comparing the classes — mypy proves two distinct names are
    distinct, so an identity check would pass without exercising anything.
    """
    with pytest.raises(UnverifiedInstrumental):
        await run_stems(JOB, Fake(peak=None))
    with pytest.raises(SilentInstrumental):
        await run_stems(JOB, Fake(peak=-120.0))

    # Neither may be caught by a handler for the other.
    try:
        await run_stems(JOB, Fake(peak=None))
    except SilentInstrumental:  # pragma: no cover - would mean the two had merged
        pytest.fail("an unmeasured instrumental must not be reported as a silent one")
    except UnverifiedInstrumental:
        pass


def test_unverified_is_retryable_but_silence_is_not() -> None:
    """A measurement failure can be transient — a truncated write, a full disk, an OOM-killed ffmpeg —
    and the separation is already done, so re-measuring is cheap. Re-running a silent separation just
    produces the same silence."""
    assert UnverifiedInstrumental.retryable is True
    assert SilentInstrumental.retryable is False


# ── capability narrowing ─────────────────────────────────────────────────────────────────────────


def test_stems_is_not_advertised_without_ffmpeg() -> None:
    """`decode_to_wav` shells ffmpeg to normalise the input and the silence probe shells it to verify the
    output, so a box with demucs and no ffmpeg would accept separation work and fail every job at decode.
    Same defect the backend narrowing prevents, one dependency further out."""
    from encore_worker.host import hardware

    caps = hardware.capabilities(backend="torch", ytdlp="yt-dlp", ffmpeg="definitely-not-a-binary-xyz")
    assert not any(c.startswith("stems") for c in caps), f"stems must be withheld, got {sorted(caps)}"


def test_withholding_stems_does_not_withhold_unrelated_capabilities() -> None:
    """A box with no ffmpeg can still fetch and align; only separation depends on it."""
    from encore_worker.host import hardware

    without = hardware.capabilities(backend="torch", ytdlp="sh", ffmpeg="definitely-not-a-binary-xyz")
    assert "fetch:ytdlp" in without, "fetch does not need ffmpeg"


# ── the songProfile artifact ──────────────────────────────────────────────────────────────────────


async def test_the_profile_is_measured_before_publication() -> None:
    """ORDER IS THE CONSTRAINT, not a preference. Publication moves the scratch stems into the store and
    re-encodes them, so measuring afterwards would read files that have been consumed. This is the last
    point where the raw separator output still exists.
    """
    fake = Fake(peak=-6.0)
    await run_stems(JOB, fake)
    assert fake.calls.index("measure_profile") < fake.calls.index("publish_stems")
    assert fake.calls.index("separate") < fake.calls.index("measure_profile")


async def test_a_published_outcome_always_carries_a_profile() -> None:
    """Core's process gate reads a PRESENT profile as "the analysis step ran" and an ABSENT one as "still
    processing" — so omitting it leaves core waiting forever for a step it believes already happened, and the
    song is both permanently unsingable and never reprocessed. Present-with-null-fields is the correct
    "measured, unknown" answer; absent is a different and much worse claim."""
    fake = Fake(peak=-6.0)
    outcome = await run_stems(JOB, fake)
    assert outcome.published is not None
    assert outcome.profile is not None


async def test_the_profile_survives_a_lost_lease() -> None:
    """The measurement already happened, and it describes the AUDIO rather than the ownership. Dropping it
    because the lease expired would throw away work that is still true."""
    fake = Fake(peak=-6.0, publish_raises=NotOurJob("reassigned"))
    outcome = await run_stems(JOB, fake)
    assert outcome.refused
    assert outcome.profile is not None


async def test_a_refused_silent_instrumental_never_reaches_the_profile() -> None:
    """Silence is refused BEFORE measurement: there is nothing to characterise, and the job publishes
    nothing, so spending a multi-minute numpy pass on it is pure waste."""
    fake = Fake(peak=-120.0)
    with pytest.raises(SilentInstrumental):
        await run_stems(JOB, fake)
    assert "measure_profile" not in fake.calls


# ── roformer: the upgrade engine ──────────────────────────────────────────────────────────────────


def test_a_known_roformer_token_resolves_to_a_registry_slug() -> None:
    assert sep.resolve_roformer_slug("bs-roformer-1297").startswith("roformer-model-")


def test_an_unknown_roformer_token_raises_rather_than_defaulting() -> None:
    """Silently separating with the default would publish a backing track the operator did not choose, and
    it would be indistinguishable from the one they asked for."""
    with pytest.raises(sep.UnknownModel, match="unknown roformer model"):
        sep.resolve_roformer_slug("bs-roformer-9999")


def test_an_absent_roformer_token_takes_the_default() -> None:
    assert sep.resolve_roformer_slug(None) == sep.ROFORMER_MODELS[sep.DEFAULT_ROFORMER_MODEL]


def test_roformer_argv_separates_a_folder_not_a_file() -> None:
    """`--input_folder` is a directory and every WAV inside it is separated — which is why the caller stages
    the decoded input alone, or a second job's scratch would be separated too."""
    argv = sep.roformer_argv("/in", "/out", "slug-x")
    assert argv[argv.index("--input_folder") + 1] == "/in"
    assert argv[argv.index("--store_dir") + 1] == "/out"
    assert argv[argv.index("--model") + 1] == "slug-x"


def test_roformer_argv_omits_device_when_unset() -> None:
    """The CLI's own `auto` is better than a guess from here: it sees the box it runs on."""
    assert "--device" not in sep.roformer_argv("/in", "/out", "s")
    assert sep.roformer_argv("/in", "/out", "s", device="cuda")[-1] == "cuda"


INSTRUMENTAL_SLUG = "roformer-model-bs-roformer-instrumental-resurrection-by-unwa"


def test_stem_discovery_uses_the_MEASURED_role_of_each_file(tmp_path: Path) -> None:
    """THE bug a real run found, and the dangerous one: discovery uses each file's MEASURED role.

    Measured on a chords-only control (no vocals in the input, so the instrumental must hold everything):
    `_other` carried 99.1% of the signal and `_instrumental` 2.4% — the filenames are INVERTED for this
    model. The ported code looked for `_(Instrumental)_<slug>`, which this package never writes, so
    discovery found nothing, which is the SAFE failure; had it matched, the worker would have published the
    VOCALS as the backing track and the silence probe would have waved it through."""
    store = tmp_path / "out"
    store.mkdir()
    (store / "song_instrumental.wav").write_bytes(b"vocals-really")
    (store / "song_other.wav").write_bytes(b"backing-track-really")

    assert sep.find_roformer_instrumental(str(store), INSTRUMENTAL_SLUG) == str(store / "song_other.wav")
    assert sep.find_roformer_vocals(str(store), INSTRUMENTAL_SLUG) == str(store / "song_instrumental.wav")


def test_an_unmeasured_slug_finds_nothing_rather_than_guessing() -> None:
    """A model whose stem roles have not been measured must fail in discovery, not assume an order. Guessing
    wrong here publishes vocals as the master — a failure audible only in the room."""
    assert sep.roformer_stem_roles("roformer-model-bs-roformer-vocals-by-gabox") == ("", "")


def test_an_unmeasured_slug_refuses_even_with_files_present(tmp_path: Path) -> None:
    store = tmp_path / "out"
    store.mkdir()
    (store / "song_instrumental.wav").write_bytes(b"x")
    (store / "song_other.wav").write_bytes(b"y")
    assert sep.find_roformer_instrumental(str(store), "roformer-model-bs-roformer-de-reverb") is None


def test_the_suffix_match_is_anchored_at_the_end(tmp_path: Path) -> None:
    """`_instrumental` and `_other` both occur inside other candidate names, so a substring test would cross
    the two roles — which is the same class of mistake as the original bug."""
    store = tmp_path / "out"
    store.mkdir()
    (store / "song_other_notes.wav").write_bytes(b"decoy")
    (store / "song_other.wav").write_bytes(b"real")
    assert sep.find_roformer_instrumental(str(store), INSTRUMENTAL_SLUG) == str(store / "song_other.wav")


def test_stem_discovery_is_none_for_a_missing_directory() -> None:
    assert sep.find_roformer_instrumental("/nope/not/here", INSTRUMENTAL_SLUG) is None


def test_every_roformer_slug_we_map_to_is_a_real_registry_slug() -> None:
    """Pure cross-check: our token map must only name slugs the package actually carries.

    A shape assertion ("looks like a slug") is what let a bad slug ship in the old worker, which is why the
    registry list is checked in rather than trusted.
    """
    assert set(sep.ROFORMER_MODELS.values()) <= sep.ROFORMER_REGISTRY_SLUGS


def test_the_checked_in_registry_matches_the_installed_package() -> None:
    """Verified against the INSTALLED `bs_models.json` when bs-roformer-infer is present, so the checked-in
    list cannot quietly go stale as the package updates.

    Skipped rather than faked when absent — a test that silently asserts nothing is worse than one that says
    why it did not run. Note the nesting: entries live under a `"models"` key, and reading the top level makes
    every slug look missing, which is exactly the mistake this test would have caught.
    """
    import importlib.util
    import json

    spec = importlib.util.find_spec("bs_roformer")
    if spec is None or not spec.submodule_search_locations:
        pytest.skip("bs-roformer-infer is not installed, so there is no registry to verify against")
    path = Path(spec.submodule_search_locations[0]) / "data" / "bs_models.json"
    if not path.is_file():
        pytest.skip(f"the installed package carries no registry at {path}")

    installed = set(json.loads(path.read_text())["models"])
    assert sep.ROFORMER_REGISTRY_SLUGS == installed, (
        "the checked-in slug list has drifted from the installed package; "
        f"missing={sorted(installed - sep.ROFORMER_REGISTRY_SLUGS)} "
        f"stale={sorted(sep.ROFORMER_REGISTRY_SLUGS - installed)}"
    )


def test_the_default_roformer_model_is_the_two_stem_instrumental() -> None:
    """The default must target the INSTRUMENTAL, not be a multi-stem checkpoint whose instrumental has to be
    summed from three sources — and not a `vocals` model whose instrumental is merely the leftover. What plays
    in the room should be the modelled output.
    """
    slug = sep.ROFORMER_MODELS[sep.DEFAULT_ROFORMER_MODEL]
    assert sep.ROFORMER_SLUG_CATEGORY[slug] == "instrumental"


def test_the_previous_multistem_mapping_still_resolves() -> None:
    """Kept so a historical `job_attempts.model` row does not raise `UnknownModel` when an operator opens an
    old audit page. History has to stay readable after a repoint."""
    assert sep.ROFORMER_SLUG_CATEGORY[sep.ROFORMER_MODELS["bs-roformer-multistem"]] == "multi-stem"


# ── the stems completion frame ───────────────────────────────────────────────────────────────────


def _completion(outcome: StemsOutcome) -> object:
    from encore_worker.__main__ import _stems_completion  # noqa: PLC0415

    cfg = Config(core_url="ws://core.test/w", worker_id="w1", concurrency=1, version="9")
    return _stems_completion(JOB, cfg, outcome, TorchDemucs())


def test_a_refused_publish_is_a_retryable_failure_not_a_completion() -> None:
    """A `job:complete` with nothing published made core mark the song ready over a file never written."""
    frame = _completion(StemsOutcome(published=None, why="abandoned before publishing: revoked"))
    assert isinstance(frame, f.Failed)
    assert frame.retryable is True
    assert "abandoned" in frame.error


def test_the_completion_reports_the_engine_and_model_that_made_the_stems() -> None:
    """A `stems-upgrade` builds its own separator per job; the startup one (demucs here) is not what ran."""
    published = PublishedStems(
        instrumental="derived/stems/m1-instrumental.flac", engine="roformer", model="bs-roformer-1297"
    )
    frame = _completion(StemsOutcome(published=published, why="ok", profile={}))
    assert isinstance(frame, f.Complete)
    assert frame.facts is not None
    assert (frame.facts["engine"], frame.facts["model"]) == ("roformer", "bs-roformer-1297")


def test_each_separator_names_the_model_it_runs() -> None:
    assert TorchDemucs(model="htdemucs_ft").model == "htdemucs_ft"
    assert MlxDemucs().model == "htdemucs"
    assert sep.Roformer().model == sep.DEFAULT_ROFORMER_MODEL


def test_a_record_checkpointed_before_engine_and_model_existed_still_completes() -> None:
    """DBOS unpickles an old `PublishedStems` without the new slots; reading them must not raise."""
    stale = object.__new__(PublishedStems)
    object.__setattr__(stale, "instrumental", "derived/stems/m1-instrumental.flac")
    object.__setattr__(stale, "vocals", None)
    object.__setattr__(stale, "guide_mix", None)
    frame = _completion(StemsOutcome(published=stale, why="ok", profile={}))
    assert isinstance(frame, f.Complete)
    assert frame.facts is not None
    assert frame.facts["engine"] == "demucs"  # the startup fallback
    assert "model" not in frame.facts


async def test_an_abandoned_align_is_a_retryable_failure_not_a_no_lyrics_completion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sent as `job:complete`, core recorded "found no lyrics" for a job whose publish was refused."""
    from encore_worker import __main__ as main  # noqa: PLC0415
    from encore_worker.steps.records import AlignOutcome  # noqa: PLC0415
    from encore_worker.workflows import durable  # noqa: PLC0415

    async def abandoned(job: JobRef) -> AlignOutcome:
        return AlignOutcome(published=None, why="abandoned before publishing: revoked", abandoned=True)

    monkeypatch.setattr(durable, "align", abandoned)
    cfg = Config(core_url="ws://core.test/w", worker_id="w1", concurrency=1, version="9")
    assign = f.Assign(job_id="j1", media_id="m1", action="align")
    frame = await main._dispatch(assign, JOB, cfg, None, None, None, None)  # type: ignore[arg-type]
    assert isinstance(frame, f.Failed)
    assert frame.retryable is True


async def test_a_genuine_no_lyrics_align_still_completes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only an ownership refusal is a failure: "found no lyrics" is a real outcome core must hear."""
    from encore_worker import __main__ as main  # noqa: PLC0415
    from encore_worker.steps.records import AlignOutcome  # noqa: PLC0415
    from encore_worker.workflows import durable  # noqa: PLC0415

    async def nothing_found(job: JobRef) -> AlignOutcome:
        return AlignOutcome(published=None, why="no text cleared the gates")

    monkeypatch.setattr(durable, "align", nothing_found)
    cfg = Config(core_url="ws://core.test/w", worker_id="w1", concurrency=1, version="9")
    assign = f.Assign(job_id="j1", media_id="m1", action="align")
    client = SimpleNamespace(device=None)
    frame = await main._dispatch(assign, JOB, cfg, None, None, client, None)  # type: ignore[arg-type]
    assert isinstance(frame, f.Complete)
    assert frame.media_uri == ""
