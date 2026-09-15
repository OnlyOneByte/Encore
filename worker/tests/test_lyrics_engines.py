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

from src import plans  # noqa: E402
from src.lyrics.grading import (
    SOURCE_ASR,
    SOURCE_LRCLIB,
    TIMING_LINE,
    TIMING_NONE,
    TIMING_WORD,
    LyricsText,
)
from src.lyrics.lrc import plain_lyrics_to_segments  # noqa: E402
from src.runtime.ctx import ResolvedEngines  # noqa: E402
from src.steps.lyrics import _time_one  # noqa: E402
from src.vocabulary import AsrModel, SyncMode, parse_asr_model, parse_sync_mode


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


# ── resolving a job's engines ────────────────────────────────────────────────────
#
# This replaced `WhisperXProcessor._adopt_job_engines`, which MUTATED the shared processor instance --
# `self._model`, `self._sync_mode`, and it nulled `self._transcriber` and `self._sources` to force a
# reload. One instance served every align job, so with ENCORE_WORKER_CONCURRENCY > 1 two jobs carrying
# different `asrModel` raced: one could null the other's cached sources mid-acquire, or transcribe with
# the other's weights. Resolution is now a pure function into per-job state, so the race is not fixed so
# much as made impossible to express.


def test_job_params_override_the_worker_defaults():
    got = plans.resolve_engines(
        {"asrModel": "small", "syncMode": "lines"},
        ResolvedEngines(asr_model="base", sync_mode=SyncMode.FORCED),
    )
    assert got.asr_model == "small"
    assert got.sync_mode is SyncMode.LINES


def test_absent_params_leave_the_worker_env_fallback_alone():
    # An older core sends neither. The worker's own ENCORE_ASR_MODEL / ENCORE_SYNC_MODE must stand.
    got = plans.resolve_engines({}, ResolvedEngines(asr_model="medium", sync_mode=SyncMode.LINES))
    assert got.asr_model == "medium"
    assert got.sync_mode is SyncMode.LINES


def test_resolution_is_PURE_so_two_concurrent_jobs_cannot_affect_each_other():
    """The concurrency bug, pinned as a property rather than as a scenario.

    Nothing is mutated, so there is no shared cell for a second job to write through. A regression that
    reintroduced instance state would have to break this test to do it.
    """
    defaults = ResolvedEngines(asr_model="base", sync_mode=SyncMode.FORCED)
    job_a = plans.resolve_engines({"asrModel": "small"}, defaults)
    job_b = plans.resolve_engines({"asrModel": "large-v3"}, defaults)

    assert (job_a.asr_model, job_b.asr_model) == ("small", "large-v3")
    assert job_a is not job_b
    # the shared defaults were not touched by either
    assert defaults.asr_model == "base"
    # ...and resolving again after both still yields the same answer
    assert plans.resolve_engines({"asrModel": "small"}, defaults).asr_model == "small"


def test_an_unknown_model_on_the_wire_fails_before_any_work():
    with pytest.raises(ValueError):
        plans.resolve_engines({"asrModel": "not-a-model"}, ResolvedEngines())


# ── the model cache ──────────────────────────────────────────────────────────────
#
# The old design cached one loaded model on the shared processor and NULLED it whenever a job asked for a
# different checkpoint. Removing that instance state fixed the race, but naively it would have replaced
# it with a worse bug: a fresh transcriber per job means re-reading multi-GB weights on every align job.
# These pin the replacement -- a module-level cache keyed by configuration.


def test_two_jobs_on_the_same_checkpoint_SHARE_one_loaded_model():
    """Otherwise every align job re-reads multi-GB weights. This is the performance the old instance
    cache was buying, kept without the shared mutable state that made it a race."""
    from src.lyrics import transcriber_for

    a = transcriber_for("cpu", "base")
    b = transcriber_for("cpu", "base")
    assert a is b


def test_two_jobs_on_DIFFERENT_checkpoints_cannot_evict_each_other():
    """The actual race, pinned. Under the old design a job asking for `small` nulled the cached `base`
    model out from under a job already using it."""
    from src.lyrics import transcriber_for

    base = transcriber_for("cpu", "base")
    small = transcriber_for("cpu", "small")
    assert base is not small
    assert transcriber_for("cpu", "base") is base  # still there, not evicted by the `small` load


