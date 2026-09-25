"""The real step implementations, with every adapter faked.

These are thin by design, so the tests are about the few decisions a step is allowed to make: which audio
to align against, whether a source's miss is a miss or an error, and the ownership guard on `publish`.

`AlignStepsImpl` is exercised DIRECTLY, with no DBOS launched — that is the reason the decorators live in
`workflows/dbos_align.py` rather than on these methods.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

import pytest

from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.host.config import Config
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import TIMING_LINE, AudioRef, JobRef, TextRef, TimeRequest

CFG = Config(worker_id="w1")


class Reporter:
    """A `Reporter` that records, and whose ownership answer is scriptable."""

    def __init__(self, *, owns: bool = True) -> None:
        self.owns = owns
        self.states: list[tuple[str, str, str | None]] = []
        self.asked: list[str] = []

    async def progress(self, job_id: str, stage: Stage, pct: int) -> None:
        pass

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        self.states.append((state, verdict, knob))

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        self.asked.append(job_id)
        return self.owns

    def explain_ownership(self, job_id: str) -> str:
        return f"job {job_id} was taken from us"


class FakeAligner:
    """Returns word-timed lines, recording what it was asked to search and on which file."""

    def __init__(self, *, fail: bool = False, words: int = 4) -> None:
        self.fail = fail
        self.words = words
        self.calls: list[tuple[tuple[Segment, ...], str]] = []

    def align(self, search: Sequence[Segment], audio_path: str, language: str) -> Sequence[Segment]:
        self.calls.append((tuple(search), audio_path))
        if self.fail:
            raise RuntimeError("the aligner fell over")
        return [
            {
                "text": "hello world",
                "words": [
                    {"word": f"w{n}", "start": float(n), "end": float(n) + 0.4} for n in range(self.words)
                ],
            }
        ]


class FakeProvider:
    name = "lrclib"

    def __init__(self, cues: Sequence[Segment] | None = None) -> None:
        self.cues = cues
        self.calls: list[tuple[str, str]] = []

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[Segment]:
        self.calls.append((artist, track))
        return self.cues or ()


def job(tmp: Path, **params: object) -> JobRef:
    return JobRef(
        job_id="j1", media_id="m1", media_dir=str(tmp), source_uri="https://x.test/v", params=params
    )


def steps(tmp: Path, *, reporter: Reporter | None = None, **adapters: object) -> AlignStepsImpl:
    return AlignStepsImpl(
        config=CFG,
        adapters=Adapters(**adapters),  # type: ignore[arg-type]
        reporter=reporter or Reporter(),
    )


def audio(tmp: Path, *, vocals: bool = True) -> AudioRef:
    return AudioRef(
        path=str(tmp / "original.mp3"),
        duration_sec=200.0,
        vocals_path=str(tmp / "vocals.wav") if vocals else None,
    )


def lrc_text() -> TextRef:
    return TextRef(
        tier=Tier.CANDIDATE,
        label="lrclib",
        segments=({"start": 0.0, "end": 2.0, "text": "hello"},),
        windows=({"start": 0.0, "end": 2.2, "text": "hello"},),
        timing=TIMING_LINE,
        language="en",
    )


# ── which audio gets aligned ─────────────────────────────────────────────────────────────────────


async def test_aligns_against_the_vocals_stem_by_default(tmp_path: Path) -> None:
    """The mix smears word boundaries wherever the band is loud, so the stem is the default."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert aligner.calls[0][1].endswith("vocals.wav")


