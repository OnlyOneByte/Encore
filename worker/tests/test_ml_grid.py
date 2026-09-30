"""The emission FRAME GRID, the blank the vocabulary names, and the bounded matrix cache (review 6a/M9/M10).

WHY THIS FILE EXISTS. Everything the review found wrong about the evidence layer's clock was arithmetic —
a 30 s chunk yields 1499 frames and not 1500, so a `duration / frames` ratio stretched every frame and
stamped words up to 20 ms late by the end of each chunk; the final sliver was dropped while its seconds
still counted, drifting odd-length songs 50-60 ms late after 2:30 — and arithmetic is testable without a
model, weights or audio. `test_ml_contract.py` holds the REAL pass to the same grid, and pays for weights
to do it; this file is the part that must stay fast, so a refactor of the stitching is caught here first.

W0 recorded that no chunk-boundary test existed. The one here is exact rather than statistical: a stand-in
model whose every output frame is a LOCAL function of the samples it saw cannot have an opinion about which
pass computed a frame, so the chunked pass with its trimmed context must equal a SINGLE whole-file pass
frame for frame. Any difference is the stitching, which is the whole of review 6a. What only real weights
can show — that a boundary frame with 2 s of context is a BETTER frame — is the bench's job (the review
measured ±100 78.7 → 80.1 on Jamendo word onsets).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from encore_worker.adapters import ml
from encore_worker.adapters.ports import InfraFault

torch: Any = pytest.importorskip("torch")

RATE = ml._EMISSION_SAMPLE_RATE
HOP = ml._FRAME_HOP_SAMPLES
FIELD = ml._FRAME_FIELD_SAMPLES
CHUNK = ml._EMISSION_CHUNK_SEC * RATE
CONTEXT = ml._EMISSION_CONTEXT_SEC * RATE

#: A torchaudio-bundle dictionary: `-` is the blank at 0, `|` the word separator (`whisperx` lowercases).
TORCHAUDIO_DIC = {ch: i for i, ch in enumerate("-|etaoinshrdlucmwfgypbvkjxqz'")}


# ── the grid, as pure arithmetic ──────────────────────────────────────────────────────────────────


def test_a_frame_is_exactly_twenty_milliseconds() -> None:
    """`frame_sec` is the model's hop, not a ratio read off a matrix: 320 samples at 16 kHz (review 6a)."""
    assert ml.FRAME_SEC == 0.02
    assert ml.FRAME_SEC == HOP / RATE
    assert (FIELD, HOP) == (400, 320), "wav2vec2's receptive field and hop; the grid is built on them"


