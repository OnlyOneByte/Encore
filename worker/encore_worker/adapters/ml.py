"""The model-backed adapters: whisper for transcription, whisperX for alignment, pyannote for diarization.

EVERY IMPORT IS LAZY, and that is the rule this module exists to enforce. `import torch` costs seconds
and several hundred megabytes of resident memory, paid at process start on a box that may only ever serve
fetch jobs. So nothing is imported until an adapter is actually built, which is also what lets the whole
test suite import this file with no ML installed.

MODELS ARE CACHED AT MODULE LEVEL, keyed by (device, checkpoint). A fresh instance per job would re-read
multi-GB weights on every job — and that single fact is why this worker is a resident process rather than
a subprocess per step, and therefore why a non-Python orchestrator was rejected.

EVERYTHING HERE IS SYNCHRONOUS. These are called from inside `asyncio.to_thread`, because torch blocks:
awaiting it inline freezes the event loop for the whole pass, the socket keepalive stops, the core's
lease expires, and the reaper requeues a job that is running perfectly well.
"""

from __future__ import annotations

import os
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from encore_worker.adapters.cli import OutOfMemory, looks_like_oom
from encore_worker.adapters.ports import InfraFault
from encore_worker.domain.document import Segment
from encore_worker.host.mlrt import ML_LOCK

#: (device, checkpoint) -> loaded handle. Two concurrent jobs on one checkpoint share it; two on
#: different checkpoints cannot evict each other, which a single-slot cache would do.
#:
#: MODEL WEIGHTS ONLY. Emission matrices used to live in here too, under a `f"emissions:{lang}:{path}"`
#: key — which is the whole of review M10: a dict that must never evict (reloading multi-GB weights is
#: why this process is resident) was also holding per-song data keyed by a path that gets REPLACED in
#: place. See `_EMISSIONS` for the bounded, content-keyed cache that now holds them.
_MODELS: dict[tuple[str, str], Any] = {}

#: Devices CTranslate2 — which is what whisperx runs its transcriber on — will actually accept.
#: MEASURED, not assumed: `whisperx.load_model(..., "mps")` raises `ValueError: unsupported device mps`.
#: torch reports MPS as available on every Apple Silicon box, so a single global device string resolved
#: from `torch` would hand the transcriber a device it cannot use and fail ASR on every Mac.
CTRANSLATE2_DEVICES = ("cpu", "cuda")

#: Whether the pyannote-checkpoint unpickling shim has been installed. Once per process.
_SAFE_GLOBALS_REGISTERED = False


def transcriber_device(device: str) -> str:
    """The device the TRANSCRIBER can use, which is not always the device torch offers.

    The aligner is plain torch wav2vec2 and runs happily on `mps`; the transcriber is CTranslate2 and does
    not. Rather than resolve one device globally and hope, each component asks for what it can take —
    which is why this exists as a function rather than a field on the config.
    """
    return device if device in CTRANSLATE2_DEVICES else "cpu"


def _allow_pyannote_checkpoints() -> None:
    """Register the globals pyannote's checkpoints need under torch's weights-only unpickler.

    WHY THIS IS NECESSARY. torch 2.6 changed `torch.load`'s `weights_only` default from False to True.
    pyannote's VAD checkpoint — which whisperx loads on the way to building a transcriber — stores
    omegaconf config objects and its own task enums, none of which are allowlisted. Without this,
    `whisperx.load_model` fails on EVERY device with:

        UnpicklingError: Weights only load failed ...
        Unsupported global: GLOBAL omegaconf.listconfig.ListConfig was not an allowed global by default

    NARROW BY DESIGN. The tempting fix is to pass `weights_only=False`, but that would be a global
    monkeypatch of `torch.load` disabling the integrity check for every checkpoint this process ever
    reads, including ones it did not vet. Allowlisting exactly the types these checkpoints legitimately
    contain keeps the check on for everything else.

    The list was DISCOVERED by loading and reading each refusal in turn, not guessed — a missing entry is
    not a warning, it is the same hard failure.
    """
    global _SAFE_GLOBALS_REGISTERED
    if _SAFE_GLOBALS_REGISTERED:
        return
    import collections  # noqa: PLC0415
    import typing  # noqa: PLC0415

    import torch  # noqa: PLC0415
    import torch.serialization  # noqa: PLC0415

    allowed: list[Any] = [
        list,
        dict,
        int,
        collections.defaultdict,
        typing.Any,
        torch.torch_version.TorchVersion,
    ]
    for path in (
        "omegaconf.listconfig.ListConfig",
        "omegaconf.base.ContainerMetadata",
        "omegaconf.base.Metadata",
        "omegaconf.nodes.AnyNode",
        "pyannote.audio.core.model.Introspection",
        "pyannote.audio.core.task.Specifications",
        "pyannote.audio.core.task.Problem",
        "pyannote.audio.core.task.Resolution",
    ):
        module, _, attr = path.rpartition(".")
        try:
            import importlib  # noqa: PLC0415

            allowed.append(getattr(importlib.import_module(module), attr))
        except (ImportError, AttributeError):
            # A version that no longer ships this type does not need it allowlisted. Skipping keeps the
            # shim working across pyannote/omegaconf releases instead of failing on an absent name.
            continue
    torch.serialization.add_safe_globals(allowed)
    _SAFE_GLOBALS_REGISTERED = True


