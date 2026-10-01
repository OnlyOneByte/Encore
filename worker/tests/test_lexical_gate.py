"""The global engine's lexical gate (W3, review §3 item 4 / H3): the lift decides a word document's text.

Through the real `time_text` on the CTC fixture (`tests/ctc_fixture.py`: an exact Viterbi, frame-for-frame
torchaudio's kernel on these matrices), with the emission matrix and the wavs the envelope reads built
SEPARATELY, so a test can make the two gates disagree:

  * words the stem does not sing are REFUSED before anything is repaired, although the envelope gate — which
    scores our own forced decode, pulled onto the voiced frames whatever the words — passes them (H3);
  * on a stem the lift REPLACES the envelope gate wherever it measured the text: a right text the envelope
    refuses publishes;
  * on the mix (no stem) the same rule holds since W4 review r1 — the floor refuses and the envelope fit is
    reported — with `h3-mix-envelope` (W3's default) and `h3-mix-floor` as the two controls;
  * the doubt band publishes every line `low`, the document `medium` and the words UNVOUCHED
    (`TimedDoc.vouched` -> core's `textConfidence` low), and so does a pin the gate would have refused;
  * a cognate translation is NOT caught, and on this path publishes a word document with `high` lines;
  * the exemptions (the ASR tier, a text under `lexical.MIN_LETTERS`) keep the envelope gate, and so does a
    lift whose decode raised; an `InfraFault` in it fails the job;
  * a pin is never judged a wrong text: refused words publish, graded low.

The fixture scores letters (a sung char at 0.9), so its lifts are far larger than a real model's (+15 here,
+0.36..+4.3 on the bench's stems for right texts): what these pin is the wiring, and `lexical.BANDS` is moved
where a test needs a band the fixture cannot reach.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from encore_worker.adapters.ports import InfraFault
from encore_worker.domain.lyrics import lexical
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.domain.lyrics.report import Engine
from encore_worker.host.config import Config
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import AudioRef, JobRef, Refused, TextRef, TimedDoc, TimeRequest
from tests.ctc_fixture import Decode, ctc_viterbi, sung_matrix
from tests.test_align_provenance import DIC, RATE, UNIQUE, UNIQUE_DURATION, PathAligner, TrailSpy, sung_wav
from tests.test_lexical import COGNATE_GERMAN

SUNG = [text for text, _s, _e in UNIQUE]
SPANS = [(start, end) for _t, start, end in UNIQUE]

#: Eight lines of words the fixture's song does not sing (French: the fixture scores letters, so a text in
#: a cognate-heavy language would share the sung letters in order), 98 alignable letters.
UNSUNG = [
    "viens et envole toi",
    "avec moi ce soir",
    "sur l'eau d'argent",
    "ramene moi chez moi",
    "les etoiles sont sorties",
    "lumiere du matin sur le fleuve",
    "tiens bon la nuit",
    "ne la lache jamais",
]

#: Two sung lines: 25 alignable letters, under `lexical.MIN_LETTERS`.
SHORT = SUNG[:2]


@dataclass
class Run:
    """One `time_text` attempt's result, its trail and the aligner's emission calls."""

    got: TimedDoc | Refused | None
    notes: list[tuple[Any, ...]]
    asked: list[str]
    media: Path
    states: list[tuple[Any, ...]] = field(default_factory=list)

    @property
    def verdict(self) -> str:
        """The last `align-global` note's reason: the verdict note, or the decline."""
        return str(self.notes[-1][4])

    def lines(self) -> list[dict[str, Any]]:
        assert isinstance(self.got, TimedDoc), self.got
        lines: list[dict[str, Any]] = json.loads((self.media / self.got.ref).read_text())["lines"]
        return lines


def _fresh(tmp_path: Path, name: str) -> Path:
    """A second media dir under the same tmp: two attempts in one test must not share written documents."""
    made = tmp_path / name
    made.mkdir()
    return made