async def test_the_mix_knob_actually_changes_the_file(tmp_path: Path) -> None:
    """A retry that did not change its input would spend a pass to produce the identical result."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=lrc_text(),
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.ALIGN_ON_MIX}),
        )
    )
    assert aligner.calls[0][1].endswith("original.mp3")


async def test_with_no_stem_the_mix_is_used_from_the_start(tmp_path: Path) -> None:
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path, vocals=False), language="en")
    )
    assert aligner.calls[0][1].endswith("original.mp3")


async def test_drop_windows_widens_the_search_to_the_whole_segment(tmp_path: Path) -> None:
    """A window derived from a mis-placed text confines the aligner to the wrong span."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    text = lrc_text()

    await impl.time_text(TimeRequest(job=job(tmp_path), text=text, audio=audio(tmp_path), language="en"))
    assert aligner.calls[0][0] == text.windows, "the narrow window is searched first"

    await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=text,
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.DROP_WINDOWS}),
        )
    )
    assert aligner.calls[1][0] == text.segments, "dropping the window searches the whole segment"


# ── what time_text produces ──────────────────────────────────────────────────────────────────────


async def test_writes_the_document_and_returns_a_relative_ref(tmp_path: Path) -> None:
    """The core merges on `ref`, so an absolute path would embed this worker's layout in the core's row."""
    impl = steps(tmp_path, aligner=FakeAligner())
    doc = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert doc is not None
    assert not doc.ref.startswith("/"), "the ref must be media-dir-relative"
    written = tmp_path / doc.ref
    assert written.exists()
    assert json.loads(written.read_text())["language"] == "en"


async def test_measures_what_it_wrote(tmp_path: Path) -> None:
    impl = steps(tmp_path, aligner=FakeAligner(words=4))
    doc = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert doc is not None
    assert doc.report.words == 4
    assert doc.report.duration_sec == 200.0


async def test_an_aligner_fault_is_one_attempt_failing_not_the_job(tmp_path: Path) -> None:
    """The search has other things to try, so this returns None rather than raising."""
    impl = steps(tmp_path, aligner=FakeAligner(fail=True))
    assert (
        await impl.time_text(
            TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
        )
        is None
    )


async def test_no_aligner_at_all_yields_none(tmp_path: Path) -> None:
    impl = steps(tmp_path)
    assert (
        await impl.time_text(
            TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
        )
        is None
    )


async def test_the_line_sync_knob_publishes_the_texts_own_timings(tmp_path: Path) -> None:
    """Terminal knob: word timing is abandoned, so the aligner must not be called at all."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    doc = await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=lrc_text(),
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.LINE_SYNC}),
        )
    )
    assert doc is not None
    assert doc.timing == "line"
    assert doc.confidence == "low", "line sync is a degradation and must say so"
    assert aligner.calls == [], "no alignment pass should be spent"


# ── acquisition ──────────────────────────────────────────────────────────────────────────────────


async def test_a_local_source_is_not_downloaded(tmp_path: Path) -> None:
    """Decided from the DECLARED fetcher, never by sniffing the uri — an unrecognised scheme would
    otherwise reach ffmpeg stages later as an opaque failure."""
    (tmp_path / "already.mp3").write_bytes(b"x")
    impl = steps(tmp_path)
    got = await impl.acquire_audio(
        JobRef(
            job_id="j1",
            media_id="m1",
            media_dir=str(tmp_path),
            source_uri=str(tmp_path / "already.mp3"),
            params={"fetcher": "local"},
        )
    )
    assert got.path.endswith("already.mp3")


async def test_a_remote_source_with_no_fetcher_fails_permanently(tmp_path: Path) -> None:
    """A capability this box lacks is not fixed by retrying."""
    impl = steps(tmp_path)
    with pytest.raises(RuntimeError) as raised:
        await impl.acquire_audio(job(tmp_path))
    assert getattr(raised.value, "retryable", True) is False


async def test_a_recorded_stem_that_is_not_on_disk_is_ignored(tmp_path: Path) -> None:
    """A stems job that refused to publish a silent instrumental leaves the ref recorded and the file
    absent. Aligning against it would fail deep inside the model instead of degrading to the mix."""
    (tmp_path / "a.mp3").write_bytes(b"x")
    impl = steps(tmp_path)
    got = await impl.acquire_audio(
        JobRef(
            job_id="j1",
            media_id="m1",
            media_dir=str(tmp_path),
            source_uri=str(tmp_path / "a.mp3"),
            params={"fetcher": "local", "vocalsRef": "derived/stems/missing.wav"},
        )
    )
    assert got.vocals_path is None


async def test_a_present_stem_is_used(tmp_path: Path) -> None:
    (tmp_path / "a.mp3").write_bytes(b"x")
    (tmp_path / "derived").mkdir()
    (tmp_path / "derived" / "v.wav").write_bytes(b"x")
    impl = steps(tmp_path)
    got = await impl.acquire_audio(
        JobRef(
            job_id="j1",
            media_id="m1",
            media_dir=str(tmp_path),
            source_uri=str(tmp_path / "a.mp3"),
            params={"fetcher": "local", "vocalsRef": "derived/v.wav"},
        )
    )
    assert got.vocals_path is not None and got.vocals_path.endswith("v.wav")


# ── the provider ─────────────────────────────────────────────────────────────────────────────────


async def test_the_provider_is_not_asked_without_both_artist_and_track(tmp_path: Path) -> None:
    """A lookup on a guessed title returns another song's words, which is worse than a miss."""
    provider = FakeProvider([{"start": 0.0, "text": "x"}])
    impl = steps(tmp_path, providers=(provider,))

    assert await impl.fetch_provider_lyrics(job(tmp_path, artist="a-ha"), audio(tmp_path)) is None
    assert provider.calls == [], "an incomplete lookup must not be attempted at all"

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a-ha", track="Take On Me"), audio(tmp_path))
    assert got is not None and got.tier is Tier.CANDIDATE


