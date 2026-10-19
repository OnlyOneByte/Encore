"""The real CTC kernel and the real emission pass, held to the contract `domain.lyrics.generate` assumes.

Every alignment test injects a fake decoder over fake emissions, so nothing called
`adapters.ml.forced_align_decoder` or `WhisperXAligner.emissions` and nothing checked that the fakes behave
like them (L8). THE KERNEL is checked on synthetic log-probs — the output shape, each target exactly once in
order, blank = 0 between a doubled letter, per-frame scores that are the matrix's own, the refusals
`generate` and `regenerate` are built around — and the fake the suite decodes with is then checked FRAME FOR
FRAME against it. THE EMISSION PASS runs only when the default English checkpoint is already cached (marked
`ml`, never downloads): the (frames, vocab) shape against wav2vec2's 320-sample stride, the FINAL SLIVER on
the grid, `frame_sec` exactly 0.02, log-softmax rows, the blank this bundle names, and the span-count check.
The chunk boundary, the stitching and the matrix cache are `tests/test_ml_grid.py`.
"""

from __future__ import annotations

import math
import random
import warnings
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from tests.ctc_fixture import FRAME_SEC, alignable, char_frames, ctc_viterbi, sung_matrix

torch: Any = pytest.importorskip("torch")
pytest.importorskip("torchaudio")

DIC = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz'")}

#: Two short lines; "hello" and "all" carry the doubled letter CTC must separate with a blank.
SUNG = (("hello all", 0.1, 0.9), ("carry on", 1.1, 1.6))
DURATION = 1.8


def decode(log_probs: Any, targets: Sequence[int]) -> tuple[list[int], list[float]]:
    from encore_worker.adapters.ml import forced_align_decoder

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # the deprecation note is recorded where the import lives
        return forced_align_decoder(torch.from_numpy(np.ascontiguousarray(log_probs)), targets)


class Emitted:
    """`adapters.ml.Emissions`' duck type over a synthetic matrix."""

    def __init__(self, log_probs: Any) -> None:
        self.log_probs = log_probs
        self.frame_sec = FRAME_SEC
        self.dictionary = DIC

    @property
    def frames(self) -> int:
        return int(self.log_probs.shape[0])


def runs(labels: Sequence[int]) -> list[tuple[int, int]]:
    """(first frame, end frame exclusive) of each maximal non-blank run: `_char_spans`' grouping."""
    out: list[tuple[int, int]] = []
    padded = [*labels, 0]
    start = 0
    for index in range(1, len(padded)):
        if padded[index] != padded[index - 1]:
            if padded[index - 1] != 0:
                out.append((start, index))
            start = index
    return out


def collapsed(labels: Sequence[int]) -> list[int]:
    """The label sequence a CTC path spells: runs merged, blanks dropped."""
    out: list[int] = []
    previous = 0
    for label in labels:
        if label != previous and label != 0:
            out.append(label)
        previous = label
    return out


# ── the kernel ───────────────────────────────────────────────────────────────────────────────────


def test_the_kernel_places_each_target_once_in_order_with_blanks_between_doubled_letters() -> None:
    matrix = sung_matrix(SUNG, DIC, DURATION)
    targets = [t for text, _s, _e in SUNG for t in alignable(text, DIC)]
    labels, scores = decode(matrix, targets)

    assert len(labels) == len(scores) == len(matrix), "one label and one score per frame"
    assert set(labels) <= {0, *targets}
    assert collapsed(labels) == targets, "the path spells the targets exactly, monotonically"
    for (first, last, token), (start, stop) in zip(char_frames(SUNG, DIC), runs(labels), strict=True):
        assert (start, stop) == (first, last), (
            f"token {token} heard on {first}-{last}, decoded {start}-{stop}"
        )
    assert all(labels[f] == 0 for f in range(char_frames(SUNG, DIC)[0][0])), "silence decodes as blank"
    assert scores == pytest.approx([float(matrix[f, label]) for f, label in enumerate(labels)])
    assert max(scores) <= 0.0, "scores are log-probs of the chosen label"


