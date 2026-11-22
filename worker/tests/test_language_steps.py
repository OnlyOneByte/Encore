"""The language reaches the MODEL (review §3 item 9), through the real steps.

`tests/test_language.py` pins the decision; this pins the PLUMBING, which is the half that was actually
broken: the decision existed in `steps.api.language_of` all along and nothing ever gave it a value, so every
job aligned as `en`. Each test here is one of the four places that value now comes from, plus the two places
it is consumed.

THE CONSUMPTION SPLIT IS THE EASIEST THING TO GET WRONG and so has its own tests: `aligner.emissions` /
`aligner.align` get the BUNDLE's language (`language.model_language`), and the published document, the
syllabifier and the trail get the TEXT's. A single `req.language` feeding both is how a German sheet would be
published as English, or a French one syllabified by the English hyphenator while a French model timed it.
"""

from __future__ import annotations

import json
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

#: A Korean sheet: the script that routes whatever anyone declared, and the s12 shape.
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


def audio(tmp: Path, *, stem: bool = True) -> AudioRef:
    """The job's audio. `stem=False` is a STEMLESS song — separation refused to publish, or there is no vocals
    file — where `align_target` resolves to the mix from the first attempt and `Knob.ALIGN_ON_MIX` is never
    offered (`policy`), which is the case the resolved-target routing is about."""
    return AudioRef(
        path=str(tmp / "mix.mp3"),
        duration_sec=120.0,
        vocals_path=str(tmp / "vocals.wav") if stem else None,
    )


def request(
    tmp: Path, *, language: str, knobs: frozenset[Knob] = frozenset(), stem: bool = True
) -> TimeRequest:
    text = TextRef(
        tier=Tier.CANDIDATE,
        label="lrclib",
        segments=tuple({"start": float(i), "end": float(i) + 2.0, "text": t} for i, t in enumerate(FRENCH)),
        language=language,
        timing=TIMING_LINE,
    )
    return TimeRequest(job=job(tmp), text=text, audio=audio(tmp, stem=stem), language=language, knobs=knobs)


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
    """`ports.Transcribed.language` exists for exactly this line; before routing, the step
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


async def test_a_stored_pins_own_language_wins_over_re_detecting_it(tmp_path: Path) -> None:
    """The fourth acquiring step, and the one precedence nothing pinned: mutating
    `fetch_pinned_text`'s `stored_language or self._detect(...)` to the detection alone killed no test.

    It matters because the two can DISAGREE on the same bytes: the candidate being re-timed was published by
    an earlier job whose Adapters had lingua installed (`__main__.build_adapters`), and this box's may not —
    so re-detecting would re-time a French sheet on another language than the one the person chose, with no
    note anywhere saying it had changed. The document's own value is a record of a decision, not a guess."""
    stored = tmp_path / "derived" / "lyrics"
    stored.mkdir(parents=True)
    ref = "derived/lyrics/m1-lrclib-line.json"
    (tmp_path / ref).write_text(
        json.dumps(
            {
                "language": "fr",
                "lines": [
                    {"text": line, "start": float(i), "end": float(i) + 2.0} for i, line in enumerate(FRENCH)
                ],
            }
        ),
        encoding="utf-8",
    )
    steps, _out = impl(tmp_path)  # no detector on this box, so detection would answer the `en` default
    got = await steps.fetch_pinned_text(job(tmp_path, pinnedRef=ref))
    assert got is not None and got.language == "fr", "the stored document's own language, not a re-detection"
    assert got.label == "lrclib", "and its provenance, read back off the ref"