@pytest.mark.parametrize(
    "seconds",
    [0.0, 0.01, 0.025, 1.5, 29.999, 30.0, 30.02, 59.98, 60.0, 90.0, 194.3, 476.0],
)
def test_the_grid_covers_every_hop_of_the_audio_exactly_once(seconds: float) -> None:
    """One frame per 320 samples, INCLUDING the final partial one, and each stamped at `k * FRAME_SEC`.

    The two defects this pins, both measured by the review: the old pass broke out of its loop on a final
    sliver under 0.1 s (up to five frames of the song simply absent, while `duration / frames` still counted
    their seconds — 50-60 ms of drift after 2:30), and it never laid its chunks on one grid at all.
    """
    total = int(seconds * RATE)
    passes = ml._frame_passes(total)
    want = -(-total // HOP)
    assert sum(p.keep for p in passes) == want, "ceil(samples / hop) frames, the sliver included"

    # The kept frames of the passes, in order, must be 0, 1, 2, ... with no gap and no repeat.
    stamped: list[int] = []
    for plan in passes:
        first = plan.offset // HOP + plan.trim
        stamped.extend(range(first, first + plan.keep))
    assert stamped == list(range(want))


@pytest.mark.parametrize("seconds", [0.02, 1.5, 30.0, 45.5, 90.0, 194.3])
def test_every_pass_is_long_enough_for_the_frames_it_keeps_and_reads_no_further(seconds: float) -> None:
    """A frame needs 400 samples of input; the last one it keeps gets them, by padding if the audio ends.

    PADDING ONLY EVER SUPPLIES SAMPLES THE AUDIO DOES NOT HAVE, which is the invariant, and it is NOT "only
    the final pass pads" — the assertion here used to say that and was false (W4 review r1). A pass pads when
    the receptive field of its last KEPT frame runs past the audio's end, and `stop` is capped at `total`, so
    an INTERIOR pass pads whenever its 2 s of right context reaches the end of the file: at 1 920 001 samples
    the grid's 6001 frames make five passes and pass 3 (which keeps frames 4500..5999, the last field ending
    79 samples past the file) pads while pass 4 still exists to stamp frame 6000. The tested property is
    therefore the implication — padded implies `stop == total` — with the interior case pinned by name below.
    """
    total = int(seconds * RATE)
    passes = ml._frame_passes(total)
    for plan in passes:
        produced = (plan.samples - FIELD) // HOP + 1
        assert produced >= plan.trim + plan.keep, "the model could not emit the frames this pass keeps"
        assert plan.stop <= total, "read past the end of the audio"
        assert plan.offset % HOP == 0, "an offset off the grid makes `trim` a rounding"
        if plan.samples > plan.stop - plan.offset:
            assert plan.stop == total, "padded a pass whose audio continues"
        else:
            assert plan.samples == plan.stop - plan.offset, "a pass longer than the slice it reads"


@pytest.mark.parametrize(("total", "padded"), [(1_920_001, {3, 4}), (480_001, {0, 1}), (960_079, {1, 2})])
def test_an_interior_pass_pads_when_its_right_context_reaches_the_end_of_the_audio(
    total: int, padded: set[int]
) -> None:
    """The case the test above asserted away (W4 review r1): a NON-FINAL pass that needs padding.

    The lengths the parametrised sweep uses (0.02, 1.5, 30.0, 45.5, 90.0, 194.3 s) all miss it, so
    "an interior pass never needs padding" passed for six lengths and would have failed on the first song
    shaped like these — while `_frame_passes` was right all along. At 1 920 001 samples TWO passes pad and
    only one of them is last; at 960 079 the padded interior pass is one single sample short.
    """
    passes = ml._frame_passes(total)
    assert {i for i, p in enumerate(passes) if p.samples > p.stop - p.offset} == padded
    assert padded - {len(passes) - 1}, "this length must pad an INTERIOR pass, or it tests nothing"
    for plan in passes:
        assert plan.stop == total or plan.samples == plan.stop - plan.offset
        assert (plan.samples - FIELD) // HOP + 1 >= plan.trim + plan.keep


def test_a_sliver_shorter_than_the_receptive_field_is_padded_not_dropped() -> None:
    """The review's `evidence-8`: 24000 samples is 75 whole hops, and the 75th frame needs 80 samples the
    file does not have. The old pass dropped it (and any tail under 0.1 s outright)."""
    passes = ml._frame_passes(24000)
    assert len(passes) == 1 and passes[0].keep == 75
    assert passes[0].stop == 24000, "it reads everything there is"
    assert passes[0].samples == FIELD + 74 * HOP == 24080, "and pads the last frame's field"

    tiny = ml._frame_passes(100)
    assert len(tiny) == 1 and tiny[0].keep == 1 and tiny[0].samples == FIELD
    assert ml._frame_passes(0) == [] and ml._frame_passes(-5) == []


def test_each_chunk_carries_two_seconds_of_context_it_then_throws_away() -> None:
    """The context is COMPUTED and DISCARDED (ctc-forced-aligner's `generate_emissions`), which is what buys
    a boundary frame its receptive field for ~+13% of the compute rather than 2x for an overlap-and-blend."""
    passes = ml._frame_passes(90 * RATE)
    assert [p.keep for p in passes] == [1500, 1500, 1500], "30 s of grid frames per pass"
    assert passes[0].offset == 0 and passes[0].trim == 0, "there is nothing to the left of the first pass"
    for plan in passes[1:]:
        assert plan.trim == CONTEXT // HOP == 100, "2 s of left context, trimmed"
    assert passes[1].offset == 28 * RATE, "the second pass starts reading 2 s before its first stamp"
    # 30 s of stamps + 2 s either side, except at the ends of the song, where there is nothing to read:
    # 1.09x at 90 s, 1.12x at the 194 s the emission pass is timed on, 1.13x at an hour.
    assert _fed_ratio(90.0) == pytest.approx(1.089, abs=0.002)
    assert _fed_ratio(194.3) == pytest.approx(1.124, abs=0.002)
    assert _fed_ratio(3600.0) == pytest.approx(1.132, abs=0.002)


def _fed_ratio(seconds: float) -> float:
    total = int(seconds * RATE)
    return sum(p.samples for p in ml._frame_passes(total)) / total


# ── the blank the vocabulary names (review M9) ────────────────────────────────────────────────────


def test_the_blank_is_read_from_the_vocabulary_and_is_not_always_zero() -> None:
    """whisperx's own rule (`alignment.py`), on the vocabularies the review dumped from the Hub.

    23 of whisperx's 36 HF align models put their pad somewhere other than 0; these are the three the
    review measured, plus a torchaudio bundle, whose blank is its label 0 and which is why a hard-coded 0
    survived for as long as the language was always `en`.
    """
    assert ml.blank_id_of(TORCHAUDIO_DIC) == 0
    assert ml.blank_id_of({"u": 0, "a": 1, "<pad>": 32}) == 32, "Danish (saattrupdan): `u` sits at 0"
    assert ml.blank_id_of({"|": 0, "a": 1, "[pad]": 38}) == 38, "Norwegian Bokmal: `|` sits at 0"
    assert ml.blank_id_of({"[pad]": 1204, "a": 0}) == 1204, "Korean (kresnik)"
    assert ml.blank_id_of({}) == 0, "a vocabulary that names no pad is a torchaudio bundle's"


def test_the_specials_are_named_so_a_later_filter_has_a_list_to_read() -> None:
    """`blank_id` is the one this wave acts on; `|` is named because it is a CHARACTER a lyric can contain
    and review 6c (disputed) is the reader that would act on it."""
    assert ml.specials_of(TORCHAUDIO_DIC) == {"|": 1, "-": 0}
    assert ml.specials_of({"<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3, "|": 4, "a": 5}) == {
        "<pad>": 0,
        "<s>": 1,
        "</s>": 2,
        "<unk>": 3,
        "|": 4,
    }
    assert "-" not in ml.specials_of({"[pad]": 32, "-": 5, "a": 0}), "a real hyphen is not a special"


# ── the chunked pass against a single whole-file pass ─────────────────────────────────────────────


class _LocalModel:
    """A stand-in wav2vec2 whose every output frame is a function of the 400 samples it saw, and of
    nothing else — no position within the slice, no slice length.

    That is what makes the comparison EXACT: such a model cannot tell which pass computed a frame, so a
    chunked pass and a single whole-file pass must produce identical frames, and any difference is the
    stitching arithmetic review 6a replaced.
    """

    def __init__(self) -> None:
        #: Sample counts of every slice it was handed, so a test can see the context was really computed.
        self.fed: list[int] = []

    def parameters(self) -> Iterator[Any]:
        return iter([torch.zeros(1)])  # `emissions` reads the device off the first parameter

    def __call__(self, batch: Any) -> tuple[Any]:
        samples = batch[0]
        self.fed.append(int(samples.numel()))
        frames = (int(samples.numel()) - FIELD) // HOP + 1
        logits = torch.zeros(1, frames, 4, dtype=torch.float32)
        for j in range(frames):
            field = samples[j * HOP : j * HOP + FIELD]
            logits[0, j, 1] = field[0]
            logits[0, j, 2] = field[-1]
            logits[0, j, 3] = field.sum() / FIELD
        return (logits,)


class _Rigged(ml.WhisperXAligner):
    """`emissions()` with a known model and no Hub, so the grid is all that is under test.

    The LOADED model is `_local`, deliberately not the inherited `_model` — which since W4b 6b holds the
    English bundle's NAME (`ALIGN_MODELS_BY_DEVICE`, `ENCORE_ALIGN_MODEL`) rather than a loaded object."""

    def __init__(self, model: _LocalModel, jobs: int = 1, bundle: str = "local-test-model") -> None:
        super().__init__(device="cpu", jobs=jobs)
        self._local = model
        self._bundle = bundle

    def _aligner(self, language: str) -> tuple[Any, Any]:
        return self._local, {"dictionary": TORCHAUDIO_DIC}

    def _bundle_name(self, language: str) -> str:
        return self._bundle


def _whole_file(model: _LocalModel, mono: Any) -> Any:
    """One pass over the whole (padded) file — the answer the chunked pass has to reproduce."""
    frames = -(-len(mono) // HOP)
    need = FIELD + (frames - 1) * HOP
    piece = mono if len(mono) >= need else torch.nn.functional.pad(mono, (0, need - len(mono)))
    with torch.inference_mode():
        logits = model(piece.unsqueeze(0))[0]
        return torch.log_softmax(logits, dim=-1)[0][:frames]


def _audio(tmp_path: Path, seconds: float) -> tuple[Path, Any]:
    """A deterministic pseudo-random signal, so every 400-sample field has its own signature."""
    import soundfile as sf

    signal = np.random.default_rng(4).uniform(-0.9, 0.9, int(seconds * RATE)).astype(np.float32)
    path = tmp_path / "audio.wav"
    sf.write(path, signal, RATE)
    return path, torch.from_numpy(signal)


@pytest.mark.parametrize("seconds", [1.5, 1.51, 29.6, 29.999, 30.0, 34.0, 61.3])
def test_a_word_at_a_chunk_boundary_lands_where_a_single_pass_puts_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seconds: float
) -> None:
    """THE CHUNK-BOUNDARY CONTINUITY TEST W0 recorded as missing.

    `34.0` and `61.3` straddle the 30 s and 60 s boundaries; `29.6` and `1.5` end inside a chunk on a
    sliver. Every frame of the chunked matrix must equal the single-pass matrix's frame of the same index —
    not merely be close — so a word at a boundary is stamped at the same 20 ms frame either way. Under the
    old pass the second chunk's frames all sat 20 ms early against this reference and the sliver was gone.

    `1.51` AND `29.999` ARE WHAT HOLDS `frame_sec` (W4 review r1). Every other length here is an exact
    multiple of 320 samples (24000, 473600, 480000, 544000, 980800), and the grid has `ceil(samples / 320)`
    frames, so at those lengths the OLD `duration / frames` equals 0.02 to the last bit and reverting the
    constant was invisible: the mutation survived the whole suite. 1.51 s is 24160 samples — 75.5 hops, so
    76 frames and a derived 0.019868 — and 29.999 s is 479984, a derived 0.0199993; the assertion below now
    fails on either formula but the constant.
    """
    path, mono = _audio(tmp_path, seconds)
    monkeypatch.setattr(ml, "load_audio_mono_16k", lambda _p: mono.numpy())
    model = _LocalModel()
    emitted = _Rigged(model).emissions(str(path), "en")

    want = _whole_file(_LocalModel(), mono)
    assert emitted.frames == want.shape[0] == -(-len(mono) // HOP)
    assert torch.equal(emitted.log_probs, want), "the chunked grid is not the single pass's grid"
    assert emitted.frame_sec == 0.02
    assert emitted.model == "local-test-model"
    assert emitted.blank_id == 0 and emitted.specials == {"-": 0, "|": 1}


def test_the_context_frames_are_computed_and_then_discarded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The context cost, on the pass itself: a 90 s song is stamped as 4500 frames (exactly 90 s of grid)
    while 98 s of audio goes through the model."""
    path, mono = _audio(tmp_path, 90.0)
    monkeypatch.setattr(ml, "load_audio_mono_16k", lambda _p: mono.numpy())
    model = _LocalModel()
    emitted = _Rigged(model).emissions(str(path), "en")
    assert emitted.frames == 4500
    assert len(model.fed) == 3, "30 s of stamps per pass"
    assert model.fed == [512080, 544080, 512080], "2 s of context per side, where there is audio to read"
    assert sum(model.fed) / len(mono) == pytest.approx(1.089, abs=0.002)


def test_a_model_whose_stride_is_not_the_grids_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Silent drift is what review 6a removed, so a bundle whose frame rate is not the 320/400 grid's raises
    rather than producing a mis-stamped chunk — as an `InfraFault`, since it is the model, not a text.

    BOTH DIRECTIONS (W4 review r1). The guard used to be `len(got) < trim + keep`, which only caught the
    COARSE half: a finer-stride bundle emits MORE frames than the slice implies, so the slice `got[trim :
    trim + keep]` passed the one-sided test while taking frames that do not sit at the grid positions they
    are then stamped at — a 10 ms-hop model's first pass covering 15 s of audio in a matrix claiming 30,
    with `frame_sec` still 0.02. Equality is the only test that catches that.
    """
    path, mono = _audio(tmp_path, 40.0)
    monkeypatch.setattr(ml, "load_audio_mono_16k", lambda _p: mono.numpy())

    class _Coarse(_LocalModel):
        def __call__(self, batch: Any) -> tuple[Any]:
            (logits,) = super().__call__(batch)
            return (logits[:, ::2],)  # half the frame rate

    class _Fine(_LocalModel):
        def __call__(self, batch: Any) -> tuple[Any]:
            (logits,) = super().__call__(batch)
            return (logits.repeat_interleave(2, dim=1),)  # twice the frame rate: a 10 ms hop

    for model in (_Coarse(), _Fine()):
        with pytest.raises(InfraFault, match="frame rate is not the one"):
            _Rigged(model).emissions(str(path), "en")


# ── the bounded, content-keyed cache (review M10) ─────────────────────────────────────────────────


def test_a_replaced_stem_is_a_cache_miss_not_a_stale_matrix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """REVIEW M10's measured case: `artifacts/local.py` publishes a stems upgrade by `os.replace` over the
    SAME vocals key, so a path-keyed matrix outlived the audio it was computed from and a later re-pick
    aligned the new stem's text against the old stem's frames."""
    import os

    import soundfile as sf

    ml.clear_cache()
    first, mono = _audio(tmp_path, 1.0)
    monkeypatch.setattr(ml, "load_audio_mono_16k", lambda p: _read(p))

    def _read(path: str) -> Any:
        data, _rate = sf.read(path, dtype="float32", always_2d=False)
        return data

    model = _LocalModel()
    aligner = _Rigged(model)
    before = aligner.emissions(str(first), "en")
    assert aligner.emissions(str(first), "en") is before, "the same file is served from memory"
    assert len(model.fed) == 1

    better = tmp_path / "upgraded.wav"
    sf.write(better, np.random.default_rng(9).uniform(-0.9, 0.9, RATE).astype(np.float32), RATE)
    os.replace(better, first)  # the stems upgrade, exactly as the store publishes one
    after = aligner.emissions(str(first), "en")
    assert after is not before, "the replaced stem was served the old stem's emissions"
    assert not torch.equal(after.log_probs, before.log_probs)
    ml.clear_cache()


def test_two_bundles_over_one_audio_file_do_not_share_one_matrix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W4b REVIEW R2, tests-18: the key's BUNDLE component was untested — dropping it from
    `_cached_emissions((*content, bundle, language, self._device), ...)` passed the whole suite, because every
    test here runs one bundle. The sibling invariant one layer up IS pinned
    (`test_ml_devices.test_two_bundles_on_one_device_do_not_share_one_loaded_handle`, the `_MODELS` keys);
    this is the matrix half.

    WHAT IT COSTS WITHOUT IT: `Emissions.model` is the VOCABULARY's identity and every emission-scale
    threshold is read off it (`lexical.calibration`), so one audio file aligned by two bundles in one process
    — the bench's `--verify-cache` builds two aligners, and `ENCORE_ALIGN_MODEL` can change between two jobs
    of one worker — would serve the second bundle's job the first bundle's frames, STAMPED WITH THE FIRST
    BUNDLE'S NAME, so the gates would read the right row against the wrong matrix and nothing would say so.
    """
    import soundfile as sf

    ml.clear_cache()
    path, _mono = _audio(tmp_path, 1.0)
    monkeypatch.setattr(ml, "load_audio_mono_16k", lambda p: sf.read(p, dtype="float32", always_2d=False)[0])
    model = _LocalModel()
    base = _Rigged(model, bundle="WAV2VEC2_ASR_BASE_960H").emissions(str(path), "en")
    hubert = _Rigged(model, bundle="HUBERT_ASR_LARGE").emissions(str(path), "en")
    assert base.model == "WAV2VEC2_ASR_BASE_960H"
    assert hubert.model == "HUBERT_ASR_LARGE", "the second bundle was served the first bundle's matrix"
    assert base is not hubert and len(ml._EMISSIONS) == 2, "one entry per (audio, bundle), not per audio"
    assert len(model.fed) == 2, "each bundle paid for its own forward pass over the one 1 s file"
    # ...and each entry is still the one its own bundle is served from, with no further pass.
    assert _Rigged(model, bundle="WAV2VEC2_ASR_BASE_960H").emissions(str(path), "en") is base
    assert _Rigged(model, bundle="HUBERT_ASR_LARGE").emissions(str(path), "en") is hubert
    assert len(model.fed) == 2
    ml.clear_cache()


def test_the_matrix_cache_is_bounded_and_separate_from_the_model_weights(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other half of M10: the matrices used to live in `_MODELS`, which must never evict because
    reloading multi-GB weights is why this worker is a resident process — so every song a box ever aligned
    stayed resident. Least-recently-used goes first, and the model dict is left alone."""
    import soundfile as sf

    ml.clear_cache()
    paths = []
    for index in range(ml._EMISSION_CACHE_SIZE + 2):
        path = tmp_path / f"song{index}.wav"
        sf.write(path, np.random.default_rng(index).uniform(-0.5, 0.5, RATE).astype(np.float32), RATE)
        paths.append(path)
    monkeypatch.setattr(ml, "load_audio_mono_16k", lambda p: sf.read(p, dtype="float32", always_2d=False)[0])
    aligner = _Rigged(_LocalModel())
    for path in paths:
        aligner.emissions(str(path), "en")
    assert len(ml._EMISSIONS) == ml._EMISSION_CACHE_SIZE
    assert ml._MODELS == {}, "a matrix must never land in the weights cache again"
    # The oldest two are gone; the newest is still there and is served without a forward pass.
    served = aligner.emissions(str(paths[-1]), "en")
    assert aligner.emissions(str(paths[-1]), "en") is served
    assert len(ml._EMISSIONS) == ml._EMISSION_CACHE_SIZE
    ml.clear_cache()
    assert not ml._EMISSIONS


def test_the_cache_bound_grows_with_concurrency_and_always_holds_every_live_matrix() -> None:
    """W4 review r1 derived the bound from `Config.concurrency`; review r2 found nothing PINNED it — both
    existing assertions call `_emission_cache_size` on their own right-hand side, so `return 4` (the flat
    bound that made a 3-job box evict its own live matrices and re-pay the forward pass on every attempt
    after the first) passes them. These are the two properties the derivation exists for, stated without
    calling the function to describe itself.

    THE LIVE SET MUST FIT: a job reads two matrices at once (its align target and the MIX witness R4
    decodes, `_MATRICES_PER_JOB`), and `transport.client` really does run `concurrency` jobs at once —
    `ML_LOCK` serialises the model, never the interleaving of steps.
    """
    assert ml._emission_cache_size(3) > ml._emission_cache_size(1), "the bound must move with concurrency"
    for jobs in (0, 1, 2, 3, 8, 32):
        got = ml._emission_cache_size(jobs)
        assert got >= ml._MATRICES_PER_JOB * max(1, jobs), f"jobs={jobs}: the live set does not fit in {got}"
        assert got > ml._MATRICES_PER_JOB * max(1, jobs) - 1, f"jobs={jobs}: no history kept"
    assert ml._EMISSION_CACHE_SIZE == ml._emission_cache_size(1), "the default is the one-job bound"


def test_a_three_job_aligner_still_serves_six_matrices_a_one_job_aligner_has_evicted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The behavioural half of the same fix: the SAME six songs, one aligner built for 3 jobs and one for 1.

    Six is what three live jobs hold (`_MATRICES_PER_JOB` each). The 3-job aligner serves all six from
    memory; the 1-job aligner has evicted the oldest two and re-runs the model for them — which is the
    regression a flat bound reintroduces on an operator-set `ENCORE_WORKER_CONCURRENCY`, and it is invisible
    to any assertion written in terms of `_emission_cache_size` itself.
    """
    import soundfile as sf

    monkeypatch.setattr(ml, "load_audio_mono_16k", lambda p: sf.read(p, dtype="float32", always_2d=False)[0])
    paths = []
    for index in range(2 * 3):
        path = tmp_path / f"live{index}.wav"
        sf.write(path, np.random.default_rng(100 + index).uniform(-0.5, 0.5, RATE).astype(np.float32), RATE)
        paths.append(str(path))

    def passes_to_reserve(jobs: int) -> int:
        ml.clear_cache()
        model = _LocalModel()
        aligner = _Rigged(model, jobs=jobs)
        for path in paths:
            aligner.emissions(path, "en")
        before = len(model.fed)
        for path in paths:  # a second sweep: every miss is one more forward pass
            aligner.emissions(path, "en")
        return len(model.fed) - before

    assert passes_to_reserve(3) == 0, "a 3-job box must hold its own six live matrices"
    # A four-deep LRU under six live songs THRASHES rather than merely evicting the oldest: each lookup
    # evicts the matrix the sweep needs two songs later, so every one of the six is re-computed. That is the
    # measured regression itself — "every attempt after the first re-paid the forward pass".
    assert passes_to_reserve(1) == len(paths), "a four-deep bound under six live matrices must thrash"
    ml.clear_cache()


def test_the_host_sizes_the_cache_from_its_configured_concurrency(monkeypatch: pytest.MonkeyPatch) -> None:
    """And the derivation has to REACH production (review r2): a bound nothing wires through is a formula.

    `build_adapters` is the only place that knows `Config.concurrency`, so the assertion is made there —
    hermetically, by recording what the factory is handed rather than by loading whisperx.

    THE ENGLISH BUNDLE RIDES THE SAME WIRE (W4b 6b): `Config.align_model` is resolved and checked here too
    (`align_model_for`), so an unset knob must reach the factory as this device's default rather than as None,
    which the factory would read as "whisperx's per-language table" — the base model, on every box.
    """
    from encore_worker import __main__ as entry
    from encore_worker.adapters import ml as adapters_ml
    from encore_worker.host.config import Config

    seen: dict[str, Any] = {}

    def spy(*, device: str, jobs: int = 1, model: str | None = None) -> Any:
        seen.update(device=device, jobs=jobs, model=model)
        return _Rigged(_LocalModel(), jobs=jobs)

    monkeypatch.setattr(adapters_ml, "build_aligner", spy)
    monkeypatch.setattr(adapters_ml, "build_transcriber", lambda **_k: None)
    monkeypatch.setattr(adapters_ml, "build_diarizer", lambda **_k: None)
    adapters = entry.build_adapters(Config(concurrency=3), device="cpu")
    assert seen == {"device": "cpu", "jobs": 3, "model": adapters_ml.default_align_model("cpu")}, (
        "the host must hand the factory its own concurrency and its own bundle"
    )
    entry.build_adapters(Config(align_model="HUBERT_ASR_XLARGE"), device="cpu")
    assert seen["model"] == "HUBERT_ASR_XLARGE", "and an operator's name reaches it unchanged"
    built = adapters.aligner
    assert isinstance(built, ml.WhisperXAligner)
    assert built._matrices == ml._emission_cache_size(3), "and the LRU is sized from it"


def test_an_unstattable_target_is_computed_uncached_rather_than_raising(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cache key must not change WHICH exception a missing target raises: callers of `emissions` are
    written around the typed `InfraFault` `load_audio_mono_16k` raises, not around an `OSError` from a
    `stat`. So a path that cannot be stat'ed skips the cache and fails in the reader."""
    ml.clear_cache()
    assert ml._content_key(str(tmp_path / "absent.wav")) is None

    def refuse(_path: str) -> Any:
        raise InfraFault("decoding through ffmpeg failed")

    monkeypatch.setattr(ml, "load_audio_mono_16k", refuse)
    with pytest.raises(InfraFault, match="ffmpeg"):
        _Rigged(_LocalModel()).emissions(str(tmp_path / "absent.wav"), "en")
    assert not ml._EMISSIONS
