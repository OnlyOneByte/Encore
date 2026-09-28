"""The global engine's lexical gate (W3, review §3 item 4 / H3): the lift decides a word document's text.

Through the real `time_text` on the CTC fixture (`tests/ctc_fixture.py`: an exact Viterbi, frame-for-frame
torchaudio's kernel on these matrices), with the emission matrix and the wavs the envelope reads built
SEPARATELY, so a test can make the two gates disagree:

  * words the stem does not sing are REFUSED before anything is repaired, although the envelope gate — which
    scores our own forced decode, pulled onto the voiced frames whatever the words — passes them (H3);
  * on a stem the lift REPLACES the envelope gate wherever it measured the text: a right text the envelope
    refuses publishes;
  * on the mix (no stem) the envelope still gates beside the lift's floor, unless `h3-mix-lift-alone` is on;
  * the doubt band publishes every line `low` and the document `medium`;
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
from dataclasses import dataclass, field
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


def silent_wav(path: Path, duration: float) -> str:
    """Near silence: what the envelope reads where nothing is sung."""
    sf.write(path, np.random.default_rng(2).normal(0.0, 0.002, int(duration * RATE)), RATE)
    return str(path)


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
) -> Run:
    """`texts` (on the song's own spans when `timed`, line for line) against a song that SINGS `UNIQUE`: the
    target's matrix always sings it; its wav does when `envelope_hears`. `stem=False` aligns on the mix."""
    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", decoder)
    sung = sung_matrix(UNIQUE, DIC, UNIQUE_DURATION)
    target_wav = (
        sung_wav(tmp_path / "target.wav", UNIQUE, UNIQUE_DURATION, seed=0)
        if envelope_hears
        else silent_wav(tmp_path / "target.wav", UNIQUE_DURATION)
    )
    if stem:
        mix = sung_wav(tmp_path / "mix.wav", UNIQUE, UNIQUE_DURATION, seed=1)
        audio = AudioRef(path=mix, vocals_path=target_wav, duration_sec=UNIQUE_DURATION)
        aligner = PathAligner({target_wav: sung, mix: sung})
    else:
        audio = AudioRef(path=target_wav, vocals_path=None, duration_sec=UNIQUE_DURATION)
        aligner = PathAligner({target_wav: sung})
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


def test_a_right_text_the_envelope_gate_refuses_publishes_on_a_stem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The envelope reads nothing where the matrix sings (on the bench: rap-god drop20, never-be-alone
    credit and 6 drop50 sheets, right texts the envelope refused at W1). On a stem the lift decided."""
    run = attempt(tmp_path, monkeypatch, envelope_hears=False)
    assert isinstance(run.got, TimedDoc), run.got
    assert "not gating: the lift is" in run.verdict
    assert not any(note[3] == "declined" for note in run.notes)


# ── the mix: the envelope gate stays beside the floor ─────────────────────────────────────────────────


def test_on_the_mix_the_envelope_gate_still_refuses_beside_the_lift(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run = attempt(tmp_path, monkeypatch, stem=False, envelope_hears=False)
    assert isinstance(run.got, Refused), run.got
    assert run.got.report.refused is not None and run.got.report.refused.startswith("envelope gate refused")


def test_the_mix_lift_alone_arm_drops_the_envelope_gate_there(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run = attempt(
        tmp_path, monkeypatch, stem=False, envelope_hears=False, experiments=frozenset({"h3-mix-lift-alone"})
    )
    assert isinstance(run.got, TimedDoc), run.got
    assert "not gating: the lift is" in run.verdict


def test_on_the_mix_words_under_the_floor_are_refused_where_the_envelope_passes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run = attempt(tmp_path, monkeypatch, texts=UNSUNG, stem=False)
    assert isinstance(run.got, Refused), run.got
    assert run.got.report.refused is not None
    assert f"below {lexical.BANDS.mix_floor} on the mix" in run.got.report.refused


def test_on_the_mix_the_sung_words_pass_both_gates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    run = attempt(tmp_path, monkeypatch, stem=False)
    assert isinstance(run.got, TimedDoc), run.got
    assert "lexical lift +" in run.verdict and "not gating" not in run.verdict


# ── the doubt band ─────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("stem", [True, False], ids=["stem", "mix"])
def test_the_doubt_band_publishes_every_line_low_and_the_document_medium(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stem: bool
) -> None:
    """The fixture's sung text lifts +15; the band is moved over it (read at call time)."""
    wide = lexical.Bands(model="test", refuse_below=0.2, ok_from=1e3, mix_floor=0.15, mix_ok_from=1e3)
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


# ── exemptions and faults: the envelope gate decides ───────────────────────────────────────────────────


def test_a_text_under_the_letter_minimum_keeps_the_envelope_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two sung lines (25 letters): too few orders for the contrast to mean anything. Where the envelope
    hears the singing it publishes, saying no lexical check ran; where it hears nothing it refuses."""
    run = attempt(tmp_path, monkeypatch, texts=SHORT)
    assert isinstance(run.got, TimedDoc), run.got
    assert f"no lexical check: under {lexical.MIN_LETTERS} alignable letters" in run.verdict
    assert "not gating" not in run.verdict

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


def raising_after(calls: int, error: Exception) -> Decode:
    """The fixture's decoder, raising `error` from call `calls + 1` on (generate's decode is the first)."""
    seen = [0]

    def decode(log_probs: object, targets: Sequence[int]) -> tuple[list[int], list[float]]:
        seen[0] += 1
        if seen[0] > calls:
            raise error
        return ctc_viterbi(log_probs, targets)

    return decode


def test_a_lexical_check_whose_decode_raised_leaves_the_envelope_gate_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An untimed text (no repair decodes after the lift's): the lift's own decode raises a plain error, so
    the envelope gate decides, and the verdict note carries the `no lexical check: it raised` the bench
    scores as an ERROR row (`e2e.FAULT_LEXICAL`)."""
    run = attempt(tmp_path, monkeypatch, timed=False, decoder=raising_after(1, ValueError("refused targets")))
    assert isinstance(run.got, TimedDoc), run.got
    assert "no lexical check: it raised ValueError: refused targets" in run.verdict
    assert "not gating" not in run.verdict


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
    published, every line `low`, the document `low`, and the reason on the trail once."""
    pasted: dict[str, object] = {"pinnedText": "\n".join(UNSUNG)}
    run = attempt(tmp_path, monkeypatch, texts=UNSUNG, timed=False, params=pasted)
    assert isinstance(run.got, TimedDoc), run.got
    assert run.got.confidence == "low"
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
