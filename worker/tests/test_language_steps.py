"""The language reaches the MODEL (review M8 / §3 item 9, W7), through the real steps.

`tests/test_language.py` pins the decision; this pins the PLUMBING, which is the half review M8 actually
found: the decision existed in `steps.api.language_of` all along and nothing ever gave it a value, so every
job aligned as `en`. Each test here is one of the four places that value now comes from, plus the two places
it is consumed.

THE CONSUMPTION SPLIT IS THE EASIEST THING TO GET WRONG and so has its own tests: `aligner.emissions` /
`aligner.align` get the BUNDLE's language (`language.model_language`), and the published document, the
syllabifier and the trail get the TEXT's. A single `req.language` feeding both is how a German sheet would be
published as English, or a French one syllabified by the English hyphenator while a French model timed it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest

from encore_worker.adapters import ports
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.host.config import Config
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.api import language_of
from encore_worker.steps.records import TIMING_LINE, AudioRef, JobRef, TextRef, TimeRequest

#: A Korean sheet: the script that routes whatever anyone declared, and review M8's own s12 shape.
KOREAN = ("사랑해 사랑해 사랑해", "나는 바람이야 바람", "다시 춤을 추는 너를 봐")
#: A French sheet: Latin script, so it must NOT move off the measured default bundle.
FRENCH = ("je suis le vent qui souffle", "dans la nuit tu me vois", "danser encore une fois")


class Reporter:
    """Records every `job:state`, which is where a routing substitution has to be visible."""

    def __init__(self) -> None:
        self.states: list[tuple[str, str]] = []
        self.reasons: list[str] = []

    async def progress(self, job_id: str, stage: Stage, pct: int) -> None:
        pass

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        self.states.append((state, verdict))
        self.reasons.append(why)

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        return True

    def explain_ownership(self, job_id: str) -> str:
        return ""


class Captions:
    """A caption source whose track is in `lines`, with no language attribute of its own — which is the point:
    yt-dlp names the TRACK, and a machine-TRANSLATED track is published under the target language while
    carrying the source's words."""

    def __init__(self, lines: Sequence[str]) -> None:
        self.lines = list(lines)

    def fetch(self, source_uri: str, out_dir: str, *, automatic: bool) -> Sequence[Segment]:
        return tuple({"start": float(i), "end": float(i) + 2.0, "text": t} for i, t in enumerate(self.lines))


class Provider:
    name = "lrclib"

    def __init__(self, lines: Sequence[str]) -> None:
        self.lines = list(lines)

    def fetch(self, *, artist: str, track: str, duration_sec: float) -> Sequence[Segment]:
        return tuple({"start": float(i), "end": float(i) + 2.0, "text": t} for i, t in enumerate(self.lines))


class Heard:
    """A transcriber that reports what it heard AND in which language, as whisperx does."""

    def __init__(self, lines: Sequence[str], language: str | None) -> None:
        self.lines = list(lines)
        self.language = language

    def transcribe(self, audio_path: str, *, language: str | None = None) -> ports.Transcribed:
        return ports.Transcribed(
            segments=tuple(
                {"start": float(i), "end": float(i) + 2.0, "text": t} for i, t in enumerate(self.lines)
            ),
            language=self.language,
        )


class RecordingAligner:
    """An `Aligner` with an `emissions` method, recording the LANGUAGE each call was made with."""

    def __init__(self) -> None:
        self.emission_languages: list[tuple[str, str]] = []
        self.align_languages: list[str] = []

    def emissions(self, audio_path: str, language: str) -> object:
        self.emission_languages.append((Path(audio_path).name, language))
        raise RuntimeError("stop here: the language is what this test reads")

    def align(self, search: Sequence[Segment], audio_path: str, language: str) -> Sequence[Segment]:
        self.align_languages.append(language)
        raise RuntimeError("stop here: the language is what this test reads")