async def test_unsynced_provider_lyrics_carry_no_line_timing(tmp_path: Path) -> None:
    """Which is what makes LINE_SYNC unavailable for them — there is nothing to fall back to."""
    impl = steps(tmp_path, providers=(FakeProvider([{"text": "a wall of text"}]),))
    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert got is not None and got.has_line_timings is False


async def test_a_provider_miss_is_none(tmp_path: Path) -> None:
    impl = steps(tmp_path, providers=(FakeProvider([]),))
    assert await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path)) is None


# ── tiers ────────────────────────────────────────────────────────────────────────────────────────


class FakeCaptions:
    def __init__(self, cues: Sequence[Segment]) -> None:
        self.cues = cues

    def fetch(self, source_uri: str, out_dir: str, *, automatic: bool) -> Sequence[Segment]:
        return self.cues


async def test_authored_captions_are_a_candidate_and_machine_captions_are_not(tmp_path: Path) -> None:
    """A machine track is evidence of what is audible, never a claim about the words."""
    impl = steps(tmp_path, captions=FakeCaptions([{"start": 0.0, "end": 1.0, "text": "hi"}]))

    authored = await impl.fetch_captions(job(tmp_path), automatic=False)
    machine = await impl.fetch_captions(job(tmp_path), automatic=True)

    assert authored is not None and authored.tier is Tier.CANDIDATE
    assert machine is not None and machine.tier is Tier.MACHINE


async def test_a_transcription_is_the_asr_tier_and_has_no_own_timings(tmp_path: Path) -> None:
    """Word-timed, but measured on THIS audio — so placement, and `Knob.RESHIFT`, are meaningless."""

    class FakeTranscriber:
        def transcribe(self, audio_path: str, *, language: str | None = None) -> Sequence[Segment]:
            return [{"start": 0.0, "end": 1.0, "text": "heard this"}]

    impl = steps(tmp_path, transcriber=FakeTranscriber())
    got = await impl.transcribe(job(tmp_path), audio(tmp_path), on_vocals=True)

    assert got is not None
    assert got.tier is Tier.ASR
    assert got.label == "asr:vocals"
    assert got.has_own_timings is False


async def test_no_transcriber_yields_none(tmp_path: Path) -> None:
    """Which the search reads as "ASR had its turn and heard nothing"."""
    assert await steps(tmp_path).transcribe(job(tmp_path), audio(tmp_path), on_vocals=True) is None


# ── the guarded publish ──────────────────────────────────────────────────────────────────────────