def test_generate_over_the_real_kernel_nests_and_lands_on_the_sung_frames() -> None:
    """`generate`'s span-count check is exactly one span per target. It holds on the real kernel because
    CTC's topology forces a blank between repeats. Each word lands on its sung frames, starts pulled
    back by ONSET_LEAD."""
    from encore_worker.adapters.ml import forced_align_decoder
    from encore_worker.domain.lyrics.generate import ONSET_LEAD_SEC, generate

    em = Emitted(torch.from_numpy(sung_matrix(SUNG, DIC, DURATION)))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        doc = generate([text for text, _s, _e in SUNG], em, decoder=forced_align_decoder)
    assert [line.index for line in doc.lines] == [0, 1]
    heard = char_frames(SUNG, DIC)
    # Each char's onset, led by ONSET_LEAD but never past the previous char's end.
    onsets = [
        max(first * FRAME_SEC - ONSET_LEAD_SEC, heard[k - 1][1] * FRAME_SEC if k else 0.0, 0.0)
        for k, (first, _last, _token) in enumerate(heard)
    ]
    cursor = 0
    for line, (text, _s, _e) in zip(doc.lines, SUNG, strict=True):
        for word, spelled in zip(line.words, text.split(), strict=True):
            assert word.start == pytest.approx(onsets[cursor], abs=1e-6)
            assert word.end == pytest.approx(heard[cursor + len(spelled) - 1][1] * FRAME_SEC, abs=1e-6)
            assert line.start - 1e-9 <= word.start <= word.end <= line.end + 1e-9
            cursor += len(spelled)


def test_the_kernel_refuses_a_blank_target_and_a_window_too_short() -> None:
    """The two refusals the domain is built around. `generate` drops id-0 characters from its targets
    (the English dictionary maps `-` to the blank). `regenerate` pre-checks 2 frames per target, and a
    kernel raise that still gets through is a counted fault, never a crash."""
    matrix = sung_matrix(SUNG, DIC, DURATION)
    with pytest.raises(ValueError, match="blank"):
        decode(matrix, [3, 0, 5])
    with pytest.raises(RuntimeError, match="too long"):
        decode(matrix[:5], [3, 4, 5, 6, 7, 8])


def test_the_kernels_refusals_are_this_text_failing_not_the_machinery() -> None:
    """Review M7's line, on the real kernel: a blank among the targets or more targets than frames is one
    attempt declining (the step's `decode failed`), never the `InfraFault` that fails the job."""
    from encore_worker.adapters.ports import InfraFault

    matrix = sung_matrix(SUNG, DIC, DURATION)
    for frames, targets in ((matrix, [3, 0, 5]), (matrix[:5], [3, 4, 5, 6, 7, 8])):
        with pytest.raises((ValueError, RuntimeError)) as raised:
            decode(frames, targets)
        assert not isinstance(raised.value, InfraFault), raised.value


class _Faulting(torch.nn.Module):  # type: ignore[misc]
    """An align model whose forward pass raises what an accelerator does."""

    def __init__(self, failure: Exception) -> None:
        super().__init__()
        self.weight = torch.nn.Parameter(torch.zeros(1))
        self.failure = failure

    def forward(self, _piece: Any) -> Any:
        raise self.failure


@pytest.mark.parametrize(
    ("failure", "kind", "retryable"),
    [
        (RuntimeError("MPS backend out of memory (MPS allocated: 17.20 GB)"), "OutOfMemory", False),
        (RuntimeError("CUDA error: an illegal memory access was encountered"), "InfraFault", True),
    ],
    ids=["oom", "device"],
)
def test_a_forward_pass_that_raises_is_a_typed_machinery_fault(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, failure: Exception, kind: str, retryable: bool
) -> None:
    """The emission pass reads no text, so its forward pass raising is the device or the model: typed, so
    `time_text` fails the job instead of declining every attempt of every text over it (review M7). Real
    torch and the real `emissions`; only whisperx's loaders are faked, so nothing is downloaded."""
    import sys
    import types

    from encore_worker.adapters import ml
    from encore_worker.adapters.ports import InfraFault

    fake = types.ModuleType("whisperx")
    fake.load_align_model = lambda **_k: (_Faulting(failure), {"dictionary": DIC})  # type: ignore[attr-defined]
    fake.load_audio = lambda _path: np.zeros(16000, dtype=np.float32)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "whisperx", fake)
    monkeypatch.setattr(ml, "_SAFE_GLOBALS_REGISTERED", True)
    ml.clear_cache()
    with pytest.raises(InfraFault) as raised:
        ml.WhisperXAligner(device="cpu").emissions(str(tmp_path / "vocals.wav"), "en")
    ml.clear_cache()
    assert type(raised.value).__name__ == kind and raised.value.retryable is retryable
    assert "the emission pass on cpu" in str(raised.value) and str(failure) in str(raised.value)


