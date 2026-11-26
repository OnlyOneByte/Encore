"""What an align job ASKS FOR is honoured: a person's re-pick, the sync mode, the ASR model.

The worker used to read none of `pinnedRef`, `pinnedText`, `asrModel` or `syncMode`: a paste through
`/api/lyrics-reselect` was silently replaced by the automatic search, nothing wrote the manual key core had
already pinned (`derived/lyrics/{id}-manual-word.json`), and a room's ASR model and sync mode changed
nothing. Four levels, because the fix spans four: the pure param reads (`steps.api`) — what counts as a pin,
and which refs one may never touch; the search (`Search.pinned`, `Search.line_only`), where a pin is the
whole pool and never falls back; `run_align` over the scripted `Fake` and over the REAL steps on the CTC
fixture, where the paste is decoded blind, gated, written to the manual key only once accepted and NOTHING
written when the gate refuses it; and core's side of the contract, read from its source.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

from encore_worker.adapters import ports
from encore_worker.artifacts import keys
from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.domain.lyrics.report import Engine, TimingReport
from encore_worker.domain.lyrics.search import Candidate, Commit, GiveUp, RunAsr, Search, Try
from encore_worker.host.config import ASR_MODELS, Config
from encore_worker.protocol.vocabulary import SyncMode
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.api import NotOurJob, Pin, asr_model_of, pin_of, sync_mode_of
from encore_worker.steps.records import TIMING_LINE, TIMING_WORD, AlignOutcome, AudioRef, JobRef, TextRef
from encore_worker.workflows.align import run_align
from tests.ctc_fixture import ctc_viterbi, sung_matrix
from tests.test_align_flow import CLEAN, INCOHERENT, LINE_SYNCED, REFUSED, Fake, asr_text, lrc
from tests.test_align_provenance import DIC, UNIQUE, UNIQUE_DURATION, PathAligner, Phrase, sung_wav

MANUAL = "derived/lyrics/m1-manual-word.json"
PASTE = "\n".join(text for text, _s, _e in UNIQUE)


def job(**params: object) -> JobRef:
    return JobRef(
        job_id="j1", media_id="m1", media_dir="/media/m1", source_uri="https://x.test/v", params=params
    )


def pasted_text() -> TextRef:
    return TextRef(tier=Tier.CANDIDATE, label="manual", segments=tuple({"text": t} for t, _s, _e in UNIQUE))


# ── the pure reads: what a pin is, and what it may touch ─────────────────────────────────────────────


def test_an_ordinary_job_carries_no_pin() -> None:
    assert pin_of(job(artist="a", track="t", asrModel="small", syncMode="forced")) is None


def test_a_paste_is_pinned_under_the_ref_core_minted_and_keeps_its_words() -> None:
    """Core sends the paste beside the manual ref it pinned (`dispatch.ts assignParams`)."""
    got = pin_of(job(pinnedRef=MANUAL, pinnedText=f"  {PASTE}\n  "))
    assert got == Pin(ref=MANUAL, pasted=PASTE)


def test_a_bare_paste_is_published_under_the_manual_key_rather_than_dropped() -> None:
    """Core never sends one (the paste rides only inside the `pinnedRef` block), but a paste is not lost."""
    got = pin_of(job(pinnedText="hello"))
    assert got is not None and got.ref == keys.manual_lyrics_key("m1") == MANUAL and got.refused is None


@pytest.mark.parametrize(
    "ref",
    [
        "../../etc/passwd.json",
        "/media/m1/derived/lyrics/m1-lrclib-word.json",
        "derived/lyrics/../stems/m1-vocals.json",
        "derived\\lyrics\\m1-lrclib-word.json",
        "derived/stems/m1-vocals.flac",
        "derived/lyrics/m1-lrclib-word.txt",
        "meta/m1.json",
    ],
    ids=["climbs-out", "absolute", "climbs-inside", "backslashes", "a-stem", "not-json", "the-sidecar"],
)
def test_a_pin_outside_the_lyrics_store_is_refused(ref: str) -> None:
    """The ref is joined onto the media dir to READ the stored words and to WRITE the re-time: an escaping
    one reaches outside the store, and one naming a stem would overwrite audio with JSON."""
    got = pin_of(job(pinnedRef=ref, pinnedText="hello"))
    assert got is not None and got.refused is not None and got.refused.startswith("REFUSING pinned ref")


def test_sync_mode_reads_the_job_and_a_pin_is_always_aligned() -> None:
    assert sync_mode_of(job()) is SyncMode.FORCED
    assert sync_mode_of(job(syncMode="lines")) is SyncMode.LINES
    assert sync_mode_of(job(syncMode="forced")) is SyncMode.FORCED
    assert sync_mode_of(job(syncMode="telepathy")) is SyncMode.FORCED, "unknown is the shared default"
    assert sync_mode_of(job(syncMode="lines", pinnedRef=MANUAL, pinnedText="x")) is SyncMode.FORCED


def test_asr_model_reads_the_job_but_only_a_checkpoint_this_worker_may_load() -> None:
    assert asr_model_of(job(asrModel="small"), "base") == "small"
    assert asr_model_of(job(asrModel="large-v3"), "base") == "large-v3"
    assert asr_model_of(job(asrModel="../weights"), "base") == "base"
    assert asr_model_of(job(), "medium") == "medium"


@pytest.mark.parametrize(
    ("ref", "label", "tier"),
    [
        ("derived/lyrics/m1-captions-authored-align-on-mix-line.json", "captions:authored", Tier.CANDIDATE),
        ("derived/lyrics/m1-captions-machine-word.json", "captions:machine", Tier.MACHINE),
        # The OLD worker's key for YouTube's automatic track (`AutoCaptionsSource._tag = "auto"`, sent
        # with textConfidence `low`); libraries aligned before 2026-09-25 still hold these refs.
        ("derived/lyrics/m1-captions-auto-line.json", "captions:auto", Tier.MACHINE),
        ("derived/lyrics/m1-asr-vocals-word.json", "asr:vocals", Tier.ASR),
        ("derived/lyrics/m1-lrcmux-KuGou-reshift-word.json", "lrcmux:KuGou", Tier.CANDIDATE),
        ("derived/lyrics/m1-lrclib-line.json", "lrclib", Tier.CANDIDATE),
        (MANUAL, "manual", Tier.CANDIDATE),
        ("derived/lyrics/m1-some-older-shape.json", "manual", Tier.CANDIDATE),
    ],
)
def test_a_re_picked_candidate_keeps_the_label_and_tier_it_was_written_under(
    ref: str, label: str, tier: Tier
) -> None:
    """`_write`'s ref shape read back: the label drives core's `textSource`, the tier what the text is
    inside the job. A machine track under EITHER worker's key stays MACHINE (the old
    `captions-auto` key once read back as a CANDIDATE), though the frame now sends ANY pin's `textConfidence`
    `high` (`test_a_re_picked_machine_caption_goes_out_as_the_persons_claim`)."""
    from encore_worker.steps.align_text import _pinned_label
    from encore_worker.steps.records import tier_of_label

    assert _pinned_label(ref, "m1") == label
    assert tier_of_label(label) is tier
    assert tier.text_confidence == ("high" if tier is Tier.CANDIDATE else "low")


# ── the search: a pin is the whole pool, and it never falls back ──────────────────────────────────────


def pinned_search(*pool: Candidate) -> Search:
    return Search(pool=list(pool), pinned=True)


def test_a_refused_pin_gives_up_without_transcribing() -> None:
    """ "GiveUp only after ASR" is about concluding a song has NO WORDS. A pin concludes nothing about the
    song: an automatic answer in place of the person's text is the bug."""
    search = pinned_search(Candidate(tier=Tier.CANDIDATE, label="manual"))
    first = search.begin()
    assert isinstance(first, Try) and "pinned" in first.why
    done = search.record(REFUSED)
    assert isinstance(done, GiveUp) and "never replaced" in done.why
    assert not any(e["verdict"] == "asr-fallback" for e in search.trail)


