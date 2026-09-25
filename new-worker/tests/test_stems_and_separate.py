"""The stems flow and the separator adapters.

The argv tests carry most of the weight here, because the flags that matter are the ones whose absence
only shows up on a real 45-minute separation — `--two-stems`, and ffmpeg's `normalize=0`. Both have a
comment in the source explaining what breaks without them; these assert it.
"""

from __future__ import annotations

import pytest

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
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import AudioRef, JobRef
from encore_worker.workflows.stems import (
    SILENCE_FLOOR_DBFS,
    SilentInstrumental,
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

    async def publish_stems(self, job: JobRef, audio: AudioRef) -> str:
        self.calls.append("publish_stems")
        if self.publish_raises is not None:
            raise self.publish_raises
        return "derived/stems/m1-instrumental.flac"


async def test_a_good_separation_publishes() -> None:
    fake = Fake(peak=-3.0)
    outcome = await run_stems(JOB, fake)

    assert outcome.refused is False
    assert outcome.published.endswith(".flac")
    assert fake.calls == ["acquire_audio", "decode_to_wav", "separate", "probe_silence", "publish_stems"]


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
