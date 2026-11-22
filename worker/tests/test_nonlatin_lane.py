"""The NON-LATIN lane: a routed bundle has no wrong-text gate, so it may publish LINES only.

Routing a CJK/Cyrillic/Arabic script onto its own bundle is default-ON, and no bundle but the English ones
has a `lexical.CALIBRATED` row — so on that lane the lift cannot refuse, the doubt band cannot grade and the
placement margin abstains. The GLOBAL engine's word document is closed on it; these tests hold the whole lane
to one rule: words need a witness (a calibration row, or a transcript of this very audio), the WINDOWED
engine included, and what the lane does publish is the sheet's own line timings, unvouched.
docs/arch/04-alignment.md §5.4.
"""

from __future__ import annotations

import inspect
import json
import threading
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path

import pytest

from encore_worker.adapters import ml
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics import language, lexical, romanize, units
from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.host.config import Config
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import TIMING_LINE, AudioRef, TextRef, TimedDoc, TimeRequest
from tests.ctc_fixture import FRAME_SEC, ctc_viterbi, sung_matrix
from tests.test_align_provenance import DIC, PathAligner
from tests.test_align_steps import SUNG, SUNG_WORDS, Reporter, job, sung_stem
from tests.test_lexical_gate import NamedEmissions, NamingAligner

#: A SYNTHETIC Han sheet, six lines, written as the script is: no spaces, so one whitespace token per line.
#: Enumerations and not a sheet's words: the corpus is commercial music and no lyric text is committed to
#: this tree (docs/benchmarks/forced-alignment/LOG.md, "Why no fixture holds a lyric").
HAN_SHEET = (
    "一二三四五六七",
    "甲乙丙丁戊己庚",
    "金木水火土石山",
    "东南西北中左右",
    "春夏秋冬晨午夜",
    "红黄蓝绿紫黑白",
)

#: Another sheet's Han words — the wrong-text shape on this lane, on this song's own clock.
OTHER_HAN_SHEET = (
    "子丑寅卯辰巳午",
    "宫商角徵羽变闰",
    "点线面体角边形",
    "上中下前后内外",
    "大小多少高低平",
    "风雨雷电霜雾雪",
)

#: The bundle whisperx loads for Mandarin — the real name, so the matrix under test names a model
#: `lexical.CALIBRATED` genuinely lacks rather than an invented string.
ZH_BUNDLE = ml.align_model_name("zh")

#: A SYNTHETIC Thai run per line — a script `language.SCRIPT_LANGUAGES` can name NO language for, so
#: `language.detect` answers `en` for it and the CALIBRATED English bundle times it. Consonant enumerations,
#: never a sheet's words.
THAI_RUNS = (
    "กขฃคฅฆงจฉชซฌญฎฏฐฑฒ",
    "ณดตถทธนบปผฝพฟภมยรล",
    "วศษสหฬอฮกขฃคฅฆงจฉช",
    "ซฌญฎฏฐฑฒณดตถทธนบปผ",
    "ฝพฟภมยรลวศษสหฬอฮกข",
    "ฃคฅฆงจฉชซฌญฎฏฐฑฒณด",
)

#: The script-fallback shape: Thai DOMINANT, with enough Latin letters per line for the lift to be
#: measurable and for the English bundle to decode something. So the gate finds a row, measures a lift on the
#: Latin remnant, and used to publish word timings for the Thai bulk nothing read.
MIXED_SHEET = tuple(f"{thai} {english}" for thai, english in zip(THAI_RUNS, SUNG_WORDS, strict=True))


def impl(
    tmp: Path, *, reporter: Reporter, experiments: frozenset[str] = frozenset(), **adapters: object
) -> AlignStepsImpl:
    return AlignStepsImpl(
        config=Config(asr_model="base", align_experiments=experiments),
        adapters=Adapters(**adapters),  # type: ignore[arg-type]
        reporter=reporter,
    )


def sheet(texts: Sequence[str], *, tier: Tier = Tier.CANDIDATE) -> TextRef:
    """`texts` as an authored caption track on the fixture song's own spans, one cue per line."""
    return TextRef(
        tier=tier,
        label="captions:authored",
        segments=tuple(
            {"text": text, "start": start, "end": end} for text, (start, end) in zip(texts, SUNG, strict=True)
        ),
        timing=TIMING_LINE,
    )


def request(
    tmp: Path, text: TextRef, audio: AudioRef, *, language: str, knobs: frozenset[Knob] = frozenset()
) -> TimeRequest:
    return TimeRequest(job=job(tmp), text=text, audio=audio, language=language, knobs=knobs)