async def test_a_paste_has_no_stored_language_so_it_is_detected(tmp_path: Path) -> None:
    """The other half of the same line, which is why the fallback is there at all: a PASTE is bytes a person
    just typed, with no document behind it — `_stored_lines` is never called — so the script decides. Pasting
    a Hangul sheet into an English room is the s12 shape."""
    steps, _out = impl(tmp_path)
    got = await steps.fetch_pinned_text(job(tmp_path, pinnedText="\n".join(KOREAN)))
    assert got is not None and got.language == "ko"


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
    """Which arms the blank-id bug: `whisperx.load_align_model(language_code='ko')` is an HF checkpoint whose
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


async def test_a_stemless_song_is_routed_because_the_mix_is_what_it_decodes(tmp_path: Path) -> None:
    """The flag is a fact about the RESOLVED TARGET, not about the knob.
    `req.on_mix` is `Knob.ALIGN_ON_MIX in knobs`, and since H2 the GLOBAL engine is offered only
    `Knob.LINE_SYNC` — so with the shipped aligner that knob is never set in production, while a stemless
    song's FIRST attempt already decodes the mix. Asking the knob made `lang-route-mix` inert on the only
    production path that globally decodes the mix: the arm was set, the mix was being timed, and the step
    still loaded the English bundle."""
    aligner = RecordingAligner()
    steps, _out = impl(tmp_path, aligner=aligner, experiments=frozenset({"lang-route-mix"}))
    await steps.time_text(request(tmp_path, language="fr", stem=False))
    assert aligner.emission_languages == [("mix.mp3", "fr")]


async def test_a_stemless_song_keeps_the_default_bundle_without_the_arm(tmp_path: Path) -> None:
    """The DEFAULT is unmoved by that fix — `model_language` reads `on_mix` only under `route_latin`, so the
    corpus's every recorded row still loads the bundle it loaded — and the only visible change is the trail,
    which now names the file the job actually read."""
    aligner = RecordingAligner()
    steps, out = impl(tmp_path, aligner=aligner)
    await steps.time_text(request(tmp_path, language="fr", stem=False))
    assert aligner.emission_languages == [("mix.mp3", "en")]
    assert any("bundle on the mix" in why for why in out.reasons), (
        "the note used to say 'on the stem' about a song that has none"
    )


async def test_the_windowed_engine_reads_the_resolved_target_too(tmp_path: Path) -> None:
    """The second consumer of the bundle language, fixed at the same seam (`AudioRef.targets_mix`) so the two
    engines cannot disagree about which file they are on.

    Under `h3-ungated-words` because this engine's ROUTED word document is closed too (a bundle with no
    calibration row has no wrong-text gate, and this engine reads no matrix to measure one on): the arm is
    what still lets a routed bundle time words, so it is what can still show which language it asked for.
    """
    aligner = WindowedAligner()
    steps, _out = impl(
        tmp_path, aligner=aligner, experiments=frozenset({"lang-route-mix", "h3-ungated-words"})
    )
    await steps.time_text(request(tmp_path, language="fr", stem=False))
    assert aligner.languages == ["fr"]


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
    """It is reached only by an aligner that cannot produce emissions at all, and where it may time words it
    must not be the one path that hands whisperx a language the policy did not choose.

    So the routed half needs the control arm: this engine measures no lift on any bundle, so a routed
    one declines rather than publishing words (`tests/test_nonlatin_lane.py`), and the bundle CHOICE is then
    only observable with the arm on. The Latin default, which is what this test was written to pin, is
    unmoved.
    """
    routed = WindowedAligner()
    steps, out = impl(tmp_path, aligner=routed)
    await steps.time_text(request(tmp_path, language="ko"))
    assert routed.languages == [], "a bundle with no calibration row times no words here either"
    assert any("may time LINES but not WORDS" in why for why in out.reasons)

    arm = WindowedAligner()
    steps, _out = impl(tmp_path, aligner=arm, experiments=frozenset({"h3-ungated-words"}))
    await steps.time_text(request(tmp_path, language="ko"))
    assert arm.languages == ["ko"], "the routing itself is unchanged"

    latin = WindowedAligner()
    steps, _out = impl(tmp_path, aligner=latin)
    await steps.time_text(request(tmp_path, language="de"))
    assert latin.languages == ["en"], "Latin script stays on the measured default here too"


def test_the_published_document_carries_the_texts_language_and_not_the_bundles() -> None:
    """Core reads `language` off the document (`contract/lyrics/lyrics.ts`), so a German sheet timed by the
    English bundle must still publish as German — which is also what CJK line joining will read."""
    from encore_worker.steps.align_lines import _line_doc, _word_doc

    assert _word_doc(({"text": "a", "start": 0.0, "end": 1.0, "words": ()},), "de")["language"] == "de"
    assert _line_doc(({"text": "a", "start": 0.0, "end": 1.0},), "de")["language"] == "de"


# ── a routed bundle has no calibration, and that must be loud rather than borrowed ─────────────────


class Uncalibrated:
    """`Emissions`' duck type naming a bundle `lexical.CALIBRATED` has no row for — every per-language model
    whisperx tables, which language routing makes reachable."""

    model = "VOXPOPULI_ASR_BASE_10K_DE"
    dictionary: Mapping[str, int] = {"-": 0, "a": 1}
    blank_id = 0
    specials: Mapping[str, int] = {"-": 0}
    frame_sec = 0.02
    log_probs = None


def test_a_routed_bundle_is_not_judged_by_another_bundles_thresholds() -> None:
    """The cross-model threshold borrow, which language routing could re-introduce: an uncalibrated
    matrix answers None, so nothing in nats per letter is read off it, and the sentence on the trail names the
    bundle. The rung's SHARE survives (a fraction of lines within a tolerance in seconds) and the placement
    margin does not (a sum of log-probabilities) — `lexical`'s own asymmetry, re-asserted on the bundles
    routing makes reachable rather than on a hypothetical."""
    from encore_worker.domain.lyrics import lexical

    matrix = Uncalibrated()
    assert lexical.calibration(matrix) is None
    assert lexical.line_sync_share(None) == lexical.LINE_SYNC_SHARE_UNCALIBRATED
    assert lexical.margin_floor(None) is None
    why = lexical.uncalibrated(Uncalibrated.model)
    assert "VOXPOPULI_ASR_BASE_10K_DE" in why and "lift_gate.py --model" in why


async def test_a_transcript_with_no_words_still_reports_the_language_it_heard(tmp_path: Path) -> None:
    """The heard language's second half. `ports.Transcribed.language` is reported on an EMPTY
    transcript too (whisper detects before it decodes a word), and `ml`'s comment said the language "still
    travels" — but the step returns None there, so it was dropped at the one line that could read it. There is
    no text to carry it, so it goes on the trail: an operator seeing an instrumental-sounding stem heard as
    `ko` can declare that language on the next job."""
    steps, out = impl(tmp_path, transcriber=Heard((), "ko"))
    assert await steps.transcribe(job(tmp_path), audio(tmp_path), on_vocals=False) is None
    assert ("asr-language", "heard-nothing") in out.states
    assert any("heard the audio as 'ko'" in why for why in out.reasons)

    quiet, said_nothing = impl(tmp_path, transcriber=Heard((), None))
    assert await quiet.transcribe(job(tmp_path), audio(tmp_path), on_vocals=False) is None
    assert said_nothing.states == [], "a backend that says nothing leaves no note to read"


class RoutedAligner:
    """An `Aligner` whose matrices name the per-language bundle the routing chose — so `time_text` runs on a
    matrix with no `lexical.CALIBRATED` row, which is what routing a non-Latin script produces in production.

    `log_probs = None` is enough and is the point: the gate's absence is decided from the matrix's MODEL,
    before any decode, so a test of it needs no frames (and a wrong text costs none)."""

    def __init__(self) -> None:
        self.emission_languages: list[str] = []

    def emissions(self, audio_path: str, language: str) -> object:
        self.emission_languages.append(language)
        return Uncalibrated()


async def test_a_routed_bundle_times_no_words_because_no_gate_can_read_them(tmp_path: Path) -> None:
    """Routing is default-ON for a non-Latin script, and the bundle it routes to has no calibration row.

    Until this fix the v2 ENVELOPE gate became the only wrong-text gate on that lane — the one H3 measured
    passing 189 of 380 and 220 of 320 wrong texts. The attempt now DECLINES (`None`), which is
    `policy.decide` rule 1 rather than rule 0: a sheet that brought its own line timings degrades to the
    LINE_SYNC rung, gated by a share of lines in SECONDS (`lexical.LINE_SYNC_SHARE_UNCALIBRATED`), and an
    untimed one moves to the next text. Both are asserted, the decline being correct only because the rung
    is reachable."""
    from encore_worker.domain.lyrics.policy import Attempt, Retime
    from encore_worker.domain.lyrics.policy import decide as policy_decide
    from encore_worker.workflows.align import NOTHING_TIMED

    aligner = RoutedAligner()
    steps, out = impl(tmp_path, aligner=aligner)
    got = await steps.time_text(request(tmp_path, language="ko"))
    assert got is None, "an ungated bundle may time LINES, never WORDS"
    assert aligner.emission_languages == ["ko"], "the routing still happened: this is not a refusal to route"
    declined = [why for state, why in zip(out.states, out.reasons, strict=True) if state[1] == "declined"]
    assert declined and "no wrong-text gate can read this text" in declined[-1]
    assert "VOXPOPULI_ASR_BASE_10K_DE" in declined[-1] and "189 of 380" in declined[-1]

    verdict = policy_decide(NOTHING_TIMED, Attempt(has_line_timings=True))
    assert isinstance(verdict, Retime) and verdict.knob is Knob.LINE_SYNC, (
        "what the decline buys: the rung with no emission-scale threshold in it"
    )


async def test_an_operator_naming_an_uncalibrated_bundle_still_fails_before_any_job(
    tmp_path: Path,
) -> None:
    """The LOUD half, unchanged and re-asserted because routing makes uncalibrated bundles ordinary:
    a bundle an operator TYPED is refused at the composition root, where a bundle a LANGUAGE chose is merely
    ungated. The distinction is the whole of `__main__.align_model_for`."""
    from encore_worker.__main__ import align_model_for
    from encore_worker.host.config import ConfigError

    with pytest.raises(ConfigError) as refused:
        align_model_for(Config(align_model="VOXPOPULI_ASR_BASE_10K_DE"), "cpu")
    assert "ENCORE_ALIGN_MODEL" in str(refused.value) and "lift_gate.py" in str(refused.value)
