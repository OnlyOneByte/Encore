"""The NON-LATIN lane (W8 stage 0): a routed bundle has no wrong-text gate, so it may publish LINES only.

Routing a CJK/Cyrillic/Arabic script onto its own bundle is default-ON, and no bundle but the English ones
has a `lexical.CALIBRATED` row — so on that lane the lift cannot refuse, the doubt band cannot grade and the
placement margin abstains. W7 closed the GLOBAL engine's word document on it; these tests hold the whole lane
to one rule: words need a witness (a calibration row, or a transcript of this very audio), the WINDOWED
engine included, and what the lane does publish is the sheet's own line timings, unvouched.
docs/arch/04-alignment.md §5.4.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

import pytest

from encore_worker.adapters import ml
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics import lexical, romanize
from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.host.config import Config
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import TIMING_LINE, AudioRef, TextRef, TimedDoc, TimeRequest
from tests.ctc_fixture import ctc_viterbi, sung_matrix
from tests.test_align_provenance import DIC, PathAligner
from tests.test_align_steps import SUNG, SUNG_WORDS, Reporter, job, sung_stem
from tests.test_lexical_gate import NamingAligner

#: A Mandarin sheet, six lines, written as the script is: no spaces, so one whitespace token per line.
MANDARIN = (
    "我来到你的城市",
    "走过你来时的路",
    "想像着没我的日子",
    "你是怎样的孤独",
    "拿着你给的照片",
    "熟悉的那一条街",
)

#: Another song's Mandarin words — the wrong-text shape on this lane, on this song's own clock.
WRONG_MANDARIN = (
    "光年之外的你",
    "缘分让我们相遇乱世以外",
    "命运却要我们奋力求生存",
    "我们等不到的未来",
    "却要用尽一生等待",
    "你是我的光年之外",
)

#: The bundle whisperx loads for Mandarin — the real name, so the matrix under test names a model
#: `lexical.CALIBRATED` genuinely lacks rather than an invented string.
ZH_BUNDLE = ml.align_model_name("zh")


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
    assert not lexical.is_calibrated(ZH_BUNDLE), (
        f"{ZH_BUNDLE} is the bundle Mandarin routes to; this lane exists because it has no row"
    )
    said = lexical.words_ungated(lexical.uncalibrated(ZH_BUNDLE))
    assert "no wrong-text gate can read this text" in said and ZH_BUNDLE in said
    assert lexical.ENVELOPE_WRONG_TEXT_PASSES in said, "the measurement that makes the fallback no fallback"


def test_a_cjk_lift_can_only_contrast_whole_lines_because_the_script_writes_no_spaces() -> None:
    """Why calibrating this lane (stage 2) is not the English recipe re-run: `lexical.shuffles_of` shuffles
    WHITESPACE tokens and a CJK sheet has one per line, so the contrast is the sheet's lines reordered rather
    than its words. Still a different target sequence, so a lift is measurable — but a far weaker one, which
    is what stage 1's script-aware units are for."""
    assert all(len(line.split()) == 1 for line in MANDARIN), "no word boundary for the shuffle to use"
    shuffled = lexical.shuffles_of(list(MANDARIN))
    assert shuffled and all(sorted(lines) == sorted(MANDARIN) for lines in shuffled)
    assert any(list(lines) != list(MANDARIN) for lines in shuffled), "the contrast is line order"


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

    words = await steps.time_text(request(tmp_path, sheet(MANDARIN), stem, language="zh"))
    assert words is None, "a bundle with no wrong-text gate may not time words"
    assert ("align-global", "declined", None) in out.states
    assert any("no wrong-text gate can read this text" in why for why in out.reasons)
    assert aligner.asked == [stem.vocals_path], "the routing still happened: one emission pass on the stem"

    lines = await steps.time_text(
        request(tmp_path, sheet(MANDARIN), stem, language="zh", knobs=frozenset({Knob.LINE_SYNC}))
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
    """Another song's Mandarin on this song's clock: the shape the review rated HIGH, because on this lane
    the lift cannot refuse it. It declines for want of a gate rather than being judged — the honest answer,
    and the one that cannot publish a wrong text as word timings."""
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem = sung_stem(tmp_path)
    out = Reporter()
    steps = impl(tmp_path, reporter=out, aligner=NamingAligner(singing(stem), ZH_BUNDLE))
    assert await steps.time_text(request(tmp_path, sheet(WRONG_MANDARIN), stem, language="zh")) is None
    assert any("may time LINES but not WORDS" in why for why in out.reasons)


# ── the windowed engine ───────────────────────────────────────────────────────────────────────────────


async def test_a_windowed_aligner_times_no_words_on_a_routed_bundle(tmp_path: Path) -> None:
    """The other word-timing exit, which W7 left open: an `Aligner` with no `emissions` reads no matrix, so
    no lift can be measured on any bundle — and every calibration row is an English bundle's. A routed
    language therefore declines here too, and the English default keeps the behaviour it was measured on."""
    stem = sung_stem(tmp_path)
    routed = WindowedAligner()
    out = Reporter()
    got = await impl(tmp_path, reporter=out, aligner=routed).time_text(
        request(tmp_path, sheet(MANDARIN), stem, language="zh")
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
    `h3-ungated-words` is the control that restores the pre-W8 behaviour for a measurement."""
    stem = sung_stem(tmp_path)
    heard = await impl(tmp_path, reporter=Reporter(), aligner=WindowedAligner()).time_text(
        request(tmp_path, sheet(MANDARIN, tier=Tier.ASR), stem, language="zh")
    )
    assert isinstance(heard, TimedDoc) and heard.timing == "word"

    control = await impl(
        tmp_path,
        reporter=Reporter(),
        aligner=WindowedAligner(),
        experiments=frozenset({"h3-ungated-words"}),
    ).time_text(request(tmp_path, sheet(MANDARIN), stem, language="zh"))
    assert isinstance(control, TimedDoc), "the control arm is the only way to read this lane end to end"


# ── the TV can read it: display-only romanisation ─────────────────────────────────────────────────────


def romanizer_of(said: dict[str, str]) -> object:
    """An `Adapters.romanizer` factory over a lookup table: this test is about the PUBLISHED FIELD, not
    about any backend's transliteration (`tests/test_romanize.py` reads the real ones)."""
    return lambda _language: (lambda text: said[text]) if said else None


async def test_a_published_cjk_line_carries_its_romanisation_as_an_extra_field(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stage 0's other half: the line document publishes, and each line brings a second script the TV may
    show under it. DISPLAY-ONLY — the text is unchanged, the timings are unchanged, and the romanisation
    reaches no target sequence (XA-19; docs/arch/04-alignment.md §11.2)."""
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem = sung_stem(tmp_path)
    said = {line: f"r:{index}" for index, line in enumerate(MANDARIN)}
    steps = impl(
        tmp_path,
        reporter=Reporter(),
        aligner=NamingAligner(singing(stem), ZH_BUNDLE),
        romanizer=romanizer_of(said),
    )
    lines = await steps.time_text(
        request(tmp_path, sheet(MANDARIN), stem, language="zh", knobs=frozenset({Knob.LINE_SYNC}))
    )
    assert isinstance(lines, TimedDoc), lines
    published = json.loads((tmp_path / lines.ref).read_text(encoding="utf-8"))
    assert [line["text"] for line in published["lines"]] == list(MANDARIN), "the original text, untouched"
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
            request(tmp_path, sheet(MANDARIN), stem, language="zh", knobs=frozenset({Knob.LINE_SYNC}))
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


def test_the_shipped_worker_wires_the_factory_and_not_one_romaniser() -> None:
    """The language is a per-document fact, so the composition root hands over the FACTORY — and each
    backend is built on first use, uroman's tables costing ~2 s."""
    from encore_worker import __main__ as root

    assert root.build_adapters(Config(), device="cpu").romanizer is romanize.build_romanizer