def test_an_empty_pinned_pool_gives_up_at_once() -> None:
    """The stored candidate was unreadable: nothing to time, and nothing may stand in for it."""
    assert isinstance(pinned_search().begin(), GiveUp)


def test_a_pinned_text_still_walks_its_own_ladder() -> None:
    """All the gates and knobs still apply to the one text: the windowed engine's mix retry, best-so-far."""
    search = pinned_search(Candidate(tier=Tier.CANDIDATE, label="manual"))
    search.begin()
    thin = TimingReport(words=40, coverage=0.25, duration_sec=200.0, engine=Engine.WINDOWED)
    retry = search.record(thin)
    assert isinstance(retry, Try) and Knob.ALIGN_ON_MIX in retry.attempt.tried
    assert isinstance(search.record(CLEAN), Commit)


def test_line_only_starts_every_text_on_its_line_timings_and_skips_the_untimed() -> None:
    search = Search(
        pool=[
            Candidate(tier=Tier.CANDIDATE, label="plain"),
            Candidate(tier=Tier.CANDIDATE, label="lrclib", has_line_timings=True, has_own_line_timings=True),
        ],
        line_only=True,
    )
    first = search.begin()
    assert isinstance(first, Try) and first.index == 1, "the untimed text has nothing lines mode can use"
    assert first.attempt.tried == frozenset({Knob.LINE_SYNC})
    assert search.trail[0]["verdict"] == "next" and search.trail[0]["text"] == "plain"
    assert isinstance(search.record(LINE_SYNCED), Commit)


def test_line_only_still_runs_the_asr_fallback_after_a_refusal() -> None:
    search = Search(
        pool=[Candidate(tier=Tier.CANDIDATE, label="lrclib", has_line_timings=True)], line_only=True
    )
    search.begin()
    assert isinstance(search.record(REFUSED), RunAsr)


# ── run_align over the scripted fake ─────────────────────────────────────────────────────────────────


async def test_a_paste_is_the_only_text_and_publishes_under_the_pinned_ref() -> None:
    """The headline failure: the paste used to be ignored and the providers searched instead."""
    fake = Fake(provider=lrc(), authored=lrc("captions:authored"), pinned=pasted_text(), reports=[CLEAN])
    outcome = await run_align(job(pinnedRef=MANUAL, pinnedText=PASTE), fake)

    assert [c for c in fake.calls if c.startswith("fetch")] == ["fetch_pinned_text"], "nothing else acquired"
    assert [req.text.label for req in fake.timed] == ["manual"]
    assert outcome.published is not None and outcome.published.ref == MANUAL
    assert outcome.candidates == (outcome.published,), "only the placed document is a candidate"
    assert fake.published is not None and fake.published.ref != MANUAL, "publish is handed the attempt"
    assert not any(c.startswith("transcribe") for c in fake.calls)


async def test_a_refused_paste_publishes_nothing_and_never_searches() -> None:
    """Old semantics: a failed re-time publishes nothing, leaving core's candidate exactly as it is."""
    fake = Fake(provider=lrc(), transcribed=asr_text(), pinned=pasted_text(), reports=[REFUSED])
    outcome = await run_align(job(pinnedRef=MANUAL, pinnedText=PASTE), fake)

    assert [req.text.label for req in fake.timed] == ["manual"]
    assert "publish" in fake.calls and fake.published is None
    assert outcome.published is None and outcome.candidates == ()
    assert not any(c.startswith("transcribe") or c == "fetch_provider_lyrics" for c in fake.calls)
    assert "never replaced" in outcome.why
    assert ("publish", "pin-declined", None) in fake.notes, "the song's lyrics stand: not a 'no lyrics'"