def test_the_aligner_is_cached_per_device_on_the_same_reasoning():
    from src.lyrics import aligner_for

    assert aligner_for("cpu") is aligner_for("cpu")
    assert aligner_for("cpu") is not aligner_for("cuda")


# The tests above pin that the cache HOLDS (a second sequential call gets the first instance). They do
# NOT pin the `with ML_LOCK:` that guards the check-then-set INSIDE the factory: after the first call
# populates the module dict, every later call short-circuits on the `.get()` regardless of the lock, so
# neutering `aligner_for`'s guard to `if True:` leaves this whole file green. The race the lock exists
# for only appears when two callers hit an EMPTY cache at once — `aligner_for` runs on a real worker
# thread (steps/lyrics.py: `_time_one` inside `run_blocking` -> `asyncio.to_thread`), so with
# ENCORE_WORKER_CONCURRENCY>1 two align jobs enter the check-then-set concurrently. Without the lock both
# read `None`, both construct a WhisperxForcedAligner, and last-write-wins hands the two jobs DIFFERENT
# instances — each with its own `self._cache`, so each loads the multi-GB wav2vec2 model (double VRAM /
# double resident copy; the process still succeeds, so the only symptom is memory). See asr.py's cache
# comment, which records this exact failure ("load the same model twice and double the memory").
#
# This drives the concurrency THROUGH the production factory rather than re-implementing the lock in the
# test, so it reds when the guard is removed and stays green while it is present. Parametrised over both
# factories: `transcriber_for` (asr.py) has the identical check-then-set shape and is only accidentally
# safe today because its default resolves on the event loop, outside the threaded window — pinning it
# now closes it before that ordering ever changes.
@pytest.mark.parametrize("factory", ["aligner", "transcriber"])
def test_the_factory_hands_concurrent_callers_ONE_instance_not_two(monkeypatch, factory):
    """The check-then-set race, pinned as identity. N threads hit an empty cache at once off a Barrier;
    the module lock must make exactly one construction win and every thread receive that same object.
    Without `with ML_LOCK:` in the factory, several threads slip between the `.get()` and the store and
    walk away with distinct instances that each load the model — so this reds `> 1 distinct instance`."""
    import sys
    import threading
    import time

    import src.lyrics.aligner as timing_mod
    import src.lyrics.asr as asr_mod
    from src.lyrics import aligner_for, transcriber_for

    if factory == "aligner":
        cls = timing_mod.WhisperxForcedAligner
        cache = timing_mod._ALIGNERS
        call = lambda: aligner_for("cpu")  # noqa: E731
    else:
        cls = asr_mod.WhisperxTranscriber
        cache = asr_mod._TRANSCRIBERS
        call = lambda: transcriber_for("cpu", "base")  # noqa: E731

    n = 8
    constructions = []
    con_lock = threading.Lock()
    real_init = cls.__init__

    def slow_init(self, *args, **kwargs):
        # Record every construction and dwell INSIDE the check-then-set window, so that without the
        # factory's lock the other threads (which have already passed the `.get() is None` check) also
        # construct before this one stores. Cheap by design — the real __init__ only sets fields and an
        # empty dict, no weights load here — so the sleep is what makes the race reachable, not the load.
        with con_lock:
            constructions.append(id(self))
        time.sleep(0.02)
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(cls, "__init__", slow_init)

    old_interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-9)  # widen the interleave so the tiny window is hit reliably
    try:
        # Loop trials: the window is narrow, so one trial can miss it even unlocked. A handful of trials
        # makes the unlocked race virtually certain to surface while staying bounded.
        for _ in range(20):
            cache.clear()
            constructions.clear()
            barrier = threading.Barrier(n)
            got = [None] * n

            def worker(i, barrier=barrier, got=got):
                barrier.wait()  # release all threads into the factory at the same instant
                got[i] = call()

            threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            # decisive assertion: identity, not a count — every caller must hold the SAME object.
            distinct = {id(x) for x in got}
            assert None not in got, "a worker never reached the factory"
            assert len(distinct) == 1, (
                f"{factory}_for handed out {len(distinct)} distinct instances to concurrent callers "
                f"({len(constructions)} constructions) — the check-then-set lock is not holding"
            )
            # corroborator: the guarded construct ran at most once per empty-cache trial.
            assert len(constructions) == 1, (
                f"the model was constructed {len(constructions)} times for one empty cache — "
                "two concurrent callers each loaded it"
            )
    finally:
        sys.setswitchinterval(old_interval)