def silent_wav(path: Path, duration: float) -> str:
    """Near silence: what the envelope reads where nothing is sung."""
    sf.write(path, np.random.default_rng(2).normal(0.0, 0.002, int(duration * RATE)), RATE)
    return str(path)


@dataclass(frozen=True)
class NamedEmissions:
    """A matrix that NAMES the bundle it came from, as `ml.Emissions` does (W3 review r2's model guard)."""

    log_probs: Any
    frame_sec: float
    dictionary: dict[str, int]
    model: str

    @property
    def frames(self) -> int:
        return len(self.log_probs)


class NamingAligner:
    """`PathAligner` whose matrices name `model`. Delegates, so `asked` stays the one emission-pass ledger."""

    def __init__(self, inner: PathAligner, model: str) -> None:
        self._inner = inner
        self._model = model

    @property
    def asked(self) -> list[str]:
        return self._inner.asked

    def emissions(self, path: str, language: str) -> NamedEmissions:
        got = self._inner.emissions(path, language)
        return NamedEmissions(
            log_probs=got.log_probs, frame_sec=got.frame_sec, dictionary=got.dictionary, model=self._model
        )


def attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    texts: Sequence[str] = SUNG,
    timed: bool = True,
    tier: Tier = Tier.CANDIDATE,
    stem: bool = True,
    envelope_hears: bool = True,
    decoder: Decode = ctc_viterbi,
    experiments: frozenset[str] = frozenset(),
    params: dict[str, object] | None = None,
    named_model: str | None = None,
    read_audio: list[str] | None = None,
) -> Run:
    """`texts` (on the song's own spans when `timed`, line for line) against a song that SINGS `UNIQUE`: the
    target's matrix always sings it; its wav does when `envelope_hears`. `stem=False` aligns on the mix.
    `named_model` makes the matrices name a bundle (the model guard); `read_audio` collects every path
    `load_audio_mono_16k` is asked for, in order, so a test can see what a refusal did NOT pay for."""
    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", decoder)
    if read_audio is not None:
        real = ml.load_audio_mono_16k

        def watched(path: str) -> Any:
            read_audio.append(path)
            return real(path)

        monkeypatch.setattr(ml, "load_audio_mono_16k", watched)
    sung = sung_matrix(UNIQUE, DIC, UNIQUE_DURATION)
    target_wav = (
        sung_wav(tmp_path / "target.wav", UNIQUE, UNIQUE_DURATION, seed=0)
        if envelope_hears
        else silent_wav(tmp_path / "target.wav", UNIQUE_DURATION)
    )
    if stem:
        mix = sung_wav(tmp_path / "mix.wav", UNIQUE, UNIQUE_DURATION, seed=1)
        audio = AudioRef(path=mix, vocals_path=target_wav, duration_sec=UNIQUE_DURATION)
        paths = PathAligner({target_wav: sung, mix: sung})
    else:
        audio = AudioRef(path=target_wav, vocals_path=None, duration_sec=UNIQUE_DURATION)
        paths = PathAligner({target_wav: sung})
    aligner: Any = paths if named_model is None else NamingAligner(paths, named_model)
    trail = TrailSpy()
    impl = AlignStepsImpl(
        config=Config(align_experiments=experiments), adapters=Adapters(aligner=aligner), reporter=trail
    )
    segments = tuple(
        {"text": text, **({"start": a, "end": b} if timed else {})}
        for text, (a, b) in zip(texts, [*SPANS, *SPANS][: len(texts)], strict=True)
    )
    request = TimeRequest(
        job=JobRef(job_id="j1", media_id="m1", media_dir=str(tmp_path), source_uri=None, params=params or {}),
        text=TextRef(tier=tier, label="test", segments=segments, timing="line" if timed else "none"),
        audio=audio,
        language="en",
    )
    got = asyncio.run(impl.time_text(request))
    notes = [s for s in trail.states if s[1] == "align-global"]
    return Run(got=got, notes=notes, asked=aligner.asked, media=tmp_path, states=trail.states)


# ── on a stem the lift is the gate ─────────────────────────────────────────────────────────────────────