class ModelUnavailable(InfraFault):
    """A model this box was asked for, or the kernel that decodes against it, cannot be loaded.

    `retryable = False`: a missing package or an absent checkpoint is not fixed by trying again, and
    spending three attempts proving it delays the fallback that would have worked.

    An `InfraFault` (review M7), so an alignment step lets it through: a missing package fails every text
    the same way, and declining attempt after attempt over it ended the ladder in a published "no lyrics".
    """

    retryable = False


def _machinery_fault(doing: str, failed: BaseException) -> InfraFault:
    """`failed`, raised while `doing` something only the machinery does, as the typed fault it is.

    Out-of-memory is told apart from torch's OWN message (`torch.OutOfMemoryError`, "MPS backend out of
    memory"), with the markers `cli.run` reads off a subprocess: an in-process emission pass on the same
    audio on the same box exhausts the same memory again, so it is `OutOfMemory`, which is not retried.
    Anything else is a plain `InfraFault`, which is: a download, a device error, an ffmpeg read.
    """
    detail = f"{type(failed).__name__}: {str(failed).strip()[-400:]}"
    if looks_like_oom(detail):
        return OutOfMemory(
            f"{doing} ran out of memory ({detail}). This model needs more than this box has — try a "
            "smaller model, or a box with more memory."
        )
    return InfraFault(f"{doing} failed ({detail})")


def _has_default_align_model(language: str) -> bool:
    """Does whisperx name a default alignment model for `language`? True when it cannot be asked.

    Read from whisperx's own tables because `load_align_model` raises the SAME `ValueError` for "no model
    for this language" as for "the Hub checkpoint would not download", and only the second is the
    machinery's. An unanswerable question counts as a known language, so the failure is reported as
    the machinery's, the side that gets looked at.
    """
    try:
        from whisperx.alignment import (  # noqa: PLC0415
            DEFAULT_ALIGN_MODELS_HF,
            DEFAULT_ALIGN_MODELS_TORCH,
        )
    except ImportError:
        return True
    return bool(language in DEFAULT_ALIGN_MODELS_TORCH or language in DEFAULT_ALIGN_MODELS_HF)


def align_model_name(language: str) -> str:
    """The alignment bundle `_aligner` loads for `language` — the name, without loading anything.

    WHY A NAME AT ALL: every threshold read off an emission matrix is one MODEL's (the lexical lift's bands,
    `domain.lyrics.lexical.BANDS`), and the bundle is picked per language rather than per release, so a
    German song silently uses a wav2vec2-XLSR fine-tune where the bands were fitted on English's
    `WAV2VEC2_ASR_BASE_960H`. Carried on `Emissions.model` so the reader can tell.

    Read from whisperx's own tables, the way `_aligner` resolves it and the way the bench's calibration
    scripts name a row set (`scripts/lift_gate.model_name`), so the two sides name the same thing. Unknown
    (no whisperx, or a language it tables nothing for) is reported as such — `""` would claim the bands'
    own model, and `load_align_model` would have raised for it anyway.
    """
    try:
        from whisperx.alignment import (  # noqa: PLC0415
            DEFAULT_ALIGN_MODELS_HF,
            DEFAULT_ALIGN_MODELS_TORCH,
        )
    except ImportError:  # pragma: no cover - whisperx is a hard dependency of the ml extra
        return f"unknown:{language}"
    named = DEFAULT_ALIGN_MODELS_TORCH.get(language) or DEFAULT_ALIGN_MODELS_HF.get(language)
    return str(named or f"default:{language}")


def _cached(device: str, checkpoint: str, build: Any) -> Any:
    key = (device, checkpoint)
    if key not in _MODELS:
        _MODELS[key] = build()
    return _MODELS[key]


def clear_cache() -> None:
    """Drop every loaded model AND every cached emission matrix. For tests, and for an operator
    reclaiming VRAM without a restart."""
    _MODELS.clear()
    _EMISSIONS.clear()


#: wav2vec2 alignment models are trained at 16 kHz; every other rate is resampled to it.
_EMISSION_SAMPLE_RATE = 16000

#: wav2vec2's feature extractor, in samples at 16 kHz. Its convolutional stack (kernels 10,3,3,3,3,2,2 with
#: strides 5,2,2,2,2,2,2) ADVANCES 320 samples per output frame and needs 400 of them to produce one at
#: all: `model(zeros(1, L))` returns exactly `(L - 400) // 320 + 1` frames, measured on
#: WAV2VEC2_ASR_BASE_960H over lengths 400..544000 and pinned in `tests/test_ml_contract.py`. So the frame
#: clock is the MODEL's — exact, and known before a single frame is computed.
_FRAME_HOP_SAMPLES = 320
_FRAME_FIELD_SAMPLES = 400

#: One emission frame, in seconds: EXACTLY 20 ms (review 6a). It used to be `duration / frames`, a
#: different number on every song and wrong in two compounding ways. A 30 s chunk produces 1499 frames,
#: not 1500 (the formula above), so the ratio stretched every frame by 1/1499 and stamped words up to
#: 20 ms late by the end of each chunk — the review's frame-clock SAWTOOTH (decode-5 / evidence-8). And the
#: final sub-0.1 s sliver was dropped while `duration` still counted its seconds, which drifted odd-length
#: songs 50-60 ms late after 2:30. Both are arithmetic, not evidence: 320 samples at 16 kHz is 0.02 s.
FRAME_SEC = _FRAME_HOP_SAMPLES / _EMISSION_SAMPLE_RATE