def singing(stem: AudioRef) -> PathAligner:
    """An aligner whose matrix for `stem` sings the fixture's English words: what a CJK sheet decodes to is
    not this lane's question, the bundle's missing row deciding before any decode."""
    assert stem.vocals_path is not None
    phrases = [(word, start, end) for word, (start, end) in zip(SUNG_WORDS, SUNG, strict=True)]
    return PathAligner({stem.vocals_path: sung_matrix(phrases, DIC, 40.0)})


class WindowedAligner:
    """An `Aligner` with NO `emissions`: the windowed engine, which can read no lift at all. `align` answers
    one word per line on the spans it was handed, which is enough to publish a word document."""

    def __init__(self) -> None:
        self.languages: list[str] = []

    def align(self, search: Sequence[Segment], audio_path: str, language: str) -> Sequence[Segment]:
        self.languages.append(language)
        return tuple(
            {
                "text": str(segment["text"]),
                "start": float(segment["start"]),  # type: ignore[arg-type]
                "end": float(segment["end"]),  # type: ignore[arg-type]
                "words": (
                    {
                        "word": str(segment["text"]),
                        "start": float(segment["start"]),  # type: ignore[arg-type]
                        "end": float(segment["end"]),  # type: ignore[arg-type]
                    },
                ),
            }
            for segment in search
        )


# ── the rule itself ───────────────────────────────────────────────────────────────────────────────────


def test_words_need_a_calibration_row_or_a_transcript_of_this_audio() -> None:
    """`lexical.may_time_words` is the whole rule, in the one place both engines read it."""
    assert lexical.may_time_words(lexical.BANDS, heard_on_this_audio=False) is True
    assert lexical.may_time_words(None, heard_on_this_audio=False) is False
    assert lexical.may_time_words(None, heard_on_this_audio=True) is True
    # AND THE ROW IS A BUNDLE'S: a script no bundle is for reaches the English row by fallback, which was
    # fitted on text that vocabulary can spell.
    assert lexical.may_time_words(lexical.BANDS, heard_on_this_audio=False, nonlatin_script="Thai") is False
    assert lexical.may_time_words(lexical.BANDS, heard_on_this_audio=True, nonlatin_script="Thai") is True
    assert lexical.may_time_words(lexical.BANDS, heard_on_this_audio=False, nonlatin_script="") is True
    # AND THE ROW IS A PAIR'S, so the rule turns on the ROW's own language and not on the script
    # alone: a Han text holding an ENGLISH row found a FALLBACK and is still declined, while the same text
    # on its own calibrated pair is the first non-Latin WORD document this lane allows. The language is read
    # OFF THE ROW, so these two cases cannot be made to disagree by a caller passing the wrong one.
    zh_row = lexical.CALIBRATED[("MMS_FA", "zh")]
    assert lexical.may_time_words(zh_row, heard_on_this_audio=False, nonlatin_script="Han") is True
    assert lexical.may_time_words(lexical.BANDS, heard_on_this_audio=False, nonlatin_script="Han") is False, (
        "the English row may not answer for a Han text, which is review r2-spec-8's defect"
    )
    assert "bundle_language" not in inspect.signature(lexical.may_time_words).parameters, (
        "a second argument for the row's language can disagree with the row; `Bands.language` is the fact"
    )
    assert not lexical.is_calibrated(ZH_BUNDLE, "zh"), (
        f"{ZH_BUNDLE} is whisperx's own Mandarin bundle, and zh routes OFF it to MMS_FA (XA-21): its own "
        "pair was never fitted, so a run pinned to it still publishes lines only"
    )
    said = lexical.words_ungated(lexical.uncalibrated(ZH_BUNDLE))
    assert "no wrong-text gate can read this text" in said and ZH_BUNDLE in said
    assert lexical.ENVELOPE_WRONG_TEXT_PASSES in said, "the measurement that makes the fallback no fallback"


def test_a_cjk_lift_can_only_contrast_whole_lines_because_the_script_writes_no_spaces() -> None:
    """Why calibrating this lane (stage 2) is not the English recipe re-run: `lexical.shuffles_of` shuffles
    WHITESPACE tokens and a CJK sheet has one per line, so the contrast is the sheet's lines reordered rather
    than its words. Still a different target sequence, so a lift is measurable — but a far weaker one, which
    is what stage 1's script-aware units are for."""
    assert all(len(line.split()) == 1 for line in HAN_SHEET), "no word boundary for the shuffle to use"
    shuffled = lexical.shuffles_of(list(HAN_SHEET))
    assert shuffled and all(sorted(lines) == sorted(HAN_SHEET) for lines in shuffled)
    assert any(list(lines) != list(HAN_SHEET) for lines in shuffled), "the contrast is line order"


# ── the global engine, on a CJK sheet ─────────────────────────────────────────────────────────────────