class WindowedAligner:
    """An aligner with NO `emissions` — the windowed engine, which is the other consumer of the language."""

    def __init__(self) -> None:
        self.languages: list[str] = []

    def align(self, search: Sequence[Segment], audio_path: str, language: str) -> Sequence[Segment]:
        self.languages.append(language)
        raise RuntimeError("stop here")


def impl(
    tmp: Path, *, experiments: frozenset[str] = frozenset(), **adapters: object
) -> tuple[AlignStepsImpl, Reporter]:
    out = Reporter()
    steps = AlignStepsImpl(
        config=Config(asr_model="base", align_experiments=experiments),
        adapters=Adapters(**adapters),  # type: ignore[arg-type]
        reporter=out,
    )
    return steps, out


def job(tmp: Path, **params: object) -> JobRef:
    return JobRef(
        job_id="j1", media_id="m1", media_dir=str(tmp), source_uri="https://x.test/v", params=params
    )


def audio(tmp: Path) -> AudioRef:
    return AudioRef(path=str(tmp / "mix.mp3"), duration_sec=120.0, vocals_path=str(tmp / "vocals.wav"))


def request(tmp: Path, *, language: str, knobs: frozenset[Knob] = frozenset()) -> TimeRequest:
    text = TextRef(
        tier=Tier.CANDIDATE,
        label="lrclib",
        segments=tuple({"start": float(i), "end": float(i) + 2.0, "text": t} for i, t in enumerate(FRENCH)),
        language=language,
        timing=TIMING_LINE,
    )
    return TimeRequest(job=job(tmp), text=text, audio=audio(tmp), language=language, knobs=knobs)


# ── where the value comes from ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("automatic", [False, True])
async def test_a_caption_track_is_detected_from_its_words_not_from_its_track_name(
    tmp_path: Path, automatic: bool
) -> None:
    steps, _out = impl(tmp_path, captions=Captions(KOREAN))
    got = await steps.fetch_captions(job(tmp_path, language="en"), automatic=automatic)
    assert got is not None
    assert got.language == "ko", "the Hangul in the cues outranks the job's declared 'en'"


async def test_every_provider_sheet_gets_its_own_language(tmp_path: Path) -> None:
    """Two providers can answer one song in different languages — a translation is a common lrcmux upstream
    answer — and each must be timed by the bundle its OWN characters need."""
    steps, _out = impl(
        tmp_path,
        providers=(Provider(KOREAN), Provider(FRENCH)),
        # A stub detector, so the Latin sheet's answer is the step's plumbing rather than lingua's accuracy
        # (the real detector has its own test). It never sees the Korean sheet: the SCRIPT decides that one.
        detector=lambda text: "fr" if "vent" in text else None,
    )
    found = await steps.fetch_provider_lyrics(job(tmp_path, artist="a", track="t"), audio(tmp_path))
    assert [text.language for text in found] == ["ko", "fr"]


async def test_whispers_detected_language_is_carried_rather_than_discarded(tmp_path: Path) -> None:
    """Review M8's own words. `ports.Transcribed.language` exists for exactly this line; before W7 the step
    wrote `job.param_str("language")` here, i.e. almost always None."""
    steps, _out = impl(tmp_path, transcriber=Heard(FRENCH, "fr"))
    got = await steps.transcribe(job(tmp_path), audio(tmp_path), on_vocals=False)
    assert got is not None and got.language == "fr"
    assert got.tier is Tier.ASR


async def test_a_transcript_in_a_script_outranks_what_whisper_says_it_heard(tmp_path: Path) -> None:
    """whisper mis-reporting the language of a song it transcribed in Hangul is the case the script histogram
    is the PRIMARY signal for: the characters have to be in the model's vocabulary, whatever was heard."""
    steps, out = impl(tmp_path, transcriber=Heard(KOREAN, "en"))
    got = await steps.transcribe(job(tmp_path), audio(tmp_path), on_vocals=False)
    assert got is not None and got.language == "ko"
    assert ("asr-language", "language") in out.states, "a disagreement is on the trail"
    assert any("whisper heard 'en'" in why and "'ko'" in why for why in out.reasons)