#: Seconds of audio one forward pass STAMPS. Bounds memory: a whole-song pass is quadratic in
#: self-attention, and at 30 s the activations of the widest bundle fit on a laptop accelerator.
_EMISSION_CHUNK_SEC = 30

#: Seconds of audio computed on EACH SIDE of a chunk and then discarded (ctc-forced-aligner's
#: `generate_emissions`). A frame's receptive field is 400 samples of input but wav2vec2's transformer
#: attends across the whole slice it is given, so a frame at a chunk edge used to see context on one side
#: only. Computing 2 s past each edge and throwing those frames away gives every stamped frame the same
#: context an interior frame has. THE COST, computed from `_frame_passes` rather than from the ratio
#: (30+2+2)/30 the review quoted, because the first and last pass have context on one side only: 1.12x for
#: the measured 194 s song, 1.09x at 90 s, 1.13x at an hour. Peak memory rises by the 4 s, not by a
#: multiple. 2 s is 100 frames EXACTLY, which is what keeps the trim arithmetic integral.
_EMISSION_CONTEXT_SEC = 2

#: Emission matrices, most-recently-used LAST, keyed by (resolved path, size, mtime_ns, model, language,
#: device). REVIEW M10, both halves:
#:
#:   CONTENT, not path. A stems re-run PUTS a new vocals stem over the same key
#:   (`artifacts/local.py:110`, `os.replace`), so a path-keyed matrix outlived the audio it was computed
#:   from and a later re-pick aligned the new stem's text against the old stem's frames. Size and
#:   mtime_ns move with any replacement `os.replace` can make.
#:
#:   BOUNDED, and separate from `_MODELS`. The old cache lived in the model dict, which must never evict,
#:   so every song a resident worker ever aligned stayed in memory for the life of the process.
_EMISSIONS: OrderedDict[tuple[Any, ...], Emissions] = OrderedDict()

#: How many matrices to keep. One align job reads at most two (the stem it aligns on and the MIX witness
#: R4 decodes), so four holds this job's and the previous one's — which is all the cache is FOR: a DBOS
#: re-entry must not pay 4 s of model time again for durability's sake. Bounding the resident set matters
#: because the matrices are not small at every vocabulary: ~1 MB for a 3-minute English song (9.7k x 29
#: float32) but ~47 MB on the widest bundle whisperx tables (Korean, 1204 tokens).
_EMISSION_CACHE_SIZE = 4

#: The names a wav2vec2 vocabulary gives CTC's BLANK, lowercased as whisperx lowercases its dictionary
#: (`whisperx/alignment.py:98,110`). `[pad]`/`<pad>` are the HF checkpoints' and are what whisperx's own
#: decoder scans for; torchaudio's bundles carry no pad token and put `-` at id 0, which is their blank.
_BLANK_NAMES = ("[pad]", "<pad>")

#: Vocabulary entries that are NOT characters of the language: CTC's blank under either name, the word
#: separator, and the unknown / sentence markers. Named on `Emissions.specials` so a target filter has a
#: list to read instead of a hard-coded id — see the field for what this wave does and does not do with it.
_SPECIAL_NAMES = ("[pad]", "<pad>", "[unk]", "<unk>", "<s>", "</s>", "|")


@dataclass(frozen=True)
class Emissions:
    """A song's per-frame character log-probabilities, plus what is needed to decode against them.

    `log_probs` is (frames, vocab) — ~9.7k x 29 for a 3-minute English song, about 1 MB. `dictionary` maps
    characters to vocab ids and travels WITH the matrix because the two are meaningless apart: ids are a
    property of the model that produced these frames. So is `model`, for the same reason one step further
    out: a threshold fitted on one bundle's log-probabilities means nothing on another's, and the bundle is
    chosen per LANGUAGE (`_aligner`), so the matrix has to say which one it is. `blank_id` is the third
    thing that is the model's rather than the decode's, and the one that used to be assumed (review M9).
    """

    log_probs: Any
    frame_sec: float
    dictionary: dict[str, int]
    #: The bundle these frames came from (`align_model_name`), for a reader that was CALIBRATED on one:
    #: `domain.lyrics.lexical.BANDS` is one model's, and `align_steps._measured_lift` will not read the
    #: lift as a verdict on another's. Defaulted so a fake and a bench cache written before the field
    #: existed still construct: EMPTY means unnamed, which a calibrated reader treats as its own (the
    #: shipped `emissions` always names one). It is also the VOCABULARY's identity — the ids in
    #: `dictionary` and the column order of `log_probs` are one bundle's — and so part of the cache key.
    model: str = ""
    #: CTC's blank column in THIS matrix. DEFAULTED TO 0 and read with `getattr` everywhere, so every
    #: fake emission object and every bench cache entry written before this field existed still decodes
    #: as it did (review M9's fix, kept back-compatible on purpose).
    #:
    #: WHY IT IS NOT ALWAYS 0. torchaudio's bundles put their blank (`-`) at 0, which is why hard-coding
    #: it survived; 23 of whisperx's 36 HF align models do not. Measured from the review's per-model vocab
    #: dumps: Danish `<pad>`=32 with `u` at 0, Norwegian Bokmal `[PAD]`=38 with `|` at 0, Korean
    #: `[PAD]`=1204. On Danish the wrong blank costs word onsets within +-250 ms 90.5% -> 73.2% and takes
    #: words more than 2 s off from 141 to 584, because the decoder charges the true blank as a letter and
    #: the target filter silently drops every `u`. DORMANT today only because `language` is always `en`
    #: (review M8, W7) — it is threaded now so W7 cannot detonate it.
    blank_id: int = 0
    #: The vocabulary's non-character entries by name -> id (`_SPECIAL_NAMES`), blank included.
    #:
    #: NAMING, not filtering. `blank_id` is the one this wave acts on, because it is the one a target list
    #: may never contain and the one the frame grouping has to recognise. The others are recorded because
    #: a single-character special IS reachable from a lyric: every HF vocabulary maps `|` to the word
    #: separator, and `generate`'s filter — which looks up single characters — would emit it as a target
    #: for a line that contains a pipe. Whether `|` becomes a deliberate LINE separator is review 6c's
    #: decision (disputed, D1; deliberately not in this wave), so this field exists for that reader rather
    #: than being acted on here. Empty means "not reported", which every fake is.
    specials: Mapping[str, int] = field(default_factory=dict)

    @property
    def frames(self) -> int:
        return int(self.log_probs.shape[0]) if self.log_probs is not None else 0


