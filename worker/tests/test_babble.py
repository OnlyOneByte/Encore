"""A whisper transcript that is not words is withheld; the song gets the honest no-lyrics state (#1288)."""

from __future__ import annotations

import json
import pathlib

import pytest

from encore_worker import __main__ as main
from encore_worker.domain.lyrics.babble import BABBLE_SHARE, babble, babble_share
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.host.config import Config
from encore_worker.steps.records import TIMING_WORD, TextRef
from encore_worker.workflows.align import run_align
from tests.test_align_flow import CLEAN, JOB, Fake, asr_text

BABBLE = json.loads((pathlib.Path(__file__).parent / "babble_transcript.json").read_text(encoding="utf-8"))

#: Real sung lines with no run at all: words, hyphenated chains, and a script written without spaces.
WORDS = (
    "Come and fly away with me",
    "La-la-la-la-la-la-la-la-la-la-la-la-la",
    "Wo-oh-oh-oh-oh-oh-oh-oh Woh-oh-oh-oh-oh-oh",
    "无法成为六边形战士的我们让你快乐也是件了不起的事",
)

#: Unspaced chants: each one is a run by itself, so a transcript of nothing else is withheld.
CHANTS = (
    "啦" * 21,
    "ら" * 21,
    "ลา" * 11,
    "La" + "la" * 10,
    "N" + "o" * 25,
    "にゃにゃにゃーにゃにゃにゃーにゃにゃにゃーにゃにゃー",
)


def heard(lines: list[str], label: str = "asr:vocals") -> TextRef:
    return TextRef(
        tier=Tier.ASR,
        label=label,
        segments=tuple({"start": float(n), "end": n + 0.9, "text": text} for n, text in enumerate(lines)),
        timing=TIMING_WORD,
        language=BABBLE["language"],
    )


def test_the_bench_transcript_is_babble() -> None:
    assert babble_share(BABBLE["lines"]) > 0.85
    assert babble(BABBLE["lines"]) is not None
    assert babble([]) is None


@pytest.mark.parametrize("line", WORDS)
def test_a_line_of_words_holds_no_run(line: str) -> None:
    assert babble_share([line]) == 0.0


@pytest.mark.parametrize("line", CHANTS)
def test_an_unspaced_chant_is_all_run(line: str) -> None:
    assert babble_share([line]) == 1.0


def test_a_song_with_a_chant_passes_on_the_share() -> None:
    assert babble([*WORDS, CHANTS[0]]) is None


def test_a_transcript_dominated_by_a_chant_is_withheld() -> None:
    lines = ["我爱你", "你好吗", "啦" * 21]
    assert babble_share(lines) >= BABBLE_SHARE
    assert babble(lines) is not None


async def test_a_babbled_transcript_is_not_published_and_says_why() -> None:
    fake = Fake(transcribed=heard(BABBLE["lines"]), transcribed_on_mix=None, reports=[CLEAN])
    outcome = await run_align(JOB, fake)

    assert outcome.no_lyrics is True
    assert fake.published is None and fake.placed == []
    assert not any(c.startswith("time_text") for c in fake.calls), "babble is never timed"
    assert fake.calls.count("transcribe:mix") == 1, "the mix gets its turn, as for a silent stem"
    assert outcome.lyrics_note == "asr-babble"
    assert "babble" in outcome.why
    assert main._align_facts(JOB, Config(), outcome)["lyricsNote"] == "asr-babble"


async def test_the_mix_still_publishes_when_only_the_stem_babbled() -> None:
    fake = Fake(transcribed=heard(BABBLE["lines"]), transcribed_on_mix=asr_text("asr:mix"), reports=[CLEAN])
    outcome = await run_align(JOB, fake)

    assert outcome.published is not None and outcome.published.label == "asr:mix"
    assert outcome.lyrics_note is None
    assert "lyricsNote" not in main._align_facts(JOB, Config(), outcome)


async def test_heard_nothing_carries_no_note() -> None:
    outcome = await run_align(JOB, Fake(transcribed=None, transcribed_on_mix=None))
    assert outcome.no_lyrics is True and outcome.lyrics_note is None