async def test_publish_asks_the_core_first(tmp_path: Path) -> None:
    """A lease can expire DURING a 45-minute alignment, so checking only at reconnect leaves the window
    where two workers publish different lyrics for one song."""
    reporter = Reporter(owns=True)
    impl = steps(tmp_path, reporter=reporter, aligner=FakeAligner())
    doc = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert await impl.publish(job(tmp_path), doc) != ""
    assert reporter.asked == ["j1"], "ownership must be re-asserted at publish time"


async def test_publish_refuses_when_ownership_is_gone(tmp_path: Path) -> None:
    reporter = Reporter(owns=False)
    impl = steps(tmp_path, reporter=reporter, aligner=FakeAligner())
    with pytest.raises(NotOurJob, match="taken from us"):
        await impl.publish(job(tmp_path), None)


async def test_the_no_lyrics_outcome_still_publishes(tmp_path: Path) -> None:
    """Readiness waits on align, so a silent completion strands the song in "processing" forever."""
    impl = steps(tmp_path, reporter=Reporter(owns=True))
    assert await impl.publish(job(tmp_path), None) == ""


async def test_a_note_failure_never_fails_a_job(tmp_path: Path) -> None:
    """Diagnostics must not be able to break work."""

    class Broken(Reporter):
        async def state(
            self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
        ) -> None:
            raise OSError("socket gone")

    impl = steps(tmp_path, reporter=Broken())
    await impl.note(job(tmp_path), "time", 1, "try", "because", None)  # must not raise


# ── the silence probe's honesty ──────────────────────────────────────────────────────────────────


def _store(tmp_path: Path) -> LocalArtifactStore:
    """A real store over a temp tree. Real rather than faked: it holds four strings and touches no disk
    until something is published, and these tests publish nothing."""
    return LocalArtifactStore(Roots.under(str(tmp_path / "media")))


async def test_probe_silence_reports_none_rather_than_inventing_a_loud_reading(tmp_path: Path) -> None:
    """With no probe the step must say "I do not know", not return a number meaning "definitely fine"."""
    from encore_worker.steps.separate_steps import SeparateStepsImpl

    impl = SeparateStepsImpl(
        config=CFG,
        audio=steps(tmp_path),
        reporter=Reporter(),
        store=_store(tmp_path),
        separator=None,
        probe=None,
    )
    assert await impl.probe_silence(job(tmp_path), audio(tmp_path)) is None


async def test_probe_silence_passes_through_a_real_measurement(tmp_path: Path) -> None:
    from encore_worker.steps.separate_steps import SeparateStepsImpl

    class Probe:
        def duration_sec(self, audio_path: str) -> float:
            return 200.0

        def peak_dbfs(self, audio_path: str) -> float | None:
            return -6.5

    impl = SeparateStepsImpl(
        config=CFG,
        audio=steps(tmp_path),
        reporter=Reporter(),
        store=_store(tmp_path),
        separator=None,
        probe=Probe(),
    )
    assert await impl.probe_silence(job(tmp_path), audio(tmp_path)) == -6.5


# ── RESHIFT actually re-places ────────────────────────────────────────────────────────────────────


async def test_reshift_without_a_reference_is_the_identity(tmp_path: Path) -> None:
    """Correct for a first attempt: there is no series measured on this recording to place against."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    text = lrc_text()
    await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=text,
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.RESHIFT, Knob.DROP_WINDOWS}),
        )
    )
    assert aligner.calls[0][0] == text.segments, "with no reference the text must be searched unmoved"


async def test_reshift_moves_the_text_onto_the_previous_alignment(tmp_path: Path) -> None:
    """THE fix. An earlier version fitted the text against its own windows — two views of one series —
    which was a near-identity, so the knob burned an alignment pass and changed nothing."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    text = TextRef(
        tier=Tier.CANDIDATE,
        label="lrclib",
        segments=(
            {"start": 0.0, "end": 1.0, "text": "one"},
            {"start": 10.0, "end": 11.0, "text": "two"},
            {"start": 20.0, "end": 21.0, "text": "three"},
            {"start": 30.0, "end": 31.0, "text": "four"},
        ),
        timing=TIMING_LINE,
        language="en",
    )
    # The previous alignment found those lines five seconds later than the sheet claims.
    await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=text,
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.RESHIFT}),
            reference_starts=(5.0, 15.0, 25.0, 35.0),
        )
    )
    searched = aligner.calls[0][0]
    assert [s["start"] for s in searched] == [5.0, 15.0, 25.0, 35.0], (
        "the searched spans must be moved onto the reference, not left where the sheet put them"
    )