def blank_id_of(dictionary: Mapping[str, int]) -> int:
    """CTC's blank id in `dictionary`, by whisperx's own rule (`whisperx/alignment.py:267-270`).

    THE SAME RULE ON PURPOSE: whisperx's windowed `align()` finds its blank this way, so the global decode
    and the windowed one cannot disagree about which column is blank on the same loaded model. A
    vocabulary with neither pad name is a torchaudio bundle, whose blank is its label 0 (`-`).
    """
    for name in _BLANK_NAMES:
        code = dictionary.get(name)
        if code is not None:
            return int(code)
    return 0


def specials_of(dictionary: Mapping[str, int]) -> dict[str, int]:
    """The `_SPECIAL_NAMES` this vocabulary actually has, for `Emissions.specials`.

    Plus `-` WHEN IT IS THE BLANK, which is the torchaudio bundles' case: there `-` is not a hyphen the
    text may align on, and `generate`'s filter has always had to drop it (its docstring says so).
    """
    out = {name: int(code) for name in _SPECIAL_NAMES if (code := dictionary.get(name)) is not None}
    blank = blank_id_of(dictionary)
    if dictionary.get("-") == blank:
        out["-"] = blank
    return out


def _content_key(audio_path: str) -> tuple[str, int, int] | None:
    """(resolved path, size, mtime_ns) — what `_EMISSIONS` keys a matrix's AUDIO on, or None.

    None when the file cannot be stat'ed, and the caller then computes WITHOUT caching rather than
    raising: a missing or unreadable target must still fail where it failed before — inside
    `load_audio_mono_16k`, as the typed `InfraFault` every caller of `emissions` is written around — and
    not as an `OSError` from a cache key.
    """
    try:
        real = os.path.realpath(audio_path)
        stat = os.stat(real)
    except OSError:
        return None
    return (real, stat.st_size, stat.st_mtime_ns)


def _cached_emissions(key: tuple[Any, ...], build: Any) -> Emissions:
    """`build()`'s matrix under `key`, from the bounded LRU when it is there (review M10)."""
    hit = _EMISSIONS.get(key)
    if hit is not None:
        _EMISSIONS.move_to_end(key)
        return hit
    made: Emissions = build()
    _EMISSIONS[key] = made
    while len(_EMISSIONS) > _EMISSION_CACHE_SIZE:
        _EMISSIONS.popitem(last=False)
    return made


@dataclass(frozen=True, slots=True)
class _Pass:
    """One forward pass of the emission grid: what to feed the model, and which frames to keep."""

    #: First audio sample of the slice handed to the model. A multiple of the hop, so `trim` is exact.
    offset: int
    #: One past the last sample READ from the audio. `samples` may exceed `stop - offset`, and then the
    #: slice is zero-padded — which is how the final sliver keeps its frame instead of being dropped.
    stop: int
    #: Length of the (padded) slice, so the model produces at least `trim + keep` frames.
    samples: int
    #: Leading frames of this pass that are CONTEXT: computed for their receptive field, then discarded.
    trim: int
    #: Frames after `trim` that belong to the song's grid.
    keep: int