async def test_an_incoherent_paste_is_not_line_synced_or_replaced() -> None:
    """A paste has no line timings, so an unusable decode ends it: no line sync, no ASR."""
    fake = Fake(transcribed=asr_text(), pinned=pasted_text(), reports=[INCOHERENT])
    outcome = await run_align(job(pinnedRef=MANUAL, pinnedText=PASTE), fake)
    assert len(fake.timed) == 1 and not fake.timed[0].force_line_sync
    assert outcome.published is None and not any(c.startswith("transcribe") for c in fake.calls)


async def test_an_unreadable_stored_candidate_publishes_nothing() -> None:
    fake = Fake(provider=lrc(), transcribed=asr_text(), pinned=None)
    outcome = await run_align(job(pinnedRef="derived/lyrics/m1-lrclib-word.json"), fake)
    assert fake.timed == [] and outcome.published is None and outcome.candidates == ()
    assert not any(c.startswith("transcribe") for c in fake.calls)


async def test_a_pin_outside_the_store_is_never_even_read() -> None:
    fake = Fake(pinned=pasted_text())
    outcome = await run_align(job(pinnedRef="derived/stems/m1-vocals.flac", pinnedText=PASTE), fake)
    assert "fetch_pinned_text" not in fake.calls and fake.timed == []
    assert ("texts", "pin-refused", None) in fake.notes
    assert outcome.published is None


async def test_a_pinned_job_that_lost_its_lease_reports_no_candidate() -> None:
    """Its attempts live in job scratch (reclaimed with it) and nothing was placed at the pin."""
    fake = Fake(pinned=pasted_text(), reports=[CLEAN], publish_raises=NotOurJob("gone"))
    outcome = await run_align(job(pinnedRef=MANUAL, pinnedText=PASTE), fake)
    assert outcome.published is None and outcome.candidates == ()


async def test_lines_mode_line_syncs_the_timed_text_and_runs_no_word_decode() -> None:
    fake = Fake(provider=lrc(), reports=[LINE_SYNCED])
    outcome = await run_align(job(syncMode="lines"), fake)
    assert [req.force_line_sync for req in fake.timed] == [True]
    assert outcome.published is not None and outcome.published.timing == TIMING_LINE
    assert ("texts", "sync-mode", None) in fake.notes


async def test_lines_mode_skips_an_untimed_sheet_and_line_syncs_the_transcript() -> None:
    """A transcript's segments are measured on this audio, so under `lines` it publishes their spans."""
    plain = TextRef(tier=Tier.CANDIDATE, label="plain", segments=({"text": "hello"},))
    fake = Fake(provider=plain, transcribed=asr_text(), reports=[LINE_SYNCED])
    outcome = await run_align(job(syncMode="lines"), fake)
    assert [(req.text.label, req.force_line_sync) for req in fake.timed] == [("asr:vocals", True)]
    assert outcome.published is not None and outcome.published.label == "asr:vocals"


async def test_lines_mode_does_not_apply_to_a_pin() -> None:
    fake = Fake(pinned=pasted_text(), reports=[CLEAN])
    outcome = await run_align(job(syncMode="lines", pinnedRef=MANUAL, pinnedText=PASTE), fake)
    assert [req.force_line_sync for req in fake.timed] == [False]
    assert outcome.published is not None and outcome.published.timing == TIMING_WORD
    assert any("does not apply to a pin" in why for why in fake.whys)


async def test_lines_mode_on_a_song_with_no_stem_aligns_and_says_why() -> None:
    """The line-sync rung's sheet gate reads a sheet's claimed spans against the singing; on
    the MIX the band fills every silence (39/416 right texts pass, 3/320 wrong: measured), so `lines` on a
    stemless song refused nearly every correct sheet for a transcript or no lyrics. It is aligned as forced
    there, under the forced path's own wrong-text gate, and the facts say what ran."""
    fake = Fake(provider=lrc(), reports=[CLEAN], vocals=False)
    outcome = await run_align(job(syncMode="lines"), fake)
    assert [req.force_line_sync for req in fake.timed] == [False], "a word decode, not the line-sync rung"
    assert outcome.published is not None and outcome.published.timing == TIMING_WORD
    assert outcome.sync_mode == "forced"
    assert any("syncMode=lines needs a vocals stem" in why for why in fake.whys)
    with_stem = await run_align(job(syncMode="lines"), Fake(provider=lrc(), reports=[LINE_SYNCED]))
    assert with_stem.sync_mode == "lines"


async def test_an_unknown_sync_mode_aligns_and_says_so() -> None:
    fake = Fake(provider=lrc(), reports=[CLEAN])
    await run_align(job(syncMode="telepathy"), fake)
    assert [req.force_line_sync for req in fake.timed] == [False]
    assert any("'telepathy' is not a mode" in why for why in fake.whys)


# ── run_align over the REAL steps: the global decode on the CTC fixture ─────────────────────────────


class Probe:
    def __init__(self, duration: float) -> None:
        self.duration = duration

    def duration_sec(self, audio_path: str) -> float:
        return self.duration

    def peak_dbfs(self, audio_path: str) -> float | None:
        return None