async def test_a_cjk_sheet_publishes_its_line_timings_unvouched_and_never_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The lane end to end on the script it is about. The word attempt DECLINES (no gate can read the text)
    and the LINE_SYNC rung the decline leaves reachable publishes the sheet's own timings — `low`, UNVOUCHED,
    with the missing calibration row named on the trail. That pair IS stage 0's rule."""
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem = sung_stem(tmp_path)
    aligner = NamingAligner(singing(stem), ZH_BUNDLE)
    out = Reporter()
    steps = impl(tmp_path, reporter=out, aligner=aligner)

    words = await steps.time_text(request(tmp_path, sheet(HAN_SHEET), stem, language="zh"))
    assert words is None, "a bundle with no wrong-text gate may not time words"
    assert ("align-global", "declined", None) in out.states
    assert any("no wrong-text gate can read this text" in why for why in out.reasons)
    assert aligner.asked == [stem.vocals_path], "the routing still happened: one emission pass on the stem"

    lines = await steps.time_text(
        request(tmp_path, sheet(HAN_SHEET), stem, language="zh", knobs=frozenset({Knob.LINE_SYNC}))
    )
    assert isinstance(lines, TimedDoc), lines
    assert lines.timing == TIMING_LINE and lines.confidence == "low"
    assert lines.vouched is False, "nothing read these words, so nothing vouches for them"
    assert any("no lexical calibration for" in why and ZH_BUNDLE in why for why in out.reasons)
    assert not list(tmp_path.rglob("*-word.json")), "the lane writes no word document at all"
    assert lines.language == "zh", "the published document is the TEXT's language, not the bundle's"


async def test_a_wrong_cjk_text_times_no_words_either_and_the_reason_is_the_bundle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Another sheet's Han words on this song's clock: the shape rated HIGH severity, because on this lane
    the lift cannot refuse it. It declines for want of a gate rather than being judged — the honest answer,
    and the one that cannot publish a wrong text as word timings."""
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem = sung_stem(tmp_path)
    out = Reporter()
    steps = impl(tmp_path, reporter=out, aligner=NamingAligner(singing(stem), ZH_BUNDLE))
    assert await steps.time_text(request(tmp_path, sheet(OTHER_HAN_SHEET), stem, language="zh")) is None
    assert any("may time LINES but not WORDS" in why for why in out.reasons)


# ── the windowed engine ───────────────────────────────────────────────────────────────────────────────


async def test_a_windowed_aligner_times_no_words_on_a_routed_bundle(tmp_path: Path) -> None:
    """The other word-timing exit, once left open: an `Aligner` with no `emissions` reads no matrix, so
    no lift can be measured on any bundle — and every calibration row is an English bundle's. A routed
    language therefore declines here too, and the English default keeps the behaviour it was measured on."""
    stem = sung_stem(tmp_path)
    routed = WindowedAligner()
    out = Reporter()
    got = await impl(tmp_path, reporter=out, aligner=routed).time_text(
        request(tmp_path, sheet(HAN_SHEET), stem, language="zh")
    )
    assert got is None, "words with no witness at all"
    assert routed.languages == [], "declined BEFORE the aligner was paid for"
    assert ("align-windowed", "declined", None) in out.states
    assert any("this aligner reads no emission matrix" in why for why in out.reasons)

    english = WindowedAligner()
    unmoved = await impl(tmp_path, reporter=Reporter(), aligner=english).time_text(
        request(tmp_path, sheet(SUNG_WORDS), stem, language="en")
    )
    assert isinstance(unmoved, TimedDoc) and unmoved.timing == "word"
    assert english.languages == ["en"], "English is the bundle every row was fitted on; nothing moved"


async def test_the_windowed_engine_keeps_the_two_exemptions_the_global_one_has(tmp_path: Path) -> None:
    """A transcript's words were heard on THIS recording, so they can be misheard but never another song's;
    a human PIN publishes anyway, all-`low` and unvouched, as `_time_text_global` has it;
    `h3-ungated-words` is the control that restores the ungated behaviour for a measurement."""
    stem = sung_stem(tmp_path)
    heard = await impl(tmp_path, reporter=Reporter(), aligner=WindowedAligner()).time_text(
        request(tmp_path, sheet(HAN_SHEET, tier=Tier.ASR), stem, language="zh")
    )
    assert isinstance(heard, TimedDoc) and heard.timing == "word"

    out = Reporter()
    pinned = TimeRequest(
        job=job(tmp_path, pinnedRef="lyrics/pinned.json"),
        text=sheet(HAN_SHEET),
        audio=stem,
        language="zh",
    )
    chosen = await impl(tmp_path, reporter=out, aligner=WindowedAligner()).time_text(pinned)
    assert isinstance(chosen, TimedDoc), "a person's own text is not declined out from under them"
    assert chosen.confidence == "low" and chosen.vouched is False
    assert ("align-windowed", "pin-unvouched", None) in out.states
    # THE GRADE IS ON THE LINES, not only on the record: core's
    # `wipesWords` keeps the word-by-word wipe for a line with NO grade, so the trail's "every line graded
    # low" has to be true of the published document too.
    published = json.loads((tmp_path / chosen.ref).read_text(encoding="utf-8"))
    assert published["lines"], "the document the TV reads"
    assert [line["confidence"] for line in published["lines"]] == ["low"] * len(published["lines"])
    assert any("every line graded low" in why for why in out.reasons)

    control = await impl(
        tmp_path,
        reporter=Reporter(),
        aligner=WindowedAligner(),
        experiments=frozenset({"h3-ungated-words"}),
    ).time_text(request(tmp_path, sheet(HAN_SHEET), stem, language="zh"))
    assert isinstance(control, TimedDoc), "the control arm is the only way to read this lane end to end"


# ── the TV can read it: display-only romanisation ─────────────────────────────────────────────────────


def romanizer_of(said: dict[str, str]) -> object:
    """An `Adapters.romanizer` factory over a lookup table: this test is about the PUBLISHED FIELD, not
    about any backend's transliteration (`tests/test_romanize.py` reads the real ones)."""
    return lambda _language, _script: (lambda text: said[text]) if said else None