def test_the_sung_words_pass_and_the_verdict_note_carries_their_lift(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run = attempt(tmp_path, monkeypatch)
    assert isinstance(run.got, TimedDoc) and run.got.confidence == "high"
    assert "lexical lift +" in run.verdict and "not gating: the lift is" in run.verdict
    assert any(line["confidence"] == "high" for line in run.lines())


def test_words_the_stem_does_not_sing_are_refused_before_anything_is_repaired(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """H3 on the fixture: another text on this song's own clock (a same-video caption track in other words).
    Forced through a matrix that sings something else, its letters are pulled onto the voiced frames, so the
    envelope gate — as the exempt ASR run shows on the very same words — passes it. The lift does not: the
    text is `Refused` (a verdict that ends it), and no repair ran (no mix pass for R4, no window decode)."""
    run = attempt(tmp_path, monkeypatch, texts=UNSUNG)
    assert isinstance(run.got, Refused), run.got
    why = run.got.report.refused
    assert why is not None and why.startswith("lexical gate refused: lexical lift ")
    assert f"below {lexical.BANDS.refuse_below} on the stem" in why
    assert run.got.report.engine is Engine.GLOBAL
    assert run.notes[-1][3] == "declined" and run.verdict == why, "the trail and the verdict agree"
    assert run.asked == [str(tmp_path / "target.wav")], "one emission pass: nothing was repaired"
    assert not list(tmp_path.rglob("*-word.json")), "a refused text writes nothing"

    (tmp_path / "asr").mkdir()
    exempt = attempt(tmp_path / "asr", monkeypatch, texts=UNSUNG, tier=Tier.ASR)
    assert isinstance(exempt.got, TimedDoc), "the envelope gate passes these very words"
    assert "no lexical check: a transcript of this recording" in exempt.verdict


def test_a_refused_text_pays_for_no_audio_decode_and_no_publishing_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W3 review r2, the cost half. The gate needs the matrix and the text only, yet it used to be read after
    `generate`'s decode, after an ffmpeg decode of the WHOLE target and after an envelope pass over the whole
    signal — so every wrong text (now the normal refusal: 640/640 in the sweep) paid for all three before
    being refused, three times over on a song with three wrong candidates. Read first, it pays for the
    emission pass and four CTC decodes. Pinned by what did NOT happen: no audio was read, and the only
    decodes were the lift's four."""
    read: list[str] = []
    decodes: list[int] = []

    def counting(log_probs: object, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
        decodes.append(len(targets))
        return ctc_viterbi(log_probs, targets, blank)

    run = attempt(tmp_path, monkeypatch, texts=UNSUNG, decoder=counting, read_audio=read)
    assert isinstance(run.got, Refused), run.got
    assert read == [], "no ffmpeg decode of the target, so no envelope pass either"
    assert len(decodes) == lexical.SHUFFLES + 1, "the text's own path and its shuffles, nothing else"

    kept: list[str] = []
    published = attempt(_fresh(tmp_path, "sung"), monkeypatch, read_audio=kept)
    assert isinstance(published.got, TimedDoc) and kept, "a text that passes still reads the audio"


def test_a_right_text_the_envelope_gate_refuses_publishes_on_a_stem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The envelope reads nothing where the matrix sings (on the bench: rap-god drop20, never-be-alone
    credit and 6 drop50 sheets, right texts the envelope refused at W1). On a stem the lift decided."""
    run = attempt(tmp_path, monkeypatch, envelope_hears=False)
    assert isinstance(run.got, TimedDoc), run.got
    assert "not gating: the lift is" in run.verdict
    assert not any(note[3] == "declined" for note in run.notes)


# ── the mix: the lift's floor is the verdict, the envelope gate is a control ───────────────────────────


def test_on_the_mix_the_lift_replaces_the_envelope_gate_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W4 review r1's flip, in one case: a text the envelope gate refuses and the lift vouches for PUBLISHES
    on the mix, exactly as on a stem.

    The flip is the stemless bench mode's (`e2e.py --no-stem`, 32 songs x 4 claim modes + 2 wrong donors):
    the envelope gate refuses 51 of the 128 right-text cases where the floor refuses 37, and admits 27 of 64
    wrong texts where the floor admits 0. Nine of its refusals lift above the floor — Tom_Orlando +1.465
    (72/72 line starts within ±500 ms once published), Rxbyn +1.081, Ridgway +1.061 — and this is that shape.
    """
    run = attempt(tmp_path, monkeypatch, stem=False, envelope_hears=False)
    assert isinstance(run.got, TimedDoc), run.got
    assert "not gating: the lift is" in run.verdict


def test_the_mix_envelope_control_arm_makes_the_envelope_gate_the_verdict_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`h3-mix-envelope` is W3's default kept as the A/B control for the flip, not a failed arm."""
    run = attempt(
        tmp_path, monkeypatch, stem=False, envelope_hears=False, experiments=frozenset({"h3-mix-envelope"})
    )
    assert isinstance(run.got, Refused), run.got
    assert run.got.report.refused is not None and run.got.report.refused.startswith("envelope gate refused")


def test_on_the_mix_words_under_the_floor_are_refused_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other half of the flip: a sub-floor lift on the mix is a REFUSAL now, as it is on a stem.

    W3 published it as the doubt band because the cost lands where nothing follows a refusal (NextText, and
    the LINE_SYNC rung declines a stemless song) and the floor refuses 7 of the corpus's 32 truth texts. The
    measured alternative refuses 10 of them AND admits 27 of 64 wrong texts, so the doubt band is the control
    arm's behaviour now (`lexical.BANDS`, MIX).
    """
    run = attempt(tmp_path, monkeypatch, texts=UNSUNG, stem=False)
    assert isinstance(run.got, Refused), run.got
    assert run.got.report.refused is not None
    assert f"below {lexical.BANDS.mix_floor} on the mix" in run.got.report.refused


def test_the_mix_envelope_control_arm_publishes_the_same_words_as_a_doubt_band(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W3's behaviour, now reachable only through the control: every line `low`, the document `medium`, and
    core told the words are not vouched for (`textConfidence` low)."""
    run = attempt(tmp_path, monkeypatch, texts=UNSUNG, stem=False, experiments=frozenset({"h3-mix-envelope"}))
    assert isinstance(run.got, TimedDoc), run.got
    assert (run.got.confidence, run.got.vouched) == ("medium", False)
    assert {line["confidence"] for line in run.lines()} == {"low"}
    assert f"below {lexical.BANDS.mix_floor} on the mix, which the control arm does not refuse on" in (
        run.verdict
    )
    assert not any(note[3] == "declined" for note in run.notes)


def test_the_mix_floor_arm_keeps_both_gates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`h3-mix-floor` is W3's FIRST shipping: the floor refuses AND the envelope gate still does, so it pays
    both costs (54 of the stemless mode's 128 right texts published, against the default's 91)."""
    unsung = attempt(tmp_path, monkeypatch, texts=UNSUNG, stem=False, experiments=frozenset({"h3-mix-floor"}))
    assert isinstance(unsung.got, Refused), unsung.got
    assert unsung.got.report.refused is not None
    assert f"below {lexical.BANDS.mix_floor} on the mix" in unsung.got.report.refused
    deaf = attempt(
        _fresh(tmp_path, "deaf"),
        monkeypatch,
        stem=False,
        envelope_hears=False,
        experiments=frozenset({"h3-mix-floor"}),
    )
    assert isinstance(deaf.got, Refused), deaf.got
    assert deaf.got.report.refused is not None
    assert deaf.got.report.refused.startswith("envelope gate refused"), "the envelope gate is kept beside it"


def test_both_mix_arms_together_mean_both_gates_not_the_envelope_one_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W4 review r2 (correctness-7): `h3-mix-envelope` used to win outright, so a run with BOTH names set
    measured the ENVELOPE-GATE-ONLY configuration and recorded both names beside it — a third configuration
    published under the stricter one's name, which is exactly the mislabelling `Config.ALIGN_EXPERIMENTS`
    refuses unknown names to prevent.

    `h3-mix-floor` is the superset (both gates), so the pair MUST behave as `h3-mix-floor` alone: a sub-floor
    text is refused by the floor, and a text the envelope cannot hear is refused by the envelope gate.
    """
    both = frozenset({"h3-mix-envelope", "h3-mix-floor"})
    unsung = attempt(tmp_path, monkeypatch, texts=UNSUNG, stem=False, experiments=both)
    assert isinstance(unsung.got, Refused), unsung.got
    assert unsung.got.report.refused is not None
    assert f"below {lexical.BANDS.mix_floor} on the mix" in unsung.got.report.refused, (
        "with both names set the floor must still refuse: `h3-mix-envelope` alone would publish this"
    )
    floor_only = attempt(
        _fresh(tmp_path, "flooronly"),
        monkeypatch,
        texts=UNSUNG,
        stem=False,
        experiments=frozenset({"h3-mix-floor"}),
    )
    assert isinstance(floor_only.got, Refused)
    assert floor_only.got.report.refused == unsung.got.report.refused, "the pair IS `h3-mix-floor`"
    deaf = attempt(
        _fresh(tmp_path, "deafboth"), monkeypatch, stem=False, envelope_hears=False, experiments=both
    )
    assert isinstance(deaf.got, Refused), deaf.got
    assert deaf.got.report.refused is not None
    assert deaf.got.report.refused.startswith("envelope gate refused"), "and the envelope gate is kept too"


def test_on_a_stem_words_under_the_floor_are_still_refused_with_no_arm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The mix's doubt is the MIX's: on a stem the populations do not overlap (`lexical.BANDS`), so the
    floor is the verdict it was calibrated as, with no arm in sight."""
    run = attempt(tmp_path, monkeypatch, texts=UNSUNG, experiments=frozenset({"h3-mix-floor"}))
    assert isinstance(run.got, Refused), run.got
    plain = attempt(_fresh(tmp_path, "plain"), monkeypatch, texts=UNSUNG)
    assert isinstance(plain.got, Refused) and plain.got.report.refused == run.got.report.refused


def test_on_the_mix_the_sung_words_pass_and_the_envelope_fit_is_only_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The trail still carries the envelope fit on the mix — it says "not gating: the lift is" (W4 review
    r1), the same sentence a stem gets, because a fit that decides nothing is still evidence to read."""
    run = attempt(tmp_path, monkeypatch, stem=False)
    assert isinstance(run.got, TimedDoc), run.got
    assert "lexical lift +" in run.verdict and "not gating: the lift is" in run.verdict


# ── the doubt band ─────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("stem", [True, False], ids=["stem", "mix"])
def test_the_doubt_band_publishes_every_line_low_and_the_document_medium(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stem: bool
) -> None:
    """The fixture's sung text lifts +15; the band is moved over it (read at call time). The GRADING is the
    same on both targets: no `high` line, the document `medium`."""
    wide = lexical.Bands(
        model="test",
        refuse_below=0.2,
        ok_from=1e3,
        mix_floor=0.15,
        mix_ok_from=1e3,
        line_sync_min_agreement=0.5,
        margin_floor_nats=10.0,
    )
    monkeypatch.setattr(lexical, "BANDS", wide)
    run = attempt(tmp_path, monkeypatch, stem=stem)
    assert isinstance(run.got, TimedDoc), run.got
    assert run.got.confidence == "medium"
    assert {line["confidence"] for line in run.lines()} == {"low"}
    floor = 0.2 if stem else 0.15
    assert (
        f"in the doubt band [{floor}, 1000.0) on the {'stem' if stem else 'mix'}: every line low"
        in run.verdict
    )
    assert "0/8 lines high" in run.verdict


def test_the_stems_doubt_band_withholds_the_words_standing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """On a STEM the doubt band is doubt about the WORDS: `vouched=False`, which core sends as
    `textConfidence` low, so a document a gate passed outranks it (W3 r1). The band holds 2 right texts of
    the corpus's 448 and no wrong one, which is what makes the demotion affordable there."""
    wide = lexical.Bands(
        model="test",
        refuse_below=0.2,
        ok_from=1e3,
        mix_floor=0.15,
        mix_ok_from=1e3,
        line_sync_min_agreement=0.5,
        margin_floor_nats=10.0,
    )
    monkeypatch.setattr(lexical, "BANDS", wide)
    run = attempt(tmp_path, monkeypatch)
    assert isinstance(run.got, TimedDoc) and run.got.vouched is False
    assert "the band grades here" not in run.verdict, "on a stem the band IS the words' verdict"


def test_the_mix_doubt_band_grades_without_stripping_the_words_standing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W3 review r2, the mix's half of the same band. `mix_ok_from` 0.6 was fitted to how AUDIBLE the words
    are, not to whether they are the right ones, and it holds 104 of the corpus's 192 right mix texts (15 of
    its 32 TRUTH texts). Sent as `vouched=False` it would tell core `textConfidence` low for most correct
    sheets of every stemless song — `isAuthoritativeText` false, `lyricsRank` 3, so any authoritative LINE
    document of an earlier job (4) displaces a correct word-timed sheet. So on the mix the band grades (every
    line `low`, the document `medium`) and the WORDS are still vouched for; only a sub-floor lift is not (see
    `test_on_the_mix_words_under_the_floor_are_a_doubt_band_not_a_refusal`)."""
    wide = lexical.Bands(
        model="test",
        refuse_below=0.2,
        ok_from=1e3,
        mix_floor=0.15,
        mix_ok_from=1e3,
        line_sync_min_agreement=0.5,
        margin_floor_nats=10.0,
    )
    monkeypatch.setattr(lexical, "BANDS", wide)
    run = attempt(tmp_path, monkeypatch, stem=False)
    assert isinstance(run.got, TimedDoc), run.got
    assert run.got.confidence == "medium", "the grading band still bites"
    assert run.got.vouched is True, "but nothing doubted these WORDS on the mix"
    assert "the band grades here; the words' verdict is the floor" in run.verdict


def test_the_sung_words_are_vouched_for(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The other side of the doubt band: above it nothing is withheld, so core reads the text's tier."""
    run = attempt(tmp_path, monkeypatch)
    assert isinstance(run.got, TimedDoc) and run.got.vouched is True


def test_a_cognate_translation_publishes_a_word_document_with_high_lines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE GATE'S KNOWN HOLE, on the path where it costs most (W3 review r1). A translation whose words keep
    the sung ones' letters in order lifts like a right text (`test_lexical`: German +1.98 on this fixture,
    French -0.12, the sung words +15.2), and no band separates it. Through the GLOBAL engine that is a WORD
    document graded normally — `high` lines, word-level highlighting — where the same text through the
    LINE_SYNC rung publishes lines all graded `low`. Pinned so the day a defence lands, this test turns
    around; `lexical`'s NOT COVERED paragraph is the record."""
    run = attempt(tmp_path, monkeypatch, texts=COGNATE_GERMAN, envelope_hears=False)
    assert isinstance(run.got, TimedDoc), "no gate refuses it: the envelope is replaced on a stem"
    assert run.got.timing == "word" and run.got.vouched is True
    assert any(line["confidence"] == "high" for line in run.lines()), "graded as a right text"
    assert "lexical lift +1.98" in run.verdict


# ── exemptions and faults: the envelope gate decides ───────────────────────────────────────────────────


def test_a_text_under_the_letter_minimum_keeps_the_envelope_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two sung lines (25 letters): too few orders for the contrast to mean anything. Where the envelope
    hears the singing it publishes, saying no lexical check ran; where it hears nothing it refuses.

    AND IT PUBLISHES UNVOUCHED (W3 review r2). The envelope gate is the only one that read it, and the
    envelope gate is not a wrong-text gate: it passed 152/320 bench wrong texts and 280/320 same-video wrong
    words. A stub sheet, a chorus-only lyric or a hook-only caption track is the reachable shape (~8 words),
    so `vouched=True` here would have handed core a claim no wrong-text gate ever looked at."""
    run = attempt(tmp_path, monkeypatch, texts=SHORT)
    assert isinstance(run.got, TimedDoc), run.got
    assert f"no lexical check: under {lexical.MIN_LETTERS} alignable letters" in run.verdict
    assert "not gating" not in run.verdict
    assert run.got.vouched is False, "no wrong-text gate read these words"

    deaf = tmp_path / "deaf"
    deaf.mkdir()
    refused = attempt(deaf, monkeypatch, texts=SHORT, envelope_hears=False)
    assert isinstance(refused.got, Refused), refused.got
    assert refused.got.report.refused is not None
    assert refused.got.report.refused.startswith("envelope gate refused")
    assert f"no lexical check: under {lexical.MIN_LETTERS}" in refused.got.report.refused, "why it decided"


def test_the_asr_tier_is_exempt_and_keeps_the_envelope_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A transcript's words were heard on this very audio: misheard, maybe, but never another song's."""
    run = attempt(tmp_path, monkeypatch, tier=Tier.ASR, envelope_hears=False)
    assert isinstance(run.got, Refused), "exempt from the lift, so the envelope gate still refuses"
    assert run.got.report.refused is not None and run.got.report.refused.startswith("envelope gate refused")

    heard = attempt(_fresh(tmp_path, "heard"), monkeypatch, tier=Tier.ASR)
    assert isinstance(heard.got, TimedDoc) and heard.got.vouched is True, (
        "the ONE unmeasured text that stays vouched: the audio is where its words came from (W3 r2). Its "
        "tier sends `textConfidence` low regardless"
    )


def test_a_matrix_from_a_model_with_no_calibration_row_is_not_measured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W3 review r2, a TABLE since W4b. The thresholds are ONE bundle's calibration each, and the emission
    model is chosen per LANGUAGE (`ml.WhisperXAligner._aligner`; de/es/fr load wav2vec2-XLSR fine-tunes), so a
    German sheet would otherwise be judged terminally on a number `lift_gate.py` never measured. A matrix from
    a model with NO ROW is read as UNMEASURABLE: the envelope gate keeps the verdict, the reason names the
    model and the script that would fit it, and the words are not vouched for. Here the WRONG text passes,
    which is the price of not pretending to know."""
    run = attempt(tmp_path, monkeypatch, texts=UNSUNG, named_model="WAV2VEC2_LARGE_XLSR_53_DE")
    assert isinstance(run.got, TimedDoc), "the lift is a reading, not a verdict, on an uncalibrated matrix"
    assert run.got.vouched is False
    assert "no lexical check: no lexical calibration for WAV2VEC2_LARGE_XLSR_53_DE" in run.verdict
    assert "lift_gate.py --model WAV2VEC2_LARGE_XLSR_53_DE" in run.verdict

    named = attempt(
        _fresh(tmp_path, "named"), monkeypatch, texts=UNSUNG, named_model=lexical.BANDS.model, stem=True
    )
    assert isinstance(named.got, Refused), "a model WITH a row is measured as ever"


def test_a_second_calibrated_model_is_judged_by_its_own_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W4b: the point of a table is that two models can be gated at once, each on its own numbers. The fixture
    scores letters, so its unsung text lifts about 0 and its sung text +15: a row whose floor is 20 refuses
    BOTH, and the shipped row refuses only the unsung one — so a matrix naming the second model must be
    refused on a text the first publishes, with the second row's own floor in the reason."""
    strict = replace(lexical.BANDS, model="STRICTER_BUNDLE", refuse_below=20.0, ok_from=21.0)
    monkeypatch.setitem(lexical.CALIBRATED, strict.model, strict)
    sung = attempt(tmp_path, monkeypatch, named_model=lexical.BANDS.model)
    assert isinstance(sung.got, TimedDoc), "the shipped row publishes the sung words"
    other = attempt(_fresh(tmp_path, "strict"), monkeypatch, named_model=strict.model)
    assert isinstance(other.got, Refused), other.got
    assert other.got.report.refused is not None and "below 20.0 on the stem" in other.got.report.refused


def raising_after(calls: int, error: Exception) -> Decode:
    """The fixture's decoder, raising `error` from call `calls + 1` on. THE LIFT'S DECODES ARE FIRST since
    W3 review r2 moved the gate ahead of `generate`: call 1 is the text's own path, 2-4 its shuffles."""
    seen = [0]

    def decode(log_probs: object, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
        seen[0] += 1
        if seen[0] > calls:
            raise error
        return ctc_viterbi(log_probs, targets, blank)

    return decode


def raising_on(call: int, error: Exception) -> Decode:
    """The fixture's decoder, raising `error` on the `call`-th call only — so the LIFT's contrast fails
    (call 2 is its first shuffle) and the decode that publishes still runs."""
    seen = [0]

    def decode(log_probs: object, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
        seen[0] += 1
        if seen[0] == call:
            raise error
        return ctc_viterbi(log_probs, targets, blank)

    return decode


def test_a_lexical_check_whose_decode_raised_leaves_the_envelope_gate_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An untimed text (no repair decodes): the lift's contrast raises a plain error, so the envelope gate
    decides, and the verdict note carries the `no lexical check: it raised` the bench scores as an ERROR row
    (`e2e.FAULT_LEXICAL`). NOTHING VOUCHES for such a text either (W3 review r2): the words were not read."""
    run = attempt(tmp_path, monkeypatch, timed=False, decoder=raising_on(2, ValueError("refused targets")))
    assert isinstance(run.got, TimedDoc), run.got
    assert "no lexical check: it raised ValueError: refused targets" in run.verdict
    assert "not gating" not in run.verdict
    assert run.got.vouched is False


def test_an_infra_fault_in_the_lexical_check_fails_the_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The kernel gone mid-attempt is the machinery, not this text (review M7): raised, never a decline."""
    with pytest.raises(InfraFault, match="kernel gone"):
        attempt(tmp_path, monkeypatch, timed=False, decoder=raising_after(1, InfraFault("kernel gone")))


# ── a pin, and a replay ───────────────────────────────────────────────────────────────────────────────


def test_a_pin_the_lexical_gate_would_refuse_publishes_every_line_low(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A person chose these words, so they are not judged a wrong text (as the envelope gate treats a pin):
    published, every line `low`, the document `low`, and the reason on the trail once. `vouched` is False all
    the same — a person's choice is not a measurement, so core must not read the words as a claim (W3 r1)."""
    pasted: dict[str, object] = {"pinnedText": "\n".join(UNSUNG)}
    run = attempt(tmp_path, monkeypatch, texts=UNSUNG, timed=False, params=pasted)
    assert isinstance(run.got, TimedDoc), run.got
    assert run.got.confidence == "low" and run.got.vouched is False
    assert {line["confidence"] for line in run.lines()} == {"low"}
    kept = [note[4] for note in run.notes if note[3] == "pin-unvouched"]
    assert len(kept) == 1 and kept[0].startswith("lexical gate refused") and "a person chose" in kept[0]
    assert not any(note[3] == "declined" for note in run.notes)


def test_a_replayed_attempt_reads_the_same_lift(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The shuffles are seeded by the text (crc32), so a re-run step — a DBOS retry, a bench re-run — takes
    the same verdict on the same number."""
    first = attempt(tmp_path, monkeypatch, texts=UNSUNG)
    again_dir = tmp_path / "again"
    again_dir.mkdir()
    again = attempt(again_dir, monkeypatch, texts=UNSUNG)
    assert isinstance(first.got, Refused) and isinstance(again.got, Refused)
    assert first.got.report.refused == again.got.report.refused
