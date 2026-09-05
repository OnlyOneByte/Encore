"""The lyrics engines an align job carries: which model reads the words, how they get timestamps.

Two properties are pinned here rather than left to inspection, because both were real hazards while
these values were hardcoded:

  * an unknown token must fail AT THE BOUNDARY. Passed through, it reaches whisperx.load_model(),
    fails to resolve as a HuggingFace repo, and AsrSource swallows the exception — the tier declines
    and the song finishes with no words and nothing naming why.
  * changing the model must drop the CACHED transcriber AND the cached source list that holds it.
    Otherwise the log says one model and AsrSource keeps using the previous weights.
"""
from __future__ import annotations

import pytest

from src.lyrics.chain import (
    SOURCE_ASR,
    SOURCE_LRCLIB,
    TIMING_LINE,
    TIMING_NONE,
    TIMING_WORD,
    LyricsText,
)
from src.vocabulary import AsrModel, SyncMode, parse_asr_model, parse_sync_mode
from src.whisperx import WhisperXProcessor


class _FakeTranscriber:
    def transcribe(self, audio_path, language=None):  # pragma: no cover - never called here
        return {"segments": []}


# ── boundary parsing ────────────────────────────────────────────────────────────
def test_absent_asr_model_keeps_the_pre_setting_default():
    # An align job from a core that predates the setting must transcribe exactly as it always did.
    assert parse_asr_model(None) is AsrModel.BASE
    assert parse_asr_model("") is AsrModel.BASE


def test_absent_sync_mode_defaults_to_forced():
    assert parse_sync_mode(None) is SyncMode.FORCED


def test_every_whitelisted_token_round_trips():
    for m in AsrModel:
        assert parse_asr_model(m.value) is m
    for s in SyncMode:
        assert parse_sync_mode(s.value) is s


@pytest.mark.parametrize("bad", ["large", "base.en", "whisper-base", "distil-large-v3"])
def test_unknown_asr_model_raises_naming_the_valid_set(bad):
    with pytest.raises(ValueError) as e:
        parse_asr_model(bad)
    assert bad in str(e.value)
    assert "large-v3" in str(e.value)  # the message lists what IS accepted


def test_unknown_sync_mode_raises():
    with pytest.raises(ValueError):
        parse_sync_mode("word")  # a granularity, not a mode


def test_explicit_default_is_honoured_for_an_absent_value():
    # This is how a job with no params keeps the worker's own env fallback rather than resetting to base.
    assert parse_asr_model(None, AsrModel.SMALL) is AsrModel.SMALL
    assert parse_sync_mode(None, SyncMode.LINES) is SyncMode.LINES


# ── the processor adopting a job's engines ──────────────────────────────────────
def test_job_params_override_the_constructed_defaults():
    p = WhisperXProcessor(model="base", sync_mode="forced")
    p._adopt_job_engines({"asrModel": "small", "syncMode": "lines"})
    assert p._model == "small"
    assert p._sync_mode is SyncMode.LINES


def test_absent_params_leave_the_worker_env_fallback_alone():
    p = WhisperXProcessor(model="medium", sync_mode="lines")
    p._adopt_job_engines({})  # an older core sends neither
    assert p._model == "medium"
    assert p._sync_mode is SyncMode.LINES


def test_changing_the_model_drops_the_cached_transcriber_and_sources():
    p = WhisperXProcessor(model="base")
    p._transcriber = object()  # stand-in for a loaded model
    p._sources = ["built around the old transcriber"]
    p._adopt_job_engines({"asrModel": "small"})
    assert p._transcriber is None
    assert p._sources is None


def test_same_model_rebuilds_nothing():
    # The common case: every job carries the same global setting, so a reload per job would be pure
    # waste — multi-GB weights re-read for no change.
    p = WhisperXProcessor(model="base")
    loaded, sources = object(), ["chain"]
    p._transcriber, p._sources = loaded, sources
    p._adopt_job_engines({"asrModel": "base"})
    assert p._transcriber is loaded
    assert p._sources is sources


def test_an_injected_transcriber_is_never_replaced_by_a_wire_value():
    # Guards the tests themselves: if a job's model could swap an injected fake, a unit test would
    # start pulling real multi-GB weights.
    fake = _FakeTranscriber()
    p = WhisperXProcessor(transcriber=fake, model="base")
    p._adopt_job_engines({"asrModel": "large-v3"})
    assert p._model == "large-v3"  # the choice is still recorded
    assert p._transcriber is fake  # but the fake stands