async def test_the_written_record_carries_line_starts_for_the_next_attempt(tmp_path: Path) -> None:
    """Without these the next RESHIFT has no reference and silently degrades to the identity."""
    impl = steps(tmp_path, aligner=FakeAligner(words=3))
    doc = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert doc is not None
    assert doc.line_starts == (0.0,), "one line, starting at its first timed word"


async def test_line_starts_come_from_the_first_timed_word_not_the_line_field(tmp_path: Path) -> None:
    """Some aligners copy the input's line `start` through while moving the words inside it. Reading that
    field would hand the next RESHIFT the very series it was trying to correct."""

    class CopiesThroughLineStart(FakeAligner):
        def align(self, search, audio_path, language):  # type: ignore[no-untyped-def]
            self.calls.append((tuple(search), audio_path))
            return [{"start": 0.0, "words": [{"word": "a", "start": 7.5, "end": 8.0}]}]

    impl = steps(tmp_path, aligner=CopiesThroughLineStart())
    doc = await impl.time_text(
        TimeRequest(job=job(tmp_path), text=lrc_text(), audio=audio(tmp_path), language="en")
    )
    assert doc is not None
    assert doc.line_starts == (7.5,), "must read the word, not the copied-through line field"


# ── the provider chain ────────────────────────────────────────────────────────────────────────────


class FakeChainProvider:
    """A provider that hits, misses, or fails — for exercising the chain."""

    def __init__(self, name: str, *, cues: Sequence[Segment] = (), raises: Exception | None = None) -> None:
        self.name = name
        self._cues = cues
        self._raises = raises
        self.calls = 0
        self.last_source: str | None = None

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[Segment]:
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        return self._cues


LINE = ({"start": 0.0, "end": 2.0, "text": "hello"},)
WORDS = ({"start": 0.0, "end": 2.0, "text": "hello", "words": [{"word": "hello", "start": 0.0, "end": 2.0}]},)


async def test_the_first_provider_that_hits_wins(tmp_path: Path) -> None:
    first = FakeChainProvider("mux", cues=LINE)
    second = FakeChainProvider("direct", cues=LINE)
    impl = steps(tmp_path, providers=(first, second))

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert got is not None and got.label == "mux"
    assert second.calls == 0, "a hit must short-circuit the rest of the chain"


async def test_a_miss_falls_through_to_the_next_provider(tmp_path: Path) -> None:
    empty = FakeChainProvider("mux", cues=())
    backup = FakeChainProvider("direct", cues=LINE)
    impl = steps(tmp_path, providers=(empty, backup))

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert got is not None and got.label == "direct"


async def test_a_provider_that_raises_does_not_stop_the_chain(tmp_path: Path) -> None:
    """One being unreachable is exactly when the next matters most — a network that blocks one host may
    reach another."""
    broken = FakeChainProvider("mux", raises=OSError("blocked by proxy"))
    backup = FakeChainProvider("direct", cues=LINE)
    impl = steps(tmp_path, providers=(broken, backup))

    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert got is not None and got.label == "direct"
    assert backup.calls == 1


async def test_every_provider_failing_is_reported_not_swallowed(tmp_path: Path) -> None:
    """ "Every provider is down" and "this song is obscure" must stay distinguishable — conflating them is
    what once hid a month-long outage."""
    reporter = Reporter()
    impl = steps(
        tmp_path,
        reporter=reporter,
        providers=(
            FakeChainProvider("mux", raises=OSError("blocked")),
            FakeChainProvider("direct", raises=OSError("also blocked")),
        ),
    )
    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))

    assert got is None
    verdicts = [verdict for _state, verdict, _knob in reporter.states]
    assert "providers-down" in verdicts