def _frame_passes(total_samples: int) -> list[_Pass]:
    """The exact 20 ms frame grid over `total_samples`, expressed as the forward passes that produce it.

    PURE, AND SEPARATE FROM THE MODEL, so the grid arithmetic — the part the review found wrong twice over
    (decode-5 / evidence-8) — is tested without torch, weights or audio. Frame `k` of the grid covers
    samples `[k*320, k*320+400)` and is stamped at `k * FRAME_SEC`; the grid has
    `ceil(total_samples / 320)` frames, so the FINAL SLIVER gets a frame too, zero-padded up to the 400
    samples wav2vec2 needs to emit one at all rather than dropped (the old pass broke out of its loop on
    anything under 0.1 s, and the frame_sec it then derived counted the dropped seconds).

    Each pass stamps up to `_EMISSION_CHUNK_SEC` of grid frames and additionally computes
    `_EMISSION_CONTEXT_SEC` of frames on each side, which are thrown away: the boundary frames get their
    context, and the stamps stay on one global grid because every offset is a whole number of hops.
    """
    hop, field_ = _FRAME_HOP_SAMPLES, _FRAME_FIELD_SAMPLES
    chunk = _EMISSION_CHUNK_SEC * _EMISSION_SAMPLE_RATE // hop
    context = _EMISSION_CONTEXT_SEC * _EMISSION_SAMPLE_RATE // hop
    frames = -(-max(total_samples, 0) // hop)  # ceil
    passes: list[_Pass] = []
    for first in range(0, frames, chunk):
        keep = min(chunk, frames - first)
        offset = max(0, first - context) * hop
        trim = (first * hop - offset) // hop
        # Read far enough right that the LAST context frame has its field too; the audio may end sooner.
        stop = min(total_samples, (first + keep + context - 1) * hop + field_)
        passes.append(
            _Pass(
                offset=offset,
                stop=stop,
                samples=max(stop - offset, (trim + keep - 1) * hop + field_),
                trim=trim,
                keep=keep,
            )
        )
    return passes


def load_audio_mono_16k(path: str) -> Any:
    """A mono float32 signal at 16 kHz from ANY container ffmpeg can read, as a numpy array.

    `whisperx.load_audio` under the hood, which shells ffmpeg — the same decode every v1 alignment already
    used. `domain.audio.wav.read_wav_mono` deliberately reads only WAV/FLAC, and alignment's MIX target is
    the raw yt-dlp download (`original.webm`, `.m4a`): found LIVE when every v2 attempt on a mix target
    declined with `LibsndfileError: Format not recognised` while v1 sailed through the same file.

    A file ffmpeg will not decode raises `InfraFault` (review M7). It is the JOB's audio, which no text
    changes, so it fails every attempt identically; a caller with an honest no-evidence answer (placement,
    the never-sung rule's mix witness) still catches it, as it catches any exception.
    """
    import whisperx  # noqa: PLC0415

    try:
        return whisperx.load_audio(path)
    except Exception as failed:
        raise _machinery_fault(f"decoding {path!r} through ffmpeg", failed) from failed


def forced_align_decoder(
    log_probs: Any, targets: Sequence[int], blank: int = 0
) -> tuple[list[int], list[float]]:
    """`domain.lyrics.generate`'s Decoder, over torchaudio's CTC kernel.

    `blank` is the matrix's own blank column (`Emissions.blank_id`), not a constant: it used to be a
    literal 0 here, which is review M9 — right for torchaudio's bundles and wrong for 23 of the 36 HF
    align models whisperx tables. Defaulted so a caller that has no matrix to ask (a test, a probe) still
    gets the kernel's own default.

    DEPENDENCY RISK, recorded where the import lives: `torchaudio.functional.forced_align` is deprecated
    for REMOVAL in torchaudio 2.9 (the maintenance-phase refactor, pytorch/audio#3902). This project pins
    torchaudio 2.8.0, so nothing breaks today — but the torch-family pins move together, and whoever bumps
    them must either find the kernel's new home or vendor it. The benchmark suite will catch a silent
    behaviour change; this comment exists so the REMOVAL is not a surprise.

    A kernel that is GONE raises `ModelUnavailable`, an `InfraFault` that fails the job (review M7): it
    used to be a `decode failed` decline on every attempt of every text, ending in a published "no
    lyrics". A kernel that REFUSES these targets (more of them than frames: "targets length is too long";
    a blank among them) still raises its own error, which is one attempt failing on this text.
    """
    try:
        import torch  # noqa: PLC0415
        from torchaudio.functional import forced_align  # noqa: PLC0415
    except ImportError as gone:
        raise ModelUnavailable(
            "torchaudio's CTC kernel (`torchaudio.functional.forced_align`) is not importable on this box: "
            f"{gone}. It is deprecated for removal in torchaudio 2.9; pin 2.8, or vendor the kernel."
        ) from gone

    aligned, scores = forced_align(
        log_probs.unsqueeze(0), torch.tensor([list(targets)], dtype=torch.int32), blank=blank
    )
    return aligned[0].tolist(), scores[0].tolist()


class WhisperTranscriber:
    """`Transcriber` over whisperX's batched whisper.

    The ASR tier, and therefore the mandatory fallback. Its output cannot be the wrong song and cannot
    be misplaced in time, because it is measured from the recording in hand.
    """

    def __init__(self, *, device: str = "cpu", checkpoint: str = "base") -> None:
        self._device = device
        self._checkpoint = checkpoint

    def _model(self) -> Any:
        def build() -> Any:
            try:
                import whisperx  # noqa: PLC0415 - lazy by design; see the module docstring
            except ImportError as missing:
                raise ModelUnavailable(
                    "whisperx is not installed, so this worker cannot transcribe. "
                    "Install the `ml` extra, or leave `align` out of this box's capabilities."
                ) from missing
            _allow_pyannote_checkpoints()
            # The transcriber's device is NOT necessarily the job's: CTranslate2 has no MPS backend.
            device = transcriber_device(self._device)
            # float32 everywhere but CUDA: float16 is a CUDA optimisation and either produces garbage or
            # raises elsewhere, which reads as a bad transcription rather than a wrong dtype.
            compute = "float16" if device == "cuda" else "float32"
            return whisperx.load_model(self._checkpoint, device, compute_type=compute)

        # Cached under the RESOLVED device, so a box asking for mps and getting cpu shares one handle
        # rather than loading the same weights twice under two keys.
        return _cached(transcriber_device(self._device), f"whisper:{self._checkpoint}", build)

    def transcribe(self, audio_path: str, *, language: str | None = None) -> Sequence[Segment]:
        # ML_LOCK covers LOADING AND RUNNING, and both halves matter: two jobs loading multi-GB
        # checkpoints at once exhausts the accelerator, and two inferences that each expect it to
        # themselves is the same failure a step later. Only reachable with
        # ENCORE_WORKER_CONCURRENCY > 1; at the default of 1 the lock is uncontended and free.
        with ML_LOCK:
            import whisperx  # noqa: PLC0415

            audio = whisperx.load_audio(audio_path)
            result = self._model().transcribe(audio, language=language)
            segments = result.get("segments") if isinstance(result, dict) else None
            if not segments:
                return ()  # nothing intelligible: a RESULT, not an error
            return tuple(
                {"start": s.get("start"), "end": s.get("end"), "text": str(s.get("text") or "").strip()}
                for s in segments
                if str(s.get("text") or "").strip()
            )


class WhisperXAligner:
    """`Aligner` over whisperX's wav2vec2 forced alignment.

    The component both reported defects run through, and the reason this worker stays Python: phoneme-
    level forced alignment against a reference text has no equivalent outside this stack.
    """

    def __init__(self, *, device: str = "cpu") -> None:
        self._device = device

    def _aligner(self, language: str) -> tuple[Any, Any]:
        def build() -> tuple[Any, Any]:
            try:
                import whisperx  # noqa: PLC0415
            except ImportError as missing:
                raise ModelUnavailable("whisperx is not installed, so this worker cannot align") from missing
            _allow_pyannote_checkpoints()
            try:
                # whisperx is untyped, so annotate the unpack here rather than letting Any escape upward.
                loaded: tuple[Any, Any] = whisperx.load_align_model(
                    language_code=language, device=self._device
                )
            except Exception as failed:
                if not _has_default_align_model(language):
                    # No model for this language: a fact about the TEXT's language, so one attempt declines
                    # rather than the job failing, and a timed text still reaches LINE_SYNC, which needs
                    # no model at all.
                    raise
                # A download, a Hub/cache failure, a device refusing the weights (review M7).
                raise _machinery_fault(f"loading the {language!r} alignment model", failed) from failed
            return loaded

        cached: tuple[Any, Any] = _cached(self._device, f"align:{language}", build)
        model, metadata = cached
        return model, metadata

    def _bundle_name(self, language: str) -> str:
        """The bundle `_aligner` loads for `language`, for `Emissions.model` — a HOOK, not a constant.

        A subclass that loads another bundle (the bench's `BenchAligner --model <hubert>`) overrides this, so
        the name on the matrix never says one model where another produced the frames. A calibrated reader
        trusts it: `align_steps._measured_lift` will not judge a text on bands fitted elsewhere.
        """
        return align_model_name(language)

    def emissions(self, audio_path: str, language: str) -> Emissions:
        """The full song's per-frame character log-probabilities, computed ONCE and reusable.

        THE EVIDENCE LAYER of alignment v2 (docs/PLAN-alignment-v2.md). `windowed align` runs the model per
        search span, so five lyrics candidates cost five model passes and every pass trusts its windows.
        This runs the model once over the whole recording — measured at 4.0 s CPU for a 194 s song, ~4.5 s
        now that each chunk also computes its context — and every candidate text is then one
        `forced_align` decode over the same matrix (0.1-0.8 s and 23-230 MB for the corpus's songs, review
        evidence-6: the decode is cheap against the model pass, but it is not "a millisecond", which is
        what this docstring and three others used to claim).

        AN EXACT 20 ms GRID (review 6a). Frame `k` is stamped at `k * FRAME_SEC` and covers samples
        `[k*320, k*320+400)`; `_frame_passes` lays the whole song on that one grid and says which forward
        pass produces which frames. Two defects went with the old arithmetic, both in `FRAME_SEC`'s
        docstring: a derived `duration / frames` ratio (a 20 ms sawtooth within each chunk) and a dropped
        final sliver (50-60 ms of drift on odd-length songs). Each pass also computes
        `_EMISSION_CONTEXT_SEC` on either side and THROWS THOSE FRAMES AWAY, so a frame at a chunk boundary
        sees the same context an interior frame does — the overlap-and-splice this used to reject as "double
        compute for a defect the measurement could not find" costs +13% when the overlap is trimmed rather
        than blended, and the measurement that could not find it had no chunk-boundary test
        (`tests/test_ml_contract.py` now has one).

        CACHED per (resolved path, size, mtime_ns, model, language, device) in a bounded LRU: DBOS may
        re-enter the workflow, and a retry that recomputed 4 s of model time for the same file would pay
        for durability twice. The key used to be the PATH alone, in the model dict, unevicted — review M10,
        both halves; see `_EMISSIONS` for what each part is for. A file that cannot be stat'ed is computed
        uncached, so its failure still comes from the ffmpeg read, as the typed `InfraFault` callers expect.

        ITS FAILURES ARE THE MACHINERY'S (review M7), because the pass reads the audio and a language and
        no text: a model that will not download or load, a file ffmpeg will not decode, an accelerator
        fault or out-of-memory in the forward pass all raise `InfraFault` (`ModelUnavailable`,
        `OutOfMemory`), which fails the job instead of the ladder. The one plain error is a language
        whisperx names no model for, a property of the text's language rather than of this box.
        """
        with ML_LOCK:
            bundle = self._bundle_name(language)

            def build() -> Emissions:
                import torch  # noqa: PLC0415

                model, metadata = self._aligner(language)
                # ffmpeg-backed and already 16 kHz — see `load_audio_mono_16k` for why not read_wav_mono.
                mono = torch.from_numpy(load_audio_mono_16k(audio_path))

                # ON THE MODEL'S DEVICE, discovered from its own parameters rather than assumed from
                # config: on an MPS box the align model lives on the accelerator, and a CPU input tensor
                # fails inside the first conv with a device-mismatch RuntimeError. Found LIVE, not in the
                # benchmark — the benchmark always ran --device cpu, where the mismatch cannot exist.
                model_device = next(model.parameters()).device
                chunks = []
                try:
                    with torch.inference_mode():
                        for plan in _frame_passes(len(mono)):
                            piece = mono[plan.offset : plan.stop]
                            # PADDED, NEVER DROPPED. wav2vec2 emits nothing from fewer than 400 samples, so
                            # the old pass broke out of its loop on the final sliver and lost up to 0.1 s of
                            # the song; zero-padding the last frame's field keeps it on the grid.
                            if len(piece) < plan.samples:
                                piece = torch.nn.functional.pad(piece, (0, plan.samples - len(piece)))
                            out = model(piece.unsqueeze(0).to(model_device))
                            # whisperx's torchaudio-backed models return a tuple; HF-backed ones an object
                            # with `.logits`. Both shapes exist in the wild, so both are handled.
                            logits = out[0] if isinstance(out, tuple) else out.logits
                            # Back to CPU immediately: the matrix outlives this pass in a cache, and holding
                            # ~1 MB per song on the accelerator buys nothing; forced_align runs fine on CPU.
                            got = torch.log_softmax(logits, dim=-1)[0].cpu()
                            if len(got) < plan.trim + plan.keep:
                                # A bundle whose stride is not 320/400. Raised rather than shortened,
                                # because a short chunk is exactly the silent drift review 6a removed.
                                raise ValueError(
                                    f"{bundle} produced {len(got)} frames from {plan.samples} samples "
                                    f"where the 320/400 grid needs {plan.trim + plan.keep}; this model's "
                                    "frame rate is not the one `FRAME_SEC` describes"
                                )
                            # The context frames are DISCARDED here: they existed to give the frames we
                            # keep their receptive field, and keeping them would double-stamp the grid.
                            # `.clone()` rather than the slice itself, which is a VIEW that would hold its
                            # whole 1699-frame parent alive until the `cat` below — 12% of the resident set
                            # on English and ~115 MB on the widest vocabulary whisperx tables.
                            chunks.append(got[plan.trim : plan.trim + plan.keep].clone())
                    matrix = torch.cat(chunks) if chunks else torch.zeros((0, 0))
                except Exception as failed:
                    # The forward pass reads no text, so whatever it raises is the device or the model
                    # (review M7): an accelerator fault or out-of-memory, never a verdict on a lyric.
                    raise _machinery_fault(f"the emission pass on {model_device}", failed) from failed
                dictionary = dict(metadata.get("dictionary") or {})
                return Emissions(
                    log_probs=matrix,
                    # The MODEL's hop, not a ratio read off this matrix (see `FRAME_SEC`). An EMPTY matrix
                    # keeps 0.0, the "no clock" `regenerate` and `_speech_mass` already guard on.
                    frame_sec=FRAME_SEC if matrix.shape[0] else 0.0,
                    dictionary=dictionary,
                    model=bundle,
                    blank_id=blank_id_of(dictionary),
                    specials=specials_of(dictionary),
                )

            content = _content_key(audio_path)
            if content is None:
                return build()
            return _cached_emissions((*content, bundle, language, self._device), build)

    def align(self, search: Sequence[Segment], audio_path: str, language: str) -> Sequence[Segment]:
        # ML_LOCK covers LOADING AND RUNNING, and both halves matter: two jobs loading multi-GB
        # checkpoints at once exhausts the accelerator, and two inferences that each expect it to
        # themselves is the same failure a step later. Only reachable with
        # ENCORE_WORKER_CONCURRENCY > 1; at the default of 1 the lock is uncontended and free.
        # CHECKED FIRST so the failure names the contract instead of surfacing as `KeyError: 'start'` from
        # inside whisperx's cropping loop. A caller with untimed text must call `place.spread_over` first; the
        # step does, but a future caller that forgets should be told why rather than left guessing.
        #
        # A plain `ValueError`, NOT `ModelUnavailable` (review W1 r2): that is an `InfraFault`, which fails
        # the JOB, and this is one attempt failing on one text's shape. The step reaches it without
        # forgetting anything: `spread_over` returns an untimed text unchanged when the duration is unknown
        # (no probe, or a probe that could not parse), and a job whose texts are all untimed then failed
        # terminally where it used to decline the attempt and move on to the next text, or to ASR.
        untimed = [
            index
            for index, segment in enumerate(search)
            if not isinstance(segment.get("start"), (int, float)) or isinstance(segment.get("start"), bool)
        ]
        if untimed:
            raise ValueError(
                f"the aligner needs a start on every search segment (missing on {len(untimed)} of "
                f"{len(search)}); whisperx crops the audio per segment. Give untimed text provisional "
                "spans with domain.lyrics.place.spread_over first."
            )
        with ML_LOCK:
            import whisperx  # noqa: PLC0415

            model, metadata = self._aligner(language)
            audio = whisperx.load_audio(audio_path)
            # The search spans ARE the input segments: whisperX crops per segment, which is exactly what
            # `Knob.DROP_WINDOWS` widens when a narrow window from a mis-placed text confines the search.
            aligned = whisperx.align(
                [dict(s) for s in search], model, metadata, audio, self._device, return_char_alignments=False
            )
            segments = aligned.get("segments") if isinstance(aligned, dict) else None
            if not segments:
                # Raising rather than returning empty: the caller's fallback is a DIFFERENT strategy, and an
                # aligner handed real text that produces no words has failed, which is not a fact
                # about the song. A plain error, not `ModelUnavailable`: that is an `InfraFault`, which
                # fails the JOB, and this is one attempt failing on one text (review M7).
                raise RuntimeError("the aligner returned no word-timed segments")
            return tuple(dict(s) for s in segments)


class PyannoteDiarizer:
    """`Diarizer` over pyannote. Optional throughout: a failure degrades, never fails a job.

    FED A PRELOADED WAVEFORM RATHER THAN A PATH, and that is the fix for a real defect rather than a
    micro-optimisation. pyannote 4.0 depends on torchcodec, and torchcodec does not bundle FFmpeg — it
    `dlopen`s the SHARED LIBRARIES (`libavutil.<major>`, `libavcodec`, ...) and supports only majors 4-7.
    Checked against torchcodec 0.7.0 through 0.16.0: none of them ship those libraries, so a static ffmpeg
    binary cannot satisfy it either.

    MEASURED on this project's own Mac, which has the ffmpeg BINARY but no libav* shared libraries: every
    one of torchcodec's four version probes fails, and yet `import pyannote.audio` still SUCCEEDS with only
    a warning. So `module_available("pyannote.audio")` advertised the `diarize` capability on a box where
    diarization could not decode a single file — the same "the module imports, therefore it runs" mistake
    the roformer capability already had to be corrected for.

    Handing pyannote `{"waveform", "sample_rate"}` bypasses its `Audio` loader entirely, which takes
    torchcodec off this worker's runtime path and makes that capability honest again. The WAV being read
    here was written by our own ffmpeg a step earlier, so nothing is decoded twice.
    """

    def __init__(self, *, device: str = "cpu", checkpoint: str = "pyannote/speaker-diarization-3.1") -> None:
        self._device = device
        self._checkpoint = checkpoint

    @staticmethod
    def _preloaded(audio_path: str) -> dict[str, Any]:
        """The file as pyannote's in-memory input: a `(channel, time)` float32 tensor plus its rate.

        MONO, which is not a loss: pyannote downmixes internally anyway, and `read_wav_mono` is the reader
        already used everywhere else here — it probes the container rather than trusting the extension,
        which is what made float32 roformer WAVs readable.
        """
        import torch  # noqa: PLC0415 - lazy by design; see the module docstring

        from encore_worker.domain.audio.wav import read_wav_mono  # noqa: PLC0415

        signal, rate = read_wav_mono(audio_path)
        # float64 -> float32: pyannote's models are float32 and would otherwise raise on the dtype.
        # `[None, :]` gives the (channel, time) shape its loader asserts on.
        waveform = torch.from_numpy(signal.astype("float32", copy=False))[None, :]
        return {"waveform": waveform, "sample_rate": int(rate)}

    def diarize(self, audio_path: str) -> Sequence[Segment]:
        # ML_LOCK covers LOADING AND RUNNING, and both halves matter: two jobs loading multi-GB
        # checkpoints at once exhausts the accelerator, and two inferences that each expect it to
        # themselves is the same failure a step later. Only reachable with
        # ENCORE_WORKER_CONCURRENCY > 1; at the default of 1 the lock is uncontended and free.
        with ML_LOCK:

            def build() -> Any:
                try:
                    from pyannote.audio import Pipeline  # noqa: PLC0415
                except ImportError as missing:
                    raise ModelUnavailable("pyannote.audio is not installed") from missing
                return Pipeline.from_pretrained(self._checkpoint)

            pipeline = _cached(self._device, f"diarize:{self._checkpoint}", build)
            annotation = pipeline(self._preloaded(audio_path))
            return tuple(
                {"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)}
                for turn, _track, speaker in annotation.itertracks(yield_label=True)
            )


def build_transcriber(*, device: str, checkpoint: str) -> WhisperTranscriber | None:
    """A transcriber, or None when this box has no whisperx. Never raises at build time.

    Returning None rather than raising is deliberate: a box without whisperx should not advertise
    `align` at all (`host.capabilities` sees to that), and a build that raised would turn a
    capability-detection question into a crash at startup.
    """
    from encore_worker.host.hardware import module_available

    if not module_available("whisperx"):
        return None
    return WhisperTranscriber(device=device, checkpoint=checkpoint)


def build_aligner(*, device: str) -> WhisperXAligner | None:
    from encore_worker.host.hardware import module_available

    if not module_available("whisperx"):
        return None
    return WhisperXAligner(device=device)


def build_diarizer(*, device: str) -> PyannoteDiarizer | None:
    from encore_worker.host.hardware import module_available

    if not module_available("pyannote.audio"):
        return None
    return PyannoteDiarizer(device=device)