async def test_a_transcriber_that_reports_no_language_leaves_the_script_to_decide(tmp_path: Path) -> None:
    steps, out = impl(tmp_path, transcriber=Heard(FRENCH, None))
    got = await steps.transcribe(job(tmp_path), audio(tmp_path), on_vocals=False)
    assert got is not None and got.language in {"fr", "en"}
    assert ("asr-language", "language") not in out.states, "nothing disagreed, so nothing is noted"


async def test_the_job_param_is_still_an_override_for_a_latin_sheet(tmp_path: Path) -> None:
    """An operator's room-wide `language` was already read by `steps.api.language_of`; it now reaches the text
    too, which is what makes it an override of the English default rather than a value nothing consumes."""
    steps, _out = impl(tmp_path, captions=Captions(FRENCH))
    got = await steps.fetch_captions(job(tmp_path, language="fr"), automatic=False)
    assert got is not None and got.language == "fr"
    assert language_of(job(tmp_path, language="de"), got) == "fr", "the text's own wins over the job's"


# ── where the value is consumed ───────────────────────────────────────────────────────────────────


async def test_latin_script_asks_the_emitter_for_the_default_bundles_language(tmp_path: Path) -> None:
    """THE RULE THAT PROTECTS EVERY PUBLISHED NUMBER: a French sheet is still timed by the English bundle, so
    a run on the corpus loads what it always loaded."""
    aligner = RecordingAligner()
    steps, out = impl(tmp_path, aligner=aligner)
    await steps.time_text(request(tmp_path, language="fr"))
    assert aligner.emission_languages == [("vocals.wav", "en")]
    assert ("align-language", "bundle") in out.states, "the substitution is never silent"
    assert any("text language 'fr'" in why and "'en' bundle" in why for why in out.reasons)


async def test_a_non_latin_script_really_reaches_its_own_bundle(tmp_path: Path) -> None:
    """Which is what arms review M9: `whisperx.load_align_model(language_code='ko')` is an HF checkpoint whose
    `[PAD]` is at 1204, and the hard-coded blank was dormant only while this never happened."""
    aligner = RecordingAligner()
    steps, out = impl(tmp_path, aligner=aligner)
    await steps.time_text(request(tmp_path, language="ko"))
    assert aligner.emission_languages == [("vocals.wav", "ko")]
    assert ("align-language", "bundle") not in out.states, "the bundle IS the text's, so there is no note"


async def test_the_mix_witness_asks_for_the_mixs_bundle_not_the_targets(tmp_path: Path) -> None:
    """R4's witness is the mix by definition, and the mix is the only target `lang-route-mix` can move —
    so the two resolutions are taken separately even though they agree under the default."""
    aligner = RecordingAligner()
    steps, _out = impl(tmp_path, aligner=aligner, experiments=frozenset({"lang-route-mix"}))
    await steps.time_text(request(tmp_path, language="fr", knobs=frozenset({Knob.ALIGN_ON_MIX})))
    assert aligner.emission_languages == [("mix.mp3", "fr")], "ALIGN_ON_MIX makes the target the mix"


async def test_the_arm_does_not_move_the_stem(tmp_path: Path) -> None:
    aligner = RecordingAligner()
    steps, _out = impl(tmp_path, aligner=aligner, experiments=frozenset({"lang-route-mix"}))
    await steps.time_text(request(tmp_path, language="fr"))
    assert aligner.emission_languages == [("vocals.wav", "en")]


async def test_the_line_sync_rung_always_reads_the_stems_bundle(tmp_path: Path) -> None:
    """Every reading of that rung is the stem's, and its decode-agreement share is calibrated per bundle
    (`lexical.line_sync_share`) — so routing it would gate it on a share nobody fitted."""
    aligner = RecordingAligner()
    steps, _out = impl(tmp_path, aligner=aligner, experiments=frozenset({"lang-route-mix"}))
    # `_line_sync_evidence` directly, not through `time_text`: the rung reads an envelope over the real audio
    # BEFORE it emits, and this test is about the language it asks for, not about having a decodable file.
    await steps._line_sync_evidence(  # noqa: SLF001 - the call under test is a private one
        request(tmp_path, language="fr", knobs=frozenset({Knob.ALIGN_ON_MIX, Knob.LINE_SYNC}))
    )
    assert aligner.emission_languages == [("vocals.wav", "en")], (
        "the stem's target AND the stem's bundle, even with ALIGN_ON_MIX set and the arm on"
    )