def test_worker_config_rejects_an_unknown_model():
    # Same rule at the other entry point: a bad ENCORE_ASR_MODEL must fail when the worker is built, not
    # at the first process of the night.
    async def _noop(argv):  # pragma: no cover - never invoked; construction fails first
        yield ""

    with pytest.raises(ValueError):
        plans.align_runner(runner=_noop, model="enormous")
    with pytest.raises(ValueError):
        plans.align_runner(runner=_noop, sync_mode="vibes")


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
                        {
                            "word": t,
                            "start": round(s["start"] + i * span, 3),
                            "end": round(s["start"] + (i + 1) * span, 3),
                        }
                        for i, t in enumerate(toks)
                    ],
                }
            )
        return {"language": language, "segments": out}


def _ctx(sync_mode: str = "forced"):
    """A Ctx carrying only what `_time_one` reads: the resolved sync mode.

    Building one by hand is the point of the refactor — timing a text no longer needs a processor, a
    runner, a job on the wire, or a media directory.
    """
    from src.processor import JobSpec
    from src.runtime.ctx import Ctx, ResolvedEngines

    return Ctx(
        job=JobSpec(job_id="j", media_id="m", job_type="align", source_uri="", params={}, media_dir="."),
        work=".",
        engines=ResolvedEngines(sync_mode=parse_sync_mode(sync_mode, SyncMode.FORCED)),
    )


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
    doc, timing, _ = _time_one(spy, _ctx("forced"), _line_text(), "vocals.wav", "en")
    assert spy.calls == 1
    assert timing == TIMING_WORD
    assert doc["lines"][0]["words"]  # per-word highlighting is possible


def test_lines_mode_skips_the_aligner_entirely():
    # The whole point of the mode: one fewer ML pass per process. If this ever calls the aligner, the
    # setting is cosmetic.
    spy = _SpyAligner()
    doc, timing, _ = _time_one(spy, _ctx("lines"), _line_text(), "vocals.wav", "en")
    assert spy.calls == 0
    assert timing == TIMING_LINE
    assert doc["lines"][0]["text"] == "line one here"


def test_lines_mode_declines_a_source_with_no_timings_at_all():
    # `lines` will not go and FIND timings, so a plain-lyrics record has nothing honest to publish —
    # the floor stays line-level sync rather than a wall of synthetic even spacing sold as line timing.
    #
    # The segments here are what `plain_lyrics_to_segments` REALLY emits (numeric, evenly spaced): that
    # is the only shape a TIMING_NONE source ever reaches `_time_one` in (grading.py stamps TIMING_NONE
    # exactly for a plainLyrics LRCLIB record, whose bounds go through that producer). A hand-built
    # `start=None` segment is unreachable — and it would let the guard removal pass vacuously, because
    # `is_line_synced` also rejects a non-numeric start, so `_time_one` would return None either way.
    # Numeric bounds make the guard the ONLY thing standing between this input and a published
    # (TIMING_LINE, "high") artifact, so deleting `if text.timing != TIMING_LINE: return None` reds this.
    spy = _SpyAligner()
    segs = plain_lyrics_to_segments("no timings here\nsecond line", 120.0)
    assert all(isinstance(seg["start"], (int, float)) for seg in segs)  # production shape, not start=None
    unsynced = LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=segs,
        timing=TIMING_NONE,
        text_confidence="high",
    )
    assert _time_one(spy, _ctx("lines"), unsynced, "vocals.wav", "en") is None
    assert spy.calls == 0


def test_lines_mode_keeps_word_timings_a_source_already_had():
    # "Do not RUN the aligner" is not "throw away timings that already exist". A source that supplies
    # word timings unaided still gets them published — discarding them would be strictly worse output
    # for no saving, since no alignment pass is involved either way.
    spy = _SpyAligner()
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
    _, timing, _ = _time_one(spy, _ctx("lines"), worded, "vocals.wav", "en")
    assert timing == TIMING_WORD
    assert spy.calls == 0