class Counting:
    """A provider / caption source / transcriber that must not be consulted by a pinned job."""

    name = "counting"
    last_source: str | None = None

    def __init__(self, cues: Sequence[dict[str, object]] = ()) -> None:
        self.cues = list(cues)
        self.calls = 0

    def fetch(self, *args: object, **kwargs: object) -> Sequence[dict[str, object]]:
        self.calls += 1
        return self.cues

    def transcribe(self, audio_path: str, *, language: str | None = None) -> ports.Transcribed:
        self.calls += 1
        return ports.Transcribed(
            segments=({"start": 5.0, "end": 7.0, "text": "come and fly away"},), language=language
        )


class Spy:
    """The step reporter: every `job:state`, and whether the job is still ours at publish."""

    def __init__(self, *, ours: bool = True) -> None:
        self.states: list[tuple[str, str, str]] = []
        self.ours = ours

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        self.states.append((state, verdict, why))

    async def progress(self, *args: object) -> None: ...

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        return self.ours

    def explain_ownership(self, job_id: str) -> str:
        return "reassigned to w2"


class Rig:
    """A media dir with a stem that sings `UNIQUE` (unless told otherwise), and the real steps over it.

    `stem_sings` is what the stem's and the mix's WAVS sing (what the envelope gate hears); `heard` is what
    their emission matrix sings (what the decode and the lexical lift read)."""

    def __init__(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        *,
        stem_sings: Sequence[Phrase] = UNIQUE,
        heard: Sequence[Phrase] = UNIQUE,
    ) -> None:
        from encore_worker.adapters import ml

        monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
        self.dir = tmp_path
        (tmp_path / "derived" / "stems").mkdir(parents=True)
        (tmp_path / "audio").mkdir()
        self.stem = sung_wav(
            tmp_path / "derived" / "stems" / "m1-vocals.wav", stem_sings, UNIQUE_DURATION, seed=0
        )
        self.mix = sung_wav(tmp_path / "audio" / "m1.wav", stem_sings, UNIQUE_DURATION, seed=1)
        matrix = sung_matrix(heard, DIC, UNIQUE_DURATION)
        self.aligner = PathAligner({self.stem: matrix, self.mix: matrix})
        self.providers = Counting([{"start": 0.0, "end": 1.0, "text": "someone else's words"}])
        self.captions = Counting([{"start": s, "end": e, "text": t} for t, s, e in UNIQUE])
        self.transcriber = Counting()

    def job(self, **params: object) -> JobRef:
        return JobRef(
            job_id="j1",
            media_id="m1",
            media_dir=str(self.dir),
            source_uri="audio/m1.wav",
            params={"artist": "a", "track": "t", **params},
        )

    def fetch(
        self, source_uri: str, out_dir: str, *, on_progress: object = None, with_captions: bool = False
    ) -> str:
        """The rig's upload, already on disk. As `fetcher=local` it would be a library file, uncaptioned."""
        return str(self.dir / source_uri)

    def run(self, ours: bool = True, **params: object) -> tuple[AlignOutcome, Spy]:
        spy = Spy(ours=ours)
        impl = AlignStepsImpl(
            config=Config(),
            adapters=Adapters(
                probe=Probe(UNIQUE_DURATION),
                providers=(self.providers,),
                captions=self.captions,
                fetcher=self,
                transcriber=self.transcriber,
                aligner=self.aligner,
            ),
            reporter=spy,
        )
        return asyncio.run(run_align(self.job(**params), impl)), spy

    def lines(self, ref: str) -> list[dict[str, Any]]:
        loaded: dict[str, Any] = json.loads((self.dir / ref).read_text())
        return list(loaded["lines"])

    def lyrics_files(self) -> list[str]:
        return sorted(p.name for p in (self.dir / "derived" / "lyrics").glob("*.json"))


def starts_near_truth(lines: list[dict[str, Any]], phrases: Sequence[Phrase], within: float = 0.15) -> bool:
    return [line["text"] for line in lines] == [t for t, _s, _e in phrases] and all(
        abs(float(line["start"]) - start) <= within
        for line, (_t, start, _e) in zip(lines, phrases, strict=True)
    )


def test_a_paste_is_decoded_blind_and_written_to_the_manual_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE fix end to end: the paste is the only text, decoded blind on the stem's emissions (the global
    engine, every gate), and the accepted document lands at the ref core pinned, and nowhere else."""
    rig = Rig(tmp_path, monkeypatch)
    outcome, spy = rig.run(pinnedRef=MANUAL, pinnedText=PASTE)

    assert outcome.published is not None, outcome.why
    assert outcome.published.ref == MANUAL and outcome.published.label == "manual"
    assert outcome.published.timing == TIMING_WORD
    assert outcome.candidates == (outcome.published,)
    assert rig.lyrics_files() == ["m1-manual-word.json"], "no rival candidate beside the pinned one"
    assert starts_near_truth(rig.lines(MANUAL), UNIQUE)
    assert rig.aligner.asked == [rig.stem], "one blind decode on the stem: no claims, no repairs, no mix"
    assert (rig.providers.calls, rig.captions.calls, rig.transcriber.calls) == (0, 0, 0)
    assert any(verdict == "pinned" for _state, verdict, _why in spy.states)


def test_a_stored_candidate_is_re_timed_in_place_keeping_its_provenance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`pinnedRef` alone: the stored words, re-timed BLIND (its stale timings are what the person rejected,
    so they are not even read), written back under the same ref so core's merge overwrites it."""
    rig = Rig(tmp_path, monkeypatch)
    ref = "derived/lyrics/m1-captions-authored-align-on-mix-line.json"
    stale = {"language": "en", "lines": [{"text": t, "start": s + 7.0, "end": e + 7.0} for t, s, e in UNIQUE]}
    (tmp_path / "derived" / "lyrics").mkdir()
    (tmp_path / ref).write_text(json.dumps(stale))

    outcome, _spy = rig.run(pinnedRef=ref)

    assert outcome.published is not None and outcome.published.ref == ref, outcome.why
    assert outcome.published.label == "captions:authored", "the textSource survives the re-time"
    assert outcome.published.timing == TIMING_WORD, "a line candidate re-timed to words, under its own ref"
    assert starts_near_truth(rig.lines(ref), UNIQUE), "timed from the audio, not from the stale sheet"
    assert rig.lyrics_files() == [Path(ref).name]
    assert rig.captions.calls == 0, "its original source is not re-fetched either"