async def test_the_windowed_engine_routes_the_same_way(tmp_path: Path) -> None:
    """It is reached only by an aligner that cannot produce emissions at all, and it must not be the one path
    that hands whisperx a language the policy did not choose."""
    aligner = WindowedAligner()
    steps, _out = impl(tmp_path, aligner=aligner)
    await steps.time_text(request(tmp_path, language="ko"))
    assert aligner.languages == ["ko"]

    latin = WindowedAligner()
    steps, _out = impl(tmp_path, aligner=latin)
    await steps.time_text(request(tmp_path, language="de"))
    assert latin.languages == ["en"], "Latin script stays on the measured default here too"


def test_the_published_document_carries_the_texts_language_and_not_the_bundles() -> None:
    """Core reads `language` off the document (`contract/lyrics/lyrics.ts`), so a German sheet timed by the
    English bundle must still publish as German — which is also what W8's CJK line joining will read."""
    from encore_worker.steps.align_steps import _line_doc, _word_doc

    assert _word_doc(({"text": "a", "start": 0.0, "end": 1.0, "words": ()},), "de")["language"] == "de"
    assert _line_doc(({"text": "a", "start": 0.0, "end": 1.0},), "de")["language"] == "de"


# ── a routed bundle has no calibration, and that must be loud rather than borrowed ─────────────────


class Uncalibrated:
    """`Emissions`' duck type naming a bundle `lexical.CALIBRATED` has no row for — every per-language model
    whisperx tables, which is what W7 makes reachable."""

    model = "VOXPOPULI_ASR_BASE_10K_DE"
    dictionary: Mapping[str, int] = {"-": 0, "a": 1}
    blank_id = 0
    specials: Mapping[str, int] = {"-": 0}
    frame_sec = 0.02
    log_probs = None


def test_a_routed_bundle_is_not_judged_by_another_bundles_thresholds() -> None:
    """The review's high-severity W3 finding, which W7 is the wave that could re-introduce: an uncalibrated
    matrix answers None, so nothing in nats per letter is read off it, and the sentence on the trail names the
    bundle. The rung's SHARE survives (a fraction of lines within a tolerance in seconds) and the placement
    margin does not (a sum of log-probabilities) — `lexical`'s own asymmetry, re-asserted on the bundles W7
    makes reachable rather than on a hypothetical."""
    from encore_worker.domain.lyrics import lexical

    matrix = Uncalibrated()
    assert lexical.calibration(matrix) is None
    assert lexical.line_sync_share(None) == lexical.LINE_SYNC_SHARE_UNCALIBRATED
    assert lexical.margin_floor(None) is None
    why = lexical.uncalibrated(Uncalibrated.model)
    assert "VOXPOPULI_ASR_BASE_10K_DE" in why and "lift_gate.py --model" in why


async def test_an_operator_naming_an_uncalibrated_bundle_still_fails_before_any_job(
    tmp_path: Path,
) -> None:
    """The LOUD half, unchanged by W7 and re-asserted because W7 is what makes uncalibrated bundles ordinary:
    a bundle an operator TYPED is refused at the composition root, where a bundle a LANGUAGE chose is merely
    ungated. The distinction is the whole of `__main__.align_model_for`."""
    from encore_worker.__main__ import align_model_for
    from encore_worker.host.config import ConfigError

    with pytest.raises(ConfigError) as refused:
        align_model_for(Config(align_model="VOXPOPULI_ASR_BASE_10K_DE"), "cpu")
    assert "ENCORE_ALIGN_MODEL" in str(refused.value) and "lift_gate.py" in str(refused.value)
