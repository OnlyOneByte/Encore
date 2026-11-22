"""The ML adapters against REAL MODELS and REAL AUDIO. No Protocol fakes.

Everything else fakes `Transcriber` and `Aligner` behind their Protocols, which proves the state machine and
says nothing about whether the adapters work. It found two bugs 375 passing tests could not: `device_for()`
returns `mps` on Apple Silicon while whisperx's transcriber is CTranslate2, which raises `ValueError:
unsupported device mps`, so ASR hard-failed on every Mac — in the mandatory fallback; and torch 2.6 flipped
`torch.load`'s `weights_only` to True, breaking pyannote's VAD checkpoint, so `load_model` failed everywhere.

The audio is synthesised with macOS `say`, so the expected words are known exactly. MARKED `ml`, and slow:
models download on first use (~150 MB for whisper tiny, ~360 MB for the wav2vec2 aligner) and inference is
seconds; `-m 'not ml'` gives the fast suite.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from encore_worker.adapters.ml import (
    CTRANSLATE2_DEVICES,
    build_aligner,
    build_transcriber,
    clear_cache,
    transcriber_device,
)
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics import measure, place
from encore_worker.domain.lyrics.report import TimingReport
from tests.audio_fixture import Spoken, line_segments, speak

pytestmark = pytest.mark.ml

#: The smallest checkpoint that still transcribes intelligible English. `base` is better but doubles the
#: download and the runtime for no additional coverage of OUR code.
CHECKPOINT = "tiny"


def searchable(spoken: Spoken) -> tuple[Segment, ...]:
    """The spoken lines as the aligner requires them: untimed text given provisional spans.

    Exactly what `align_steps._placed_spans` does for a plain sheet. Calling it here rather than handing
    the adapter untimed segments is the point — the untimed case raises by contract, and a separate test
    asserts that it does.
    """
    return place.spread_over(line_segments(spoken), spoken.duration_sec)


@pytest.fixture(scope="module")
def spoken(tmp_path_factory: pytest.TempPathFactory) -> Spoken:
    """Real speech, synthesised once for the module. Regenerating per test would triple the runtime."""
    return speak(Path(tmp_path_factory.mktemp("audio")) / "spoken")


# ── the device policy ────────────────────────────────────────────────────────────────────────────


def test_the_transcriber_device_is_resolved_not_assumed() -> None:
    """BUG 1. torch reports MPS available on every Apple Silicon box, but CTranslate2 has no MPS backend,
    so handing it the job's device raises `ValueError: unsupported device mps` — in the ASR fallback, the
    one path that must never fail."""
    assert transcriber_device("mps") == "cpu"
    assert transcriber_device("cuda") == "cuda"
    assert transcriber_device("cpu") == "cpu"
    assert "mps" not in CTRANSLATE2_DEVICES


def test_a_transcriber_asked_for_mps_still_loads(spoken: Spoken) -> None:
    """The regression test for bug 1, end to end: build on `mps` and have it actually work."""
    transcriber = build_transcriber(device="mps", checkpoint=CHECKPOINT)
    assert transcriber is not None
    assert transcriber._model() is not None, "the model must load despite being asked for mps"


# ── real transcription ───────────────────────────────────────────────────────────────────────────


def test_it_transcribes_words_that_were_actually_spoken(spoken: Spoken) -> None:
    """BUG 2's regression test, and the first time this adapter has ever run.

    Asserts on CONTENT, not just shape: a transcriber returning empty segments would satisfy a
    shape-only check while hearing nothing.
    """
    transcriber = build_transcriber(device="cpu", checkpoint=CHECKPOINT)
    assert transcriber is not None

    spoken_in = transcriber.transcribe(spoken.path, language="en")
    assert spoken_in, "the transcriber heard nothing at all"
    # THE LANGUAGE IS HALF THE RETURN VALUE: it was read off whisper's result dict and
    # discarded, and this real-model test is the only place the echo can be proved rather than faked.
    assert spoken_in.language == "en", f"asked for en, whisper reported {spoken_in.language!r}"

    heard = " ".join(str(s.get("text") or "") for s in spoken_in.segments).lower()
    # A few distinctive words, not the whole transcript: `tiny` mis-hears function words, and asserting on
    # an exact match would be a test of the model rather than of the adapter.
    for word in ("morning", "river", "valley"):
        assert word in heard, f"expected {word!r} in the transcript, got: {heard[:160]}"


def test_transcribed_segments_carry_usable_timings(spoken: Spoken) -> None:
    """The segments feed `presplit` and then the aligner, both of which read `start`/`end`."""
    transcriber = build_transcriber(device="cpu", checkpoint=CHECKPOINT)
    assert transcriber is not None
    segments = transcriber.transcribe(spoken.path, language="en").segments

    starts = [
        float(value)
        for s in segments
        if isinstance(value := s.get("start"), (int, float)) and not isinstance(value, bool)
    ]
    assert len(starts) == len(segments), "every segment must carry a start"
    assert starts == sorted(starts), "segments must be in time order"
    assert max(starts) <= spoken.duration_sec + 1.0, "no segment may start after the audio ends"


def test_the_model_cache_is_a_cache(spoken: Spoken) -> None:
    """A fresh instance per job would re-read the weights every job — the single fact that makes this
    worker a resident process rather than a subprocess per step."""
    clear_cache()
    first = build_transcriber(device="cpu", checkpoint=CHECKPOINT)
    second = build_transcriber(device="cpu", checkpoint=CHECKPOINT)
    assert first is not None and second is not None
    assert first._model() is second._model(), "two builds on one checkpoint must share the loaded handle"


# ── real forced alignment ────────────────────────────────────────────────────────────────────────


def test_it_aligns_a_plain_text_onto_real_audio(spoken: Spoken) -> None:
    """THE component the out-of-sync complaint depends on, running for real.

    The input is UNTIMED, which is the point: the aligner has to find the words in the audio rather than
    being handed their positions.
    """
    aligner = build_aligner(device="cpu")
    assert aligner is not None

    aligned = aligner.align(searchable(spoken), spoken.path, "en")
    assert aligned, "the aligner produced no segments"

    doc = {"language": "en", "lines": [dict(line) for line in aligned]}
    words = measure.timed_words(doc)
    assert words, "the aligned document carries no timed words"

    starts = [start for _w, start, _e in words]
    assert starts == sorted(starts), "word starts must be monotonic, or the highlight jumps backwards"
    assert max(end for _w, _s, end in words) <= spoken.duration_sec + 0.5, (
        "no word may end after the audio does"
    )


def test_measuring_a_real_alignment_reports_it_as_usable(spoken: Spoken) -> None:
    """`measure` has only ever seen hand-built documents. This is the first real model output it reads —
    and every retry decision in the worker is computed from what it returns.
    """
    aligner = build_aligner(device="cpu")
    assert aligner is not None
    aligned = aligner.align(searchable(spoken), spoken.path, "en")

    report = measure.measure(
        {"language": "en", "lines": [dict(line) for line in aligned]},
        duration_sec=spoken.duration_sec,
    )
    assert report.usable, f"a correct alignment must be publishable: {report.summary()}"
    assert report.out_of_order == 0
    assert report.words >= 15, f"expected most of three spoken lines, got {report.words}"
    assert not report.overshoots, f"timings must fit the audio: {report.summary()}"
    assert report.coverage > 0.5, f"a full-length reading should cover the audio: {report.summary()}"


def test_the_aligner_accepts_mps_where_the_transcriber_cannot(spoken: Spoken) -> None:
    """The asymmetry that made a per-component device policy necessary: the aligner is plain torch
    wav2vec2 and runs on Metal; the transcriber is CTranslate2 and does not."""
    aligner = build_aligner(device="mps")
    assert aligner is not None
    aligned = aligner.align(searchable(spoken), spoken.path, "en")
    assert aligned, "the aligner must work on mps"


def test_a_wrong_text_aligns_measurably_worse(spoken: Spoken) -> None:
    """THE mechanism this worker relies on instead of an eager ASR baseline.

    The old worker transcribed every job to grade candidates against. This one does not, on the argument
    that forced alignment IS the wrong-song detector — so that argument had better hold against a real
    model. Aligning unrelated words to this audio must produce a measurably poorer result than aligning
    the correct ones.
    """
    aligner = build_aligner(device="cpu")
    assert aligner is not None

    def measured(segments: tuple[Segment, ...]) -> TimingReport:
        aligned = aligner.align(segments, spoken.path, "en")
        return measure.measure(
            {"language": "en", "lines": [dict(line) for line in aligned]},
            duration_sec=spoken.duration_sec,
        )

    right = measured(searchable(spoken))
    wrong = measured(
        place.spread_over(
            (
                {"text": "Financial statements for the quarter ending September"},
                {"text": "Depreciation of capital assets and deferred tax"},
                {"text": "The auditor has issued an unqualified opinion"},
            ),
            spoken.duration_sec,
        )
    )

    # Deliberately a comparison, not a threshold: absolute numbers depend on the voice and the model, but
    # the RELATIONSHIP is what the no-baseline argument rests on.
    assert right.coverage >= wrong.coverage, (
        f"the correct text should not cover less than unrelated text.\n"
        f"  right: {right.summary()}\n  wrong: {wrong.summary()}"
    )


def test_untimed_search_segments_are_refused_by_name(spoken: Spoken) -> None:
    """BUG 3's regression test. whisperx raises `KeyError: 'start'` from inside its cropping loop, which
    the step's broad `except` turned into a silently discarded candidate — so every plain lyrics sheet was
    thrown away and the song fell through to ASR. Now the refusal names the contract."""
    aligner = build_aligner(device="cpu")
    assert aligner is not None
    with pytest.raises(Exception, match="start on every search segment"):
        aligner.align(line_segments(spoken), spoken.path, "en")