@pytest.mark.parametrize(
    ("name", "source", "tier"),
    [("captions-machine", "captions", Tier.MACHINE), ("asr-vocals", "asr", Tier.ASR)],
    ids=["machine-caption", "transcript"],
)
def test_a_re_picked_machine_caption_goes_out_as_the_persons_claim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, source: str, tier: Tier
) -> None:
    """The old worker's pin. Through the real steps and the real
    frame builder: a re-picked machine caption or transcript is re-timed AT ITS TIER (the record says what
    the text is) and sent to core as `high` words, where an earlier version sent the tier's `low`."""
    from encore_worker.__main__ import _align_completion

    rig = Rig(tmp_path, monkeypatch)
    ref = f"derived/lyrics/m1-{name}-word.json"
    stale = {"language": "en", "lines": [{"text": t, "start": s + 7.0, "end": e + 7.0} for t, s, e in UNIQUE]}
    (tmp_path / "derived" / "lyrics").mkdir()
    (tmp_path / ref).write_text(json.dumps(stale))

    outcome, _spy = rig.run(pinnedRef=ref)

    assert outcome.published is not None and outcome.published.ref == ref, outcome.why
    assert outcome.published.tier is tier and tier.text_confidence == "low"
    frame = _align_completion(rig.job(pinnedRef=ref), Config(), outcome, now_ms=1)
    assert frame.artifacts is not None
    sent = frame.artifacts["lyrics"]["candidates"]
    assert [(c["ref"], c["textSource"], c["textConfidence"]) for c in sent] == [(ref, source, "high")]


def test_a_pin_the_lexical_gate_refused_is_published_but_never_sent_as_a_claim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The wrong-paste threat through the real steps: a person pastes words the stem does not sing (here
    a French text on a matrix singing `UNIQUE` — the same shape as re-picking YouTube's machine-translated
    `en` track). The gate does not refuse a pin — a person chose it — so it publishes, every line `low` and
    the document `low`. What must NOT happen is core reading it as a verified claim: a pin's `textConfidence`
    is `high`, and before this the worker's own measurement survived only in `timingConfidence`, which core's
    ranking never reads, so `isAuthoritativeText` was true and the label dropped its "not verified" mark.
    The verdict rides on `vouched`, and `textConfidence` keeps saying who chose the words."""
    from encore_worker.__main__ import _align_completion
    from tests.test_lexical import FRENCH

    rig = Rig(tmp_path, monkeypatch)
    text = "\n".join(FRENCH)
    outcome, spy = rig.run(pinnedRef=MANUAL, pinnedText=text)

    assert outcome.published is not None and outcome.published.ref == MANUAL, outcome.why
    assert outcome.published.vouched is False and outcome.published.confidence == "low"
    assert {line["confidence"] for line in rig.lines(MANUAL)} == {"low"}
    assert any(verdict == "pin-unvouched" for _state, verdict, _why in spy.states)
    frame = _align_completion(rig.job(pinnedRef=MANUAL, pinnedText=text), Config(), outcome, now_ms=1)
    assert frame.artifacts is not None
    sent = frame.artifacts["lyrics"]["candidates"]
    assert [(c["textSource"], c["textConfidence"], c["vouched"], c["timingConfidence"]) for c in sent] == [
        ("manual", "high", False, "low")
    ]


def test_a_re_pick_re_times_the_whole_text_even_when_the_stored_document_lost_lines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The global engine's document holds only the lines it TIMED (a never-sung drop, a row
    with no alignable character), and a re-pick re-times the stored document's words: the lost lines were
    lost from the person's chosen candidate for good. `_write` now records the whole text when lines went
    missing (`sourceLines`), and the re-pick reads it: here the stored candidate had timed 6 of 8 lines,
    and the re-time is all 8, where they are sung."""
    rig = Rig(tmp_path, monkeypatch)
    ref = "derived/lyrics/m1-captions-authored-word.json"
    shown = [{"text": t, "start": s, "end": e} for t, s, e in UNIQUE[:6]]
    stored = {"language": "en", "lines": shown, "sourceLines": [t for t, _s, _e in UNIQUE]}
    (tmp_path / "derived" / "lyrics").mkdir()
    (tmp_path / ref).write_text(json.dumps(stored))

    outcome, _spy = rig.run(pinnedRef=ref)

    assert outcome.published is not None and outcome.published.ref == ref, outcome.why
    written = json.loads((tmp_path / ref).read_text())
    assert starts_near_truth(written["lines"], UNIQUE), "every line of the text, re-timed"
    assert "sourceLines" not in written, "this decode kept the whole text, so nothing extra is written"


def test_a_document_that_lost_lines_records_its_whole_text_and_one_that_kept_them_does_not() -> None:
    """Written only when something is missing, so every document that kept its whole text is byte-for-byte
    what it was before the key existed."""
    from encore_worker.steps.align_text import _with_source_lines

    segments = tuple({"text": t} for t, _s, _e in UNIQUE)
    whole: dict[str, object] = {
        "language": "en",
        "lines": [{"text": f" {t} ", "start": s} for t, s, _e in UNIQUE],
    }
    assert _with_source_lines(whole, segments) is whole
    lost: dict[str, object] = {
        "language": "en",
        "lines": [{"text": t, "start": s} for t, s, _e in UNIQUE if t != "stars are out"],
    }
    kept = _with_source_lines(lost, (*segments, {"text": "  "}))
    assert kept["sourceLines"] == [t for t, _s, _e in UNIQUE] and kept["lines"] is lost["lines"]