def test_an_unknown_model_on_the_wire_fails_before_any_work():
    p = WhisperXProcessor(model="base")
    with pytest.raises(ValueError):
        p._adopt_job_engines({"asrModel": "not-a-model"})


def test_constructor_rejects_an_unknown_model():
    # Same rule at the other entry point: a bad ENCORE_ASR_MODEL must fail at startup, not at the
    # first cook of the night.
    with pytest.raises(ValueError):
        WhisperXProcessor(model="enormous")
    with pytest.raises(ValueError):
        WhisperXProcessor(sync_mode="vibes")


# ── what each mode actually does to the timing ──────────────────────────────────
class _SpyAligner:
    """Records whether it was asked to align at all — the cost `lines` mode exists to avoid."""

    def __init__(self) -> None:
        self.calls = 0

    def align(self, segments, audio_path, language):
        self.calls += 1
        out = []
        for s in segments:
            toks = s["text"].split()
            span = (s["end"] - s["start"]) / max(1, len(toks))
            out.append(
                {
                    "start": s["start"],
                    "end": s["end"],
                    "text": s["text"],
                    "words": [
                        {"word": t, "start": round(s["start"] + i * span, 3), "end": round(s["start"] + (i + 1) * span, 3)}
                        for i, t in enumerate(toks)
                    ],
                }
            )
        return {"language": language, "segments": out}


def _line_text():
    return LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=[
            {"start": 0.0, "end": 1.5, "text": "line one here"},
            {"start": 2.0, "end": 3.5, "text": "line two here"},
        ],
        timing=TIMING_LINE,
        text_confidence="high",
    )


def test_forced_mode_runs_the_aligner_and_yields_word_timings():
    spy = _SpyAligner()
    p = WhisperXProcessor(aligner=spy, sync_mode="forced")
    doc, timing, _ = p._time_one(_line_text(), "vocals.wav", "en")
    assert spy.calls == 1
    assert timing == TIMING_WORD
    assert doc["lines"][0]["words"]  # per-word highlighting is possible


def test_lines_mode_skips_the_aligner_entirely():
    # The whole point of the mode: one fewer ML pass per cook. If this ever calls the aligner, the
    # setting is cosmetic.
    spy = _SpyAligner()
    p = WhisperXProcessor(aligner=spy, sync_mode="lines")
    doc, timing, _ = p._time_one(_line_text(), "vocals.wav", "en")
    assert spy.calls == 0
    assert timing == TIMING_LINE
    assert doc["lines"][0]["text"] == "line one here"


def test_lines_mode_declines_a_source_with_no_timings_at_all():
    # `lines` will not go and FIND timings, so unsynced text has nothing honest to publish — the floor
    # stays line-level sync rather than a wall of text on the TV.
    spy = _SpyAligner()
    p = WhisperXProcessor(aligner=spy, sync_mode="lines")
    unsynced = LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=[{"start": None, "end": None, "text": "no timings here"}],
        timing=TIMING_NONE,
        text_confidence="high",
    )
    assert p._time_one(unsynced, "vocals.wav", "en") is None
    assert spy.calls == 0


def test_lines_mode_keeps_word_timings_a_source_already_had():
    # "Do not RUN the aligner" is not "throw away timings that already exist". A source that supplies
    # word timings unaided still gets them published — discarding them would be strictly worse output
    # for no saving, since no alignment pass is involved either way.
    spy = _SpyAligner()
    p = WhisperXProcessor(aligner=spy, sync_mode="lines")
    worded = LyricsText(
        text_source=SOURCE_ASR,
        segments=[
            {
                "start": 0.0,
                "end": 1.0,
                "text": "two words",
                "words": [
                    {"word": "two", "start": 0.0, "end": 0.5},
                    {"word": "words", "start": 0.5, "end": 1.0},
                ],
            }
        ],
        timing=TIMING_WORD,
        text_confidence="low",
    )
    _, timing, _ = p._time_one(worded, "vocals.wav", "en")
    assert timing == TIMING_WORD
    assert spy.calls == 0