async def test_an_ordinary_miss_is_not_reported_as_an_outage(tmp_path: Path) -> None:
    reporter = Reporter()
    impl = steps(tmp_path, reporter=reporter, providers=(FakeChainProvider("mux", cues=()),))
    assert await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path)) is None
    assert "providers-down" not in [v for _s, v, _k in reporter.states]


async def test_word_level_lyrics_are_recorded_as_word_timed(tmp_path: Path) -> None:
    """LRCmux can return word spans; LRCLIB cannot. The timing is read from the PAYLOAD, so a word-timed
    sheet gets the knobs a word-timed sheet should have."""
    impl = steps(tmp_path, providers=(FakeChainProvider("mux", cues=WORDS),))
    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert got is not None and got.timing == "word"
    assert got.has_own_timings is True, "not ASR, so placement and RESHIFT apply"


async def test_a_multiplexers_upstream_reaches_the_label(tmp_path: Path) -> None:
    """The trail should say `mux:KuGou`, so a systematically bad source is identifiable."""
    provider = FakeChainProvider("mux", cues=LINE)
    provider.last_source = "KuGou"
    impl = steps(tmp_path, providers=(provider,))
    got = await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path))
    assert got is not None and got.label == "mux:KuGou"


async def test_no_providers_at_all_is_a_quiet_miss(tmp_path: Path) -> None:
    impl = steps(tmp_path, providers=())
    assert await impl.fetch_provider_lyrics(job(tmp_path, artist="a", track="b"), audio(tmp_path)) is None


# ── untimed text gets provisional spans before the aligner sees it ─────────────────────────────────


async def test_an_untimed_text_is_given_spans_before_alignment(tmp_path: Path) -> None:
    """The step-level half of a bug found only by running the real aligner: whisperx crops per segment, so
    it raises `KeyError: 'start'` on untimed input — which the broad `except` below turned into a silently
    discarded candidate, dropping every plain lyrics sheet to the ASR tier."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    plain = TextRef(
        tier=Tier.CANDIDATE,
        label="plain-sheet",
        segments=({"text": "first line"}, {"text": "second line here"}),
    )

    await impl.time_text(TimeRequest(job=job(tmp_path), text=plain, audio=audio(tmp_path), language="en"))

    searched = aligner.calls[0][0]
    assert all("start" in span and "end" in span for span in searched), (
        f"every span handed to the aligner must be timed; got {searched}"
    )
    assert float(searched[0]["start"]) == 0.0  # type: ignore[arg-type]
    assert float(searched[-1]["end"]) == 200.0, "the spans must cover the whole audio"  # type: ignore[arg-type]


async def test_an_already_timed_text_is_not_re_spanned(tmp_path: Path) -> None:
    """Its own timings are measured; replacing them with a character-share guess would throw away real
    information and undo the placement the search depends on."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    text = lrc_text()

    await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=text,
            audio=audio(tmp_path),
            language="en",
            knobs=frozenset({Knob.DROP_WINDOWS}),
        )
    )
    assert aligner.calls[0][0] == text.segments, "timed segments must reach the aligner unchanged"


async def test_an_untimed_text_with_an_unknown_duration_is_left_alone(tmp_path: Path) -> None:
    """Nothing to apportion against. The aligner then refuses by name, which is the honest outcome."""
    aligner = FakeAligner()
    impl = steps(tmp_path, aligner=aligner)
    plain = TextRef(tier=Tier.CANDIDATE, label="plain", segments=({"text": "words"},))

    await impl.time_text(
        TimeRequest(
            job=job(tmp_path),
            text=plain,
            audio=AudioRef(path=str(tmp_path / "a.mp3"), duration_sec=0.0),
            language="en",
        )
    )
    assert "start" not in aligner.calls[0][0][0]