def test_the_suites_fake_decoder_is_the_kernel_frame_for_frame() -> None:
    """`ctc_viterbi` must be the kernel, not a look-alike. Otherwise every repair test would prove things
    about a decoder production does not run. The flat and random cases pin the TIE-BREAKING too (a
    window holding nothing its text says), which is where an equally scored but different path would
    publish different timings."""
    rng = random.Random(7)
    sung = sung_matrix(
        (("come and fly away", 0.5, 2.5), ("with me tonight", 3.0, 5.0), ("carry me home", 6.0, 8.0)),
        DIC,
        9.0,
    )
    cases: list[tuple[Any, list[int]]] = []
    for _ in range(40):
        first = rng.randrange(0, len(sung) - 60)
        window = sung[first : rng.randrange(first + 60, len(sung) + 1)]
        text = rng.choice(("come and fly away", "with me tonight", "carry me home", "me"))
        cases.append((window, alignable(text, DIC)))
    for trial in range(40):
        frames = rng.randrange(10, 200)
        targets = [rng.randrange(1, 28) for _ in range(rng.randrange(1, max(2, frames // 3)))]
        if trial % 2:
            cases.append((np.full((frames, 28), -3.3, dtype=np.float32), targets))
        else:
            raw = np.random.default_rng(trial).normal(size=(frames, 28))
            cases.append(((raw - np.log(np.exp(raw).sum(1, keepdims=True))).astype(np.float32), targets))
    compared = 0
    for matrix, targets in cases:
        try:
            want = decode(matrix, targets)
        except RuntimeError:
            with pytest.raises(ValueError):
                ctc_viterbi(matrix, targets)
            continue
        got = ctc_viterbi(matrix, targets)
        assert got[0] == want[0], f"labels differ on a {len(matrix)}-frame case with {len(targets)} targets"
        assert got[1] == pytest.approx(want[1])
        compared += 1
    assert compared >= 60, "the comparison must not be vacuous"


def test_the_vendored_decoder_is_the_real_kernel_frame_for_frame() -> None:
    """XA-18, against `torchaudio.functional.forced_align` itself and not against the fixture.

    The vendored graph may only be swapped in if an EMPTY graph publishes the same bytes, and "the same"
    has to mean the real kernel's: the same three-way tie-break, the same choice of final state, the same
    float32 accumulation, and `ValueError` wherever the kernel refuses. `tests/test_viterbi.py` runs the
    same cases without torch; this one is the leg that makes the claim true.
    """
    from encore_worker.domain.lyrics.viterbi import align
    from tests.test_viterbi import cases

    compared = 0
    for matrix, targets in cases():
        try:
            want = decode(matrix, targets)
        except RuntimeError:
            with pytest.raises(ValueError):
                align(matrix, targets)
            continue
        got = align(matrix, targets)
        assert list(got.labels) == want[0], (
            f"labels differ on a {len(matrix)}-frame case with {len(targets)} targets"
        )
        assert list(got.scores) == pytest.approx(want[1])
        compared += 1
    assert compared >= 60, "the comparison must not be vacuous"


def test_the_graphs_frame_relative_star_is_the_starred_columns_own_value() -> None:
    """Phase B needs no matrix surgery: at one P its star state emits exactly what `ml.starred`'s appended
    column holds, which is what lets the two phases share one fitted penalty."""
    from encore_worker.adapters.ml import STAR_NAME, starred

    matrix = sung_matrix(SUNG, DIC, DURATION)
    widened = starred(Emitted(torch.from_numpy(np.ascontiguousarray(matrix))), penalty=0.3)
    column = np.asarray(widened.log_probs)
    star = widened.specials[STAR_NAME]
    assert star == matrix.shape[1]
    assert column[:, star] == pytest.approx(column.max(axis=1) - 0.3)
    assert column[:, star] == pytest.approx(matrix.max(axis=1) - 0.3)


# ── the emission pass ────────────────────────────────────────────────────────────────────────────


def cached_default_checkpoint() -> Path | None:
    """The default English bundle's weights, when ALREADY on disk; None means the test must skip."""
    import torchaudio
    from whisperx.alignment import DEFAULT_ALIGN_MODELS_TORCH

    bundle = getattr(torchaudio.pipelines, DEFAULT_ALIGN_MODELS_TORCH.get("en", ""), None)
    name = getattr(bundle, "_path", None)
    if not isinstance(name, str):
        return None
    path = Path(torch.hub.get_dir()) / "checkpoints" / Path(name).name
    return path if path.is_file() else None


@pytest.fixture()
def aligner() -> Iterator[Any]:
    pytest.importorskip("whisperx")
    if cached_default_checkpoint() is None:
        pytest.skip("the default English alignment checkpoint is not cached; this test never downloads")
    from encore_worker.adapters.ml import WhisperXAligner, clear_cache

    yield WhisperXAligner(device="cpu")
    clear_cache()


@pytest.mark.ml
def test_emissions_on_a_short_tone_are_a_log_softmax_matrix_with_blank_at_zero(
    aligner: Any, tmp_path: Path
) -> None:
    rate, seconds = 16000, 1.5
    t = np.arange(int(rate * seconds)) / rate
    tone = tmp_path / "tone.wav"
    sf.write(tone, 0.3 * np.sin(2 * math.pi * 220.0 * t), rate)

    em = aligner.emissions(str(tone), "en")
    matrix = em.log_probs.numpy()
    samples = int(rate * seconds)
    # EVERY hop gets a frame, the final partial one included (review 6a): 24000 samples is 75 whole hops,
    # and the 75th frame's 400-sample field is padded rather than dropped. The old pass emitted 74.
    assert matrix.shape == (-(-samples // 320), len(em.dictionary)), "the exact 320-sample grid"
    assert matrix.shape[0] == (samples - 400) // 320 + 2, "the sliver frame the old pass dropped"
    assert em.frames == matrix.shape[0]
    assert em.frame_sec == 0.02, "the model's hop exactly, not duration / frames"
    assert np.allclose(np.log(np.exp(matrix).sum(axis=1)), 0.0, atol=1e-4), "rows are log-softmax"
    # This bundle's blank IS 0 (`-`), which is why hard-coding it survived; it is now read, not assumed.
    assert em.blank_id == 0 and em.dictionary.get("-") == 0, "review M9"
    assert em.specials == {"-": 0, "|": 1}, "the vocabulary's non-characters, named"
    assert {ch for ch in "abcdefghijklmnopqrstuvwxyz'"} <= set(em.dictionary)

    from encore_worker.adapters.ml import forced_align_decoder
    from encore_worker.domain.lyrics.generate import generate

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        doc = generate(["la la la"], em, decoder=forced_align_decoder)
    assert len(doc.lines) == 1 and len(doc.lines[0].words) == 3, "the real pair meets the span-count check"
    starts = [w.start for w in doc.lines[0].words]
    assert starts == sorted(starts) and doc.lines[0].end <= seconds + 1e-6


def test_the_english_default_bundle_is_the_one_the_lexical_bands_were_fitted_on() -> None:
    """The English default bundle is the one `lexical.BANDS` was fitted on.

    `BANDS` is ONE bundle's calibration and whisperx picks the bundle PER LANGUAGE, so `align_model_name`
    reads that choice from whisperx's own tables without loading anything: this test fails the day a
    whisperx upgrade moves the `en` default, which would otherwise apply thresholds fitted elsewhere. A
    language with no default is named as such and `align_lines._measured_lift` declines to judge. `BANDS`
    stays the row an UNNAMED matrix is read as — a test's fake, a bench cache written before
    `Emissions.model` existed — while the shipped default's row is `CALIBRATED[default_align_model()]`."""
    from encore_worker.adapters.ml import align_model_name, default_align_model
    from encore_worker.domain.lyrics import lexical

    pytest.importorskip("whisperx")
    assert align_model_name("en") == lexical.BANDS.model
    assert align_model_name("de") != lexical.BANDS.model, "a per-language bundle the bands never saw"
    assert align_model_name("zz") == "default:zz", "unknown is named, not assumed"
    named = default_align_model("cpu")
    assert align_model_name("en", named) == named, "a configured bundle is what English loads"
    assert align_model_name("de", named) == align_model_name("de"), "and never what another language loads"
    # THE NAME DESCRIBES THE LOAD, for every language `_bundle_of` answers (review r1-spec-12): an
    # undetected language loads the configured bundle, so reporting `default:` would hand a calibrated
    # matrix an unknown row and decline the words it is allowed to publish.
    from encore_worker.adapters.ml import MMS_ALIGN_MODEL, WhisperXAligner

    aligner = WhisperXAligner(device="cpu", model=named, nonlatin_routes={"zh": MMS_ALIGN_MODEL})
    for language in ("en", "", "de", "zh", "zz"):
        loaded, reported = aligner._bundle_of(language), aligner._bundle_name(language)
        assert loaded is None or loaded == reported, f"{language!r} loads {loaded} and reports {reported}"