async def test_a_published_cjk_line_carries_its_romanisation_as_an_extra_field(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stage 0's other half: the line document publishes, and each line brings a second script the TV may
    show under it. DISPLAY-ONLY — the text is unchanged, the timings are unchanged, and the romanisation
    reaches no target sequence (XA-19; docs/arch/04-alignment.md §11.2)."""
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem = sung_stem(tmp_path)
    said = {line: f"r:{index}" for index, line in enumerate(HAN_SHEET)}
    steps = impl(
        tmp_path,
        reporter=Reporter(),
        aligner=NamingAligner(singing(stem), ZH_BUNDLE),
        romanizer=romanizer_of(said),
    )
    lines = await steps.time_text(
        request(tmp_path, sheet(HAN_SHEET), stem, language="zh", knobs=frozenset({Knob.LINE_SYNC}))
    )
    assert isinstance(lines, TimedDoc), lines
    published = json.loads((tmp_path / lines.ref).read_text(encoding="utf-8"))
    assert [line["text"] for line in published["lines"]] == list(HAN_SHEET), "the original text, untouched"
    assert [line["romanization"] for line in published["lines"]] == list(said.values())
    assert all("words" not in line for line in published["lines"]), "stage 0 publishes LINES"


async def test_a_box_with_no_romaniser_publishes_the_document_it_always_did(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The backends are an optional extra, so the field has to be ABSENT rather than null or empty — which
    is also the shape every row under `docs/benchmarks/forced-alignment/results/` was measured on."""
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem = sung_stem(tmp_path)
    for romanizer in (None, romanizer_of({})):
        steps = impl(
            tmp_path,
            reporter=Reporter(),
            aligner=NamingAligner(singing(stem), ZH_BUNDLE),
            romanizer=romanizer,
        )
        lines = await steps.time_text(
            request(tmp_path, sheet(HAN_SHEET), stem, language="zh", knobs=frozenset({Knob.LINE_SYNC}))
        )
        assert isinstance(lines, TimedDoc), lines
        published = json.loads((tmp_path / lines.ref).read_text(encoding="utf-8"))
        assert all("romanization" not in line for line in published["lines"])


async def test_an_english_line_document_gains_nothing_even_with_a_romaniser_wired(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """English is the measured default and must be byte-unmoved: there is no backend for a Latin language,
    and `needs_romanization` refuses a Latin line even if one were handed in."""
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem = sung_stem(tmp_path)
    steps = impl(
        tmp_path,
        reporter=Reporter(),
        aligner=NamingAligner(singing(stem), ml.align_model_name("en")),
        romanizer=romanizer_of({text: "SHOUTED" for text in SUNG_WORDS}),
    )
    lines = await steps.time_text(
        request(tmp_path, sheet(SUNG_WORDS), stem, language="en", knobs=frozenset({Knob.LINE_SYNC}))
    )
    assert isinstance(lines, TimedDoc), lines
    published = json.loads((tmp_path / lines.ref).read_text(encoding="utf-8"))
    assert all("romanization" not in line for line in published["lines"])


async def test_the_romaniser_is_built_off_the_event_loop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """uroman spends ~2 s building its tables and the factory is asked per published document, so building it
    ON the loop stalls every other job this worker is running — progress frames and the heartbeat included.
    A display extra may not cost that."""
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem = sung_stem(tmp_path)
    built: list[int] = []

    def factory(_language: str, _script: str) -> romanize.Romanizer:
        built.append(threading.get_ident())
        return lambda text: f"r:{text}"

    steps = impl(
        tmp_path,
        reporter=Reporter(),
        aligner=NamingAligner(singing(stem), ZH_BUNDLE),
        romanizer=factory,
    )
    lines = await steps.time_text(
        request(tmp_path, sheet(HAN_SHEET), stem, language="zh", knobs=frozenset({Knob.LINE_SYNC}))
    )
    assert isinstance(lines, TimedDoc), lines
    assert built, "the factory was asked for this document's language"
    assert threading.get_ident() not in built, "built on the loop's own thread"


def test_the_shipped_worker_wires_the_factory_and_not_one_romaniser() -> None:
    """The language is a per-document fact, so the composition root hands over the FACTORY — and each
    backend is built on first use, uroman's tables costing ~2 s."""
    from encore_worker import __main__ as root

    assert root.build_adapters(Config(), device="cpu").romanizer is romanize.build_romanizer


# ── the script the language cannot carry ──────────────────────────────────────────────────────────────


def test_a_script_no_bundle_exists_for_falls_back_to_english_and_detect_says_so() -> None:
    """The premise, read off the shipped detector: `SCRIPT_LANGUAGES` names no language for Thai, so the
    fallback answers `en` with source `default` while the SCRIPT says what the text really is."""
    pytest.importorskip("whisperx", reason="the English bundle's name is read off whisperx's own tables")
    detected = language.detect(list(MIXED_SHEET))
    assert (detected.language, detected.script, detected.source) == ("en", "Thai", "default")
    assert language.nonlatin_script(list(MIXED_SHEET)) == "Thai"
    assert language.nonlatin_script(list(SUNG_WORDS)) == "", "a Latin sheet has no non-Latin script"
    assert lexical.is_calibrated(ml.align_model_name("en")), "the fallback bundle IS a calibrated one"


async def test_a_script_no_bundle_exists_for_times_no_words_on_the_calibrated_english_bundle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The lane's rule was once read off the LANGUAGE the fallback picked, so a Thai sheet took
    the English bundle, found its calibration row and published word timings `high` and VOUCHED — the lift
    having measured the Latin remnant of a text whose bulk no vocabulary here spells. The rule is the TEXT's
    script now, so the attempt declines and the LINE_SYNC rung is what the room gets."""
    pytest.importorskip("whisperx", reason="the English bundle's name is read off whisperx's own tables")
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem = sung_stem(tmp_path)
    out = Reporter()
    steps = impl(tmp_path, reporter=out, aligner=NamingAligner(singing(stem), ml.align_model_name("en")))
    assert await steps.time_text(request(tmp_path, sheet(MIXED_SHEET), stem, language="en")) is None
    assert ("align-global", "declined", None) in out.states
    assert any("written in Thai" in why and "may time LINES but not WORDS" in why for why in out.reasons)
    assert not list(tmp_path.rglob("*-word.json")), "no word document was written at all"

    control = await impl(
        tmp_path,
        reporter=Reporter(),
        aligner=NamingAligner(singing(stem), ml.align_model_name("en")),
        experiments=frozenset({"h3-ungated-words"}),
    ).time_text(request(tmp_path, sheet(MIXED_SHEET), stem, language="en"))
    assert isinstance(control, TimedDoc) and control.timing == "word", (
        "`h3-ungated-words` is the control that measures what the rule costs"
    )


async def test_a_pinned_text_in_such_a_script_publishes_all_low_rather_than_being_declined(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The pin exemption is the lane's, not the missing row's: a person chose this text, so it publishes —
    every line `low`, the document unvouched, with the script named on the trail."""
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem = sung_stem(tmp_path)
    out = Reporter()
    pinned = TimeRequest(
        job=job(tmp_path, pinnedRef="lyrics/pinned.json"),
        text=sheet(MIXED_SHEET),
        audio=stem,
        language="en",
    )
    chosen = await impl(
        tmp_path, reporter=out, aligner=NamingAligner(singing(stem), ml.align_model_name("en"))
    ).time_text(pinned)
    assert isinstance(chosen, TimedDoc), "a person's own text is not declined out from under them"
    assert chosen.confidence == "low" and chosen.vouched is False
    assert ("align-global", "pin-unvouched", None) in out.states
    published = json.loads((tmp_path / chosen.ref).read_text(encoding="utf-8"))
    assert [line["confidence"] for line in published["lines"]] == ["low"] * len(published["lines"])


async def test_the_windowed_engine_declines_such_a_script_too(tmp_path: Path) -> None:
    """The other word-timing exit reads no matrix, so it cannot even measure the Latin remnant — and its
    bundle is `en`, which is not a routed bundle at all. The TEXT's script is what declines it."""
    routed = WindowedAligner()
    out = Reporter()
    got = await impl(tmp_path, reporter=out, aligner=routed).time_text(
        request(tmp_path, sheet(MIXED_SHEET), sung_stem(tmp_path), language="en")
    )
    assert got is None and routed.languages == [], "declined BEFORE the aligner was paid for"
    assert any("written in Thai" in why for why in out.reasons)


# ── the arms reach the step, and the step builds them off the loop ────────────────────────────────────

#: A toy Mandarin vocabulary: every character of the Han sheet, 0 left as CTC's blank. So a decode of this
#: sheet can place each hanzi, which is what the unit arm regroups.
HAN_DIC = {ch: index + 1 for index, ch in enumerate(sorted({ch for line in HAN_SHEET for ch in line}))}


class HanAligner:
    """An `Aligner` whose matrix SINGS the Han sheet one hanzi at a time, over a vocabulary that holds those
    characters — `PathAligner`'s matrices carry the Latin fixture dictionary, which maps no hanzi at all."""

    def __init__(self, model: str = ZH_BUNDLE) -> None:
        phrases = [(line, start, end) for line, (start, end) in zip(HAN_SHEET, SUNG, strict=True)]
        self._matrix = sung_matrix(phrases, HAN_DIC, 40.0)
        self._model = model
        self.asked: list[str] = []

    def emissions(self, path: str, _language: str) -> NamedEmissions:
        self.asked.append(path)
        return NamedEmissions(
            log_probs=self._matrix, frame_sec=FRAME_SEC, dictionary=dict(HAN_DIC), model=self._model
        )

    def align(self, *_a: object) -> tuple[dict[str, object], ...]:
        raise AssertionError("the windowed engine must not run: the global decode has emissions")


async def test_the_unit_rules_are_built_off_the_event_loop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`mms-roman` builds uroman or cutlet inside `units.rules_for` — 2.23 s for `ko` on the box this was
    measured on — and the display romaniser's fix did not cover this sibling path.
    Every one of the three call sites must be off the loop."""
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    built: list[int] = []
    real = units.rules_for

    def rules_for(language_code: str, experiments: object) -> units.Rules:
        built.append(threading.get_ident())
        return real(language_code, experiments)  # type: ignore[arg-type]

    monkeypatch.setattr(units, "rules_for", rules_for)
    stem = sung_stem(tmp_path)
    steps = impl(
        tmp_path,
        reporter=Reporter(),
        aligner=HanAligner(),
        # `UNROUTED`: this fixture's vocabulary is hanzi, and zh's SHIPPED route romanises (`units.ROUTED`),
        # so the table is stood down and the test measures exactly the arm it names.
        experiments=frozenset({"nonlatin-units", "h3-ungated-words", units.UNROUTED}),
    )
    assert isinstance(
        await steps.time_text(request(tmp_path, sheet(HAN_SHEET), stem, language="zh")), TimedDoc
    )
    assert built, "the global engine asked for this attempt's unit rules"
    assert threading.get_ident() not in built, "built on the loop's own thread"
    # The two gate paths ask too, and neither may block the loop either.
    lines = await steps.time_text(
        request(tmp_path, sheet(HAN_SHEET), stem, language="zh", knobs=frozenset({Knob.LINE_SYNC}))
    )
    assert isinstance(lines, TimedDoc), lines
    assert threading.get_ident() not in built, "the LINE_SYNC rung's evidence builds them off the loop too"


async def test_the_unit_arm_reaches_the_steps_own_decode_and_its_lexical_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nothing ran a non-Latin arm through `AlignStepsImpl`, so all eleven step-level `units=`
    wirings survived mutation to None. This drives the real step on a Han sheet and reads the two things the
    arm must change: the PUBLISHED words are per-hanzi, and the lexical lift — whose shuffle is the unit
    rule's — is a different number from the whitespace rule's on the same matrix and the same text.
    `h3-ungated-words` is what lets this lane publish words at all (docs/arch/04-alignment.md §9.1).
    """
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem = sung_stem(tmp_path)

    async def published(
        experiments: frozenset[str], *, model: str = ZH_BUNDLE
    ) -> tuple[list[list[str]], list[str]]:
        out = Reporter()
        # `UNROUTED` with every set: zh's SHIPPED route romanises onto MMS_FA (`units.ROUTED`), and this
        # fixture's vocabulary holds hanzi and no Latin letter, so the table is stood down here.
        steps = impl(
            tmp_path,
            reporter=out,
            aligner=HanAligner(model),
            experiments=experiments | {units.UNROUTED},
        )
        doc = await steps.time_text(request(tmp_path, sheet(HAN_SHEET), stem, language="zh"))
        assert isinstance(doc, TimedDoc), doc
        written = json.loads((tmp_path / doc.ref).read_text(encoding="utf-8"))
        words = [[word["word"] for word in line["words"]] for line in written["lines"]]
        return words, out.reasons

    armed, armed_why = await published(frozenset({"nonlatin-units", "h3-ungated-words"}))
    plain, plain_why = await published(frozenset({"h3-ungated-words"}))

    assert plain[0] == [HAN_SHEET[0]], "the whitespace rule makes a Chinese line ONE word"
    assert armed[0] == list(HAN_SHEET[0]), "the arm publishes one word per hanzi"
    assert all(len(word) == 1 for line in armed for word in line)
    assert [("".join(line)) for line in armed] == [("".join(line)) for line in plain], (
        "XA-20: the arm changes the GROUPING and not one published character"
    )
    assert any("units units for 'zh'" in why for why in armed_why), "the trail names the arm"
    assert not any("units units" in why for why in plain_why)

    # AND THE GATE's own decodes: the zh bundle has no calibration row, so no lift is measured on this lane
    # at all (XA-06) — the arm's reach into `lexical.lift` is read on the bundle the lane USED to fall back
    # to, under the same control arm the bench measures it with.
    assert all("no lexical calibration for" in why for why in armed_why if "lexical" in why)
    english = ml.align_model_name("en")
    # A row for (that bundle, zh): the key is a PAIR, so the English row does not answer for a
    # Chinese text on the English bundle — which is the borrow `calibration` refuses (XA-21). One is pasted
    # in here so the arm's reach into `lexical.lift` is readable at all.
    monkeypatch.setitem(
        lexical.CALIBRATED, (english, "zh"), replace(lexical.BANDS, model=english, language="zh")
    )
    _armed_en, armed_en_why = await published(
        frozenset({"nonlatin-units", "h3-ungated-words"}), model=english
    )
    _plain_en, plain_en_why = await published(frozenset({"h3-ungated-words"}), model=english)

    def lift_of(reasons: list[str]) -> str:
        said = [why for why in reasons if "lexical lift" in why]
        assert said, "the lift was measured"
        return said[0][said[0].index("lexical lift") :].split(",")[0]

    assert lift_of(armed_en_why) != lift_of(plain_en_why), (
        "the shuffle contrast is the unit rule's: with one word a line, a shuffle only reorders lines"
    )


#: Every call in the align step that builds a TARGET SEQUENCE or reads one off a trellis. The unit rule has
#: to reach all of them, so no two readers of one attempt group its text differently (XA-20,
#: docs/arch/04-alignment.md §9.1).
TARGET_BUILDERS = frozenset(
    {
        "generate",
        "regenerate",
        "char_targets",
        "alignable_chars",
        "letters_of",
        "lift",
        "parts.split",
        "_skipped_lines",
        "_placement_margins",
        "_measured_lift",
    }
)

#: Where the unit rules sit when a builder takes them POSITIONALLY rather than by keyword, so the scan can
#: read the argument itself and not the call's text — one call carries the word "rules" in a comment.
POSITIONAL_UNITS = {"_measured_lift": 2, "alignable_chars": 2, "letters_of": 3}


def test_every_target_builder_in_the_step_is_given_the_attempts_own_unit_rules() -> None:
    """All eleven step-level `units=` wirings survived mutation to None and the suite
    stayed green, most of them being arm-only or repair-only paths a hermetic test cannot all reach. The two
    reachable ones have behavioural tests above; this reads the remaining ones as SOURCE, which is the only
    thing that can fail for a decode nothing in this suite runs.
    """
    import ast  # noqa: PLC0415 - a source guard, read where it is used

    nodes = [
        node for path in _align_step_paths() for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
    ]
    checked: list[str] = []
    missing: list[str] = []
    for node in nodes:
        if not isinstance(node, ast.Call):
            continue
        name = _callee(node.func)
        args = node.args
        if name.rsplit(".", 1)[-1] in ("to_thread", "partial") and args:
            name, args = _callee(args[0]), []  # the builder's own arguments are this call's keywords
        if name not in TARGET_BUILDERS:
            continue
        checked.append(f"{name}:{node.lineno}")
        given = next((kw.value for kw in node.keywords if kw.arg in ("units", "rules")), None)
        at = POSITIONAL_UNITS.get(name)
        if given is None and at is not None and len(args) > at:
            given = args[at]
        if given is None or (isinstance(given, ast.Constant) and given.value is None):
            missing.append(f"{name} at line {node.lineno}")
    assert not missing, (
        "these target builders are not given the attempt's own unit rules: "
        + ", ".join(missing)
        + ". One text has one tokenisation per attempt (docs/arch/04-alignment.md §9.1)."
    )
    assert len(checked) >= 11, (
        f"the scan found only {len(checked)} target builders ({checked}); the eleven the review mutated are "
        "the floor, so a scan that sees fewer has gone blind"
    )


def _callee(node: object) -> str:
    """A call's callee as it is SPELLED: `generate`, `parts.split`, `lexical.lift`."""
    import ast  # noqa: PLC0415

    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_callee(node.value)}.{node.attr}".lstrip(".")
    return ""


def _align_step_paths() -> list[Path]:
    """Every module of the align step (`steps/align_*.py`), for the source guard above — the step's
    module-level helpers live in siblings, and a scan of one file would no longer see them all."""
    from encore_worker.steps import align_steps  # noqa: PLC0415

    assert align_steps.__file__ is not None
    found = sorted(Path(align_steps.__file__).parent.glob("align_*.py"))
    assert len(found) >= 7, f"the step's module set has shrunk to {[p.name for p in found]}"
    return found


async def test_the_romaniser_factory_is_asked_with_the_texts_own_script(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The factory was once routed by LANGUAGE alone, and `detect` answers `en` for every
    script `SCRIPT_LANGUAGES` cannot name — so a Thai, Bengali or Armenian line got no second script at all
    though uroman ships tables for it. The step hands over the text's own script beside its language."""
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    asked: list[tuple[str, str]] = []

    def factory(language_code: str, script: str) -> romanize.Romanizer:
        asked.append((language_code, script))
        return lambda text: f"r:{text}"

    stem = sung_stem(tmp_path)
    steps = impl(
        tmp_path,
        reporter=Reporter(),
        aligner=NamingAligner(singing(stem), ml.align_model_name("en")),
        romanizer=factory,
    )
    lines = await steps.time_text(
        request(tmp_path, sheet(MIXED_SHEET), stem, language="en", knobs=frozenset({Knob.LINE_SYNC}))
    )
    assert isinstance(lines, TimedDoc), lines
    assert asked == [("en", "Thai")], "the language the fallback picked AND the script the text is in"
    published = json.loads((tmp_path / lines.ref).read_text(encoding="utf-8"))
    assert all(line["romanization"].startswith("r:") for line in published["lines"])


def test_the_mms_bundle_is_refused_where_no_transliterator_can_be_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`mms-roman` once switched the bundle to MMS_FA on the ARM NAME alone, while the
    romanised targets it exists to pair with come from the `romanize` extra — so on a box with `nonlatin` and
    not `romanize` every target was dropped by `char_ids` and the attempt died as "no line in this text
    carries an alignable character". The pairing is refused at the composition root instead."""
    from encore_worker import __main__ as root
    from encore_worker.host.config import ConfigError

    armed = Config(align_experiments=frozenset({"mms-roman"}))
    unrouted = Config(align_experiments=frozenset({units.UNROUTED}))
    assert root.nonlatin_routes_for(unrouted) == {}, "no route, no bundle, no backend needed"
    monkeypatch.setattr(romanize, "build_transliterator", lambda _code: None)
    with pytest.raises(ConfigError, match="romanize"):
        root.nonlatin_routes_for(armed)
    # AND WITHOUT THE NAMED ARM THE TABLE DEGRADES RATHER THAN RAISING: a box with no transliterator at all
    # keeps whisperx's own bundles, which is the measured `nonlatin-units` reading and not a dead worker.
    assert root.nonlatin_routes_for(Config()) == {}
    monkeypatch.setattr(
        romanize, "build_transliterator", lambda code: (lambda text: text) if code == "zh" else None
    )
    # ONE LANGUAGE'S BACKEND BUYS ONE LANGUAGE'S ROUTE: ko's row also wants MMS_FA, and with no Korean
    # transliterator it must NOT be routed there — the bundle and the target sequence cannot disagree.
    assert root.nonlatin_routes_for(armed) == {"zh": ml.MMS_ALIGN_MODEL}
    assert root.nonlatin_routes_for(Config()) == {"zh": ml.MMS_ALIGN_MODEL}


def test_an_arm_this_box_cannot_apply_says_so_on_the_trail() -> None:
    """The per-LANGUAGE half of the same finding: a box with pypinyin but no uroman passes the refusal above
    and still cannot romanise Korean, so `units.unhonoured` names the arm and the trail prints that it did
    NOT apply — `Rules.name` alone silently omits it."""
    from encore_worker.steps.align_notes import _units_why

    arms = frozenset({"mms-roman"})
    missing = units.unhonoured("ko", arms) if romanize.build_transliterator("ko") is None else frozenset()
    if missing:
        said = _units_why(units.rules_for("ko", arms), "ko", arms)
        assert "mms-roman did NOT apply" in said and "no backend" in said
    assert units.unhonoured("ko", frozenset({units.UNROUTED})) == frozenset(), (
        "an arm neither the table nor the operator asked for is not unhonoured"
    )
    assert units.unhonoured("en", arms) == frozenset(), "a Latin language romanises nothing by design"