def test_a_paste_the_wrong_text_gate_would_refuse_still_publishes_graded_low(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A PERSON chose this text, so it is not judged a wrong text (the old worker never graded a pin).
    Over a stem that sings nothing, the wrong-text gate — on a stem the lexical lift —
    would refuse it: it used to publish NOTHING, and core went on showing the candidate the person had just
    replaced, the reason only on the trail. Now it publishes at the pinned ref, every line `low` and the
    document `low`, and still nothing else is searched for."""
    rig = Rig(tmp_path, monkeypatch, stem_sings=(), heard=())
    (tmp_path / "derived" / "lyrics").mkdir()
    before = json.dumps({"language": "en", "lines": [{"text": "an earlier paste", "start": 1.0, "end": 2.0}]})
    (tmp_path / MANUAL).write_text(before)

    outcome, spy = rig.run(pinnedRef=MANUAL, pinnedText=PASTE)

    assert outcome.published is not None and outcome.published.ref == MANUAL, outcome.why
    assert outcome.published.confidence == "low" and outcome.candidates == (outcome.published,)
    lines = rig.lines(MANUAL)
    assert [line["text"] for line in lines] == [t for t, _s, _e in UNIQUE]
    assert {line["confidence"] for line in lines} == {"low"}
    assert rig.lyrics_files() == ["m1-manual-word.json"]
    assert (rig.providers.calls, rig.captions.calls, rig.transcriber.calls) == (0, 0, 0)
    assert not any(v == "declined" for _s, v, _why in spy.states)
    kept = [why for _s, v, why in spy.states if v == "pin-unvouched"]
    assert len(kept) == 1 and kept[0].startswith("lexical gate refused") and "a person chose" in kept[0]


def test_an_unpinned_text_the_wrong_text_gates_refuse_is_still_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The exemption is the pin's alone: over the same silent stem every automatic text is refused, and the
    job publishes no lyrics rather than any of them. By the gate that reads it: both caption tracks by the
    lexical lift; the provider's one-line sheet (under `lexical.MIN_LETTERS`) and the transcript (the ASR
    tier, exempt from the lift) by the envelope gate."""
    rig = Rig(tmp_path, monkeypatch, stem_sings=(), heard=())
    outcome, spy = rig.run()
    declined = [why for _s, v, why in spy.states if v == "declined"]
    lexical = [why for why in declined if why.startswith("lexical gate refused")]
    envelope = [why for why in declined if why.startswith("envelope gate refused")]
    assert (len(lexical), len(envelope)) == (2, 2) and rig.transcriber.calls == 1
    assert not any(v == "pin-unvouched" for _s, v, _why in spy.states)
    assert outcome.published is None and outcome.no_lyrics


def test_a_missing_stored_candidate_publishes_nothing_and_says_why(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rig = Rig(tmp_path, monkeypatch)
    outcome, spy = rig.run(pinnedRef="derived/lyrics/m1-lrclib-word.json")
    assert outcome.published is None and rig.aligner.asked == []
    assert any(v == "pin-unreadable" and "not on disk" in why for _s, v, why in spy.states)


def test_a_pin_naming_the_stem_never_overwrites_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rig = Rig(tmp_path, monkeypatch)
    stem_bytes = Path(rig.stem).read_bytes()
    outcome, _spy = rig.run(pinnedRef="derived/stems/m1-vocals.wav", pinnedText=PASTE)
    assert outcome.published is None and rig.aligner.asked == []
    assert Path(rig.stem).read_bytes() == stem_bytes


def test_a_lost_lease_leaves_the_pinned_document_as_it_was(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The pinned ref is what the TV shows: nothing reaches it before `publish` confirms the job is ours."""
    rig = Rig(tmp_path, monkeypatch)
    (tmp_path / "derived" / "lyrics").mkdir()
    (tmp_path / MANUAL).write_text("{}")
    outcome, _spy = rig.run(ours=False, pinnedRef=MANUAL, pinnedText=PASTE)
    assert outcome.published is None and "abandoned before publishing" in outcome.why
    assert (tmp_path / MANUAL).read_text() == "{}"


def test_lines_mode_publishes_the_captions_own_line_timings_with_no_word_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One emission pass on the stem, for the rung's checks — the words are sung (the lexical lift)
    where the claims put them (the text's blind decode) — and the captions' own lines published: no
    word timing is kept."""
    rig = Rig(tmp_path, monkeypatch)
    outcome, spy = rig.run(syncMode="lines")
    assert outcome.published is not None and outcome.published.timing == TIMING_LINE, outcome.why
    assert outcome.published.label == "captions:authored"
    assert rig.aligner.asked == [rig.stem], "the stem's matrix, once, for the lexical check alone"
    assert starts_near_truth(rig.lines(outcome.published.ref), UNIQUE, within=0.35)
    assert any(
        v == "line-sync" and "lexical lift +" in why for s, v, why in spy.states if s == "align-line-sync"
    )


def test_lines_mode_publishes_sung_captions_whose_envelope_the_sheet_gate_cannot_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Through the whole job. The sheet-span gate refused 107 of 320 right texts under `syncMode=lines`
    (truth 4/32), reading only the stem's activity envelope. Here that envelope is silent while the
    emission matrix sings every caption where it is claimed: the text's own blind decode is the timing
    witness, and the captions publish at attempt 1 on their own lines."""
    rig = Rig(tmp_path, monkeypatch, stem_sings=())
    outcome, spy = rig.run(syncMode="lines")
    assert outcome.published is not None and outcome.published.timing == TIMING_LINE, outcome.why
    assert outcome.published.label == "captions:authored"
    assert starts_near_truth(rig.lines(outcome.published.ref), UNIQUE, within=0.35)
    (note,) = [why for s, v, why in spy.states if s == "align-line-sync" and v == "line-sync"]
    assert "(not gating: the decode is)" in note and "blind decode starts 100% of 8 lines" in note


#: UNIQUE's lines in other words, on UNIQUE's own spans: a caption track of the same video, translated (into
#: French: the fixture scores letters, so a cognate-heavy translation — German's "komm und flieg weg" — would
#: share its sung letters in order, and does, reading lift +2.0 here where French reads -0.12).
TRANSLATED = [
    ("viens et envole toi", 5.0, 7.0),
    ("avec moi ce soir", 8.0, 10.0),
    ("sur l'eau d'argent", 12.0, 14.5),
    ("ramene moi chez moi", 16.0, 18.0),
    ("les etoiles sont sorties", 22.0, 24.0),
    ("lumiere du matin sur le fleuve", 27.0, 30.0),
    ("tiens bon la nuit", 33.0, 35.0),
    ("ne la lache jamais", 38.0, 40.0),
]


def test_lines_mode_refuses_a_same_video_translation_the_sheet_gate_passes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A caption track of THIS video has timings that describe this audio whatever its words
    say, so the sheet-span gate passes an uploader's translation, or YouTube's machine-translated track —
    and the rung published it. The lexical check reads the words on the stem's matrix, refuses the text,
    and the ladder moves on (here to the transcript, which line-syncs on its own spans)."""
    rig = Rig(tmp_path, monkeypatch)
    rig.captions = Counting([{"start": s, "end": e, "text": t} for t, s, e in TRANSLATED])
    outcome, spy = rig.run(syncMode="lines")

    refused = [why for s, v, why in spy.states if s == "align-line-sync" and v == "refused"]
    lexical = [why for why in refused if "below the lexical gate" in why]
    assert len(lexical) == 2, f"authored AND machine captions, each past the sheet gate: {refused}"
    assert all("sheet-span envelope r=" in why for why in lexical), "the timings DID describe the audio"
    assert outcome.published is not None and outcome.published.label == "asr:vocals", outcome.why
    assert not any("captions" in name for name in rig.lyrics_files()), "the translation is never written"


def test_lines_mode_gates_a_sheet_but_publishes_a_transcript_on_its_own_spans(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Over a stem that sings nothing, every sheet is refused — both caption tracks by the lexical lift, the
    provider's one-line sheet (which neither the lift nor the decode can read: under 40 letters, under 3
    lines) by the sheet gate — but the ASR fallback's transcript was measured on this very recording, so it
    cannot be another song's sheet: it line-syncs rather than the job ending in no lyrics (measured: hello's
    own whisper transcript read r=0.33 @ +0.22 s and was refused before this)."""
    rig = Rig(tmp_path, monkeypatch, stem_sings=(), heard=())
    outcome, spy = rig.run(syncMode="lines")
    refused = [
        why for state, verdict, why in spy.states if state == "align-line-sync" and verdict == "refused"
    ]
    assert len(refused) == 3, "authored captions, the provider's sheet, the machine track: each gated"
    assert sum("below the lexical gate" in why for why in refused) == 2
    assert sum("below the sheet gate" in why and "no decode check" in why for why in refused) == 1
    assert rig.transcriber.calls == 1
    assert outcome.published is not None and outcome.published.label == "asr:vocals", outcome.why
    assert outcome.published.timing == TIMING_LINE and set(rig.aligner.asked) == {rig.stem}


def test_lines_mode_with_no_stem_aligns_the_captions_on_the_mix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The stemless fallback through the real steps: the stem is gone, so `lines` aligns the authored
    captions on the mix (one decode there) and publishes word timings where they are sung."""
    rig = Rig(tmp_path, monkeypatch)
    Path(rig.stem).unlink()
    outcome, spy = rig.run(syncMode="lines")
    assert outcome.published is not None and outcome.published.timing == TIMING_WORD, outcome.why
    assert outcome.published.label == "captions:authored" and outcome.sync_mode == "forced"
    assert rig.aligner.asked == [rig.mix], "decoded on the mix: there is no stem"
    assert starts_near_truth(rig.lines(outcome.published.ref), UNIQUE)
    assert any(verdict == "sync-mode" and "needs a vocals stem" in why for _s, verdict, why in spy.states)


def test_lines_mode_fails_the_job_on_audio_the_machinery_cannot_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Under `syncMode=lines`, where the sheet gate is the ONLY reader of the audio: a file ffmpeg
    will not decode is the machinery's fault, not the text's. It used to come back as the gate's "not
    measured" None for every text alike (3 declines), and the ladder ran on into whisper and a published
    transcript, or "no lyrics", for a song nothing had measured. Now it fails the job, retryable."""
    from encore_worker.adapters import ml

    def unreadable(path: str) -> object:
        raise ports.InfraFault(f"ffmpeg could not decode {path}")

    rig = Rig(tmp_path, monkeypatch)
    monkeypatch.setattr(ml, "load_audio_mono_16k", unreadable)
    with pytest.raises(ports.InfraFault) as failed:
        rig.run(syncMode="lines")
    assert failed.value.retryable
    assert rig.transcriber.calls == 0, "no transcript stood in for a song nothing measured"
    assert not (tmp_path / "derived" / "lyrics").exists(), "nothing written, nothing published"


# ── the ASR model ────────────────────────────────────────────────────────────────────────────────────


class Named:
    def __init__(self, checkpoint: str, used: list[str]) -> None:
        self.checkpoint, self.used = checkpoint, used

    def transcribe(self, audio_path: str, *, language: str | None = None) -> ports.Transcribed:
        self.used.append(self.checkpoint)
        return ports.Transcribed(segments=({"start": 1.0, "end": 2.0, "text": "heard"},), language=language)


@pytest.mark.parametrize(
    ("asked", "used"),
    [(None, "base"), ("base", "base"), ("small", "small"), ("large-v3", "large-v3"), ("turbo", "base")],
)
def test_the_asr_fallback_transcribes_with_the_jobs_model(asked: str | None, used: str) -> None:
    """Core sends the room's `asrModel` on every align job; the worker used its startup model whatever it
    was. A checkpoint this worker may not load falls back to that default, and says so."""
    spent: list[str] = []
    built: list[str] = []

    def build(checkpoint: str) -> ports.Transcriber:
        built.append(checkpoint)
        return Named(checkpoint, spent)

    spy = Spy()
    impl = AlignStepsImpl(
        config=Config(asr_model="base"),
        adapters=Adapters(transcriber=Named("base", spent), transcriber_for=build),
        reporter=spy,
    )
    params = {} if asked is None else {"asrModel": asked}
    ref = JobRef(job_id="j1", media_id="m1", media_dir="/media/m1", params=params)
    audio = AudioRef(path="/media/m1/mix.wav", duration_sec=200.0)
    heard = asyncio.run(impl.transcribe(ref, audio, on_vocals=False))

    assert heard is not None and spent == [used]
    assert built == ([] if used == "base" else [used]), "the startup transcriber serves its own checkpoint"
    fell_back = [why for _s, v, why in spy.states if v == "asr-model"]
    assert bool(fell_back) == (asked == "turbo")


def test_the_align_completion_reports_what_actually_ran() -> None:
    """Core records the REQUEST at dispatch and lets the worker's facts overwrite it."""
    from encore_worker.__main__ import _align_facts

    outcome = AlignOutcome(published=None, why="")
    config = Config(asr_model="base")
    assert _align_facts(job(asrModel="small", syncMode="lines"), config, outcome) == {
        "noLyrics": True,
        "asrModel": "small",
        "syncMode": "lines",
    }
    pinned = _align_facts(
        job(asrModel="turbo", syncMode="lines", pinnedRef=MANUAL, pinnedText="x"), config, outcome
    )
    assert (pinned["asrModel"], pinned["syncMode"]) == ("base", "forced")
    stemless = AlignOutcome(published=None, why="", sync_mode="forced")  # `lines` with no stem ran forced
    assert _align_facts(job(syncMode="lines"), config, stemless)["syncMode"] == "forced"


# ── core's side of the contract, read from its source ────────────────────────────────────────────────


def _core(relative: str) -> str:
    """A core source file, walked up to. FAILS rather than skips: a skipped contract check is green from
    the moment someone moves the file, which is exactly when it needs checking."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "core" / relative
        if candidate.is_file():
            return candidate.read_text()
    raise AssertionError(f"could not find core/{relative} above {here}: the H5 contract is UNCHECKED")


def test_the_ref_core_mints_for_a_fix_is_one_a_pin_may_write() -> None:
    """Core pins `editLyricsRef(mediaId, rev)`, a new name per fix. This is the worker's side, from core's
    template: the pin is honoured, published there, and reads as the host's own words."""
    match = re.search(
        r"export function editLyricsRef\(mediaId: string, rev: number\): string \{\s*return `([^`]+)`",
        _core("src/lib/server/jobs/process.ts"),
    )
    assert match, "editLyricsRef is no longer a one-template return: the mirror cannot be checked"
    ref = match.group(1).replace("${mediaId}", "m1").replace("${rev}", "3")
    assert ref == "derived/lyrics/m1-edit-r3.json"
    from encore_worker.steps.align_text import _pinned_label

    assert pin_of(job(pinnedRef=ref, pinnedText=PASTE)) == Pin(ref=ref, pasted=PASTE)
    assert _pinned_label(ref, "m1") == "manual"


def test_the_params_the_worker_reads_are_the_ones_core_declares() -> None:
    body = re.search(
        r"export interface JobParams \{(.*?)\n\}", _core("src/lib/contract/core/events.ts"), re.S
    )
    assert body, "JobParams not found in events.ts"
    for name in ("pinnedRef", "pinnedText", "asrModel", "syncMode"):
        assert re.search(rf"\b{name}\?\s*:\s*string;", body.group(1)), f"JobParams.{name} is gone or renamed"


def test_the_modes_and_models_core_offers_are_ones_the_worker_knows() -> None:
    engines = _core("src/lib/contract/lyrics/lyrics-engines.ts")

    def ids(const: str) -> set[str]:
        block = re.search(rf"export const {const}[^=]*=\s*\[(.*?)\n\];", engines, re.S)
        assert block, f"{const} not found in lyrics-engines.ts"
        return set(re.findall(r"id: '([^']+)'", block.group(1)))

    assert ids("SYNC_MODES") == {mode.value for mode in SyncMode}
    assert ids("ASR_MODELS") <= set(ASR_MODELS), "core can pick a checkpoint this worker would refuse"
    assert re.search(r"DEFAULT_SYNC_MODE: SyncModeId = '(\w+)'", engines).group(1) == SyncMode.FORCED  # type: ignore[union-attr]
    assert re.search(r"DEFAULT_ASR_MODEL: AsrModelId = '([\w-]+)'", engines).group(1) == Config().asr_model  # type: ignore[union-attr]
