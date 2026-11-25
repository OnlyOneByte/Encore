"""A whisper transcript that is not words is withheld; the song gets the honest no-lyrics state (#1288)."""

from __future__ import annotations

import json
import pathlib

from encore_worker import __main__ as main
from encore_worker.domain.lyrics.babble import BABBLE_SHARE, babble, babble_share
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.host.config import Config
from encore_worker.steps.records import TIMING_WORD, TextRef
from encore_worker.workflows.align import run_align
from tests.test_align_flow import CLEAN, JOB, Fake, asr_text

BABBLE = json.loads((pathlib.Path(__file__).parent / "babble_transcript.json").read_text(encoding="utf-8"))

#: Real sung lines the rule must keep: chains, elongations and scripts written without spaces.
REAL = (
    "Come and fly away with me",
    "La-la-la-la-la-la-la-la-la-la-la-la-la",
    "Wo-oh-oh-oh-oh-oh-oh-oh Woh-oh-oh-oh-oh-oh",
    "Nooooooooooooooooooooooooo",
    "无法成为六边形战士的我们让你快乐也是件了不起的事",
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


def test_the_bench_transcript_is_babble_and_real_lines_are_not() -> None:
    assert babble_share(BABBLE["lines"]) > 0.85
    assert babble(BABBLE["lines"]) is not None
    assert babble_share(REAL) < BABBLE_SHARE
    assert babble(REAL) is None
    assert babble([]) is None


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
