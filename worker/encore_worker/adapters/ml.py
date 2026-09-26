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

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from encore_worker.domain.document import Segment
from encore_worker.host.mlrt import ML_LOCK

#: (device, checkpoint) -> loaded handle. Two concurrent jobs on one checkpoint share it; two on
#: different checkpoints cannot evict each other, which a single-slot cache would do.
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


class ModelUnavailable(RuntimeError):
    """A model this box was asked for cannot be loaded.

    `retryable = False`: a missing package or an absent checkpoint is not fixed by trying again, and
    spending three attempts proving it delays the fallback that would have worked.
    """

    retryable = False


def _cached(device: str, checkpoint: str, build: Any) -> Any:
    key = (device, checkpoint)
    if key not in _MODELS:
        _MODELS[key] = build()
    return _MODELS[key]


def clear_cache() -> None:
    """Drop every loaded model. For tests, and for an operator reclaiming VRAM without a restart."""
    _MODELS.clear()


#: wav2vec2 alignment models are trained at 16 kHz; every other rate is resampled to it.
_EMISSION_SAMPLE_RATE = 16000

#: Chunk size for the full-song emission pass. Bounds memory; see `WhisperXAligner.emissions` for why the
#: boundary-context loss is accepted rather than overlapped away.
_EMISSION_CHUNK_SEC = 30


@dataclass(frozen=True)
class Emissions:
    """A song's per-frame character log-probabilities, plus what is needed to decode against them.

    `log_probs` is (frames, vocab) — ~9.7k x 29 for a 3-minute English song, about 1 MB. `dictionary` maps
    characters to vocab ids and travels WITH the matrix because the two are meaningless apart: ids are a
    property of the model that produced these frames.
    """

    log_probs: Any
    frame_sec: float
    dictionary: dict[str, int]

    @property
    def frames(self) -> int:
        return int(self.log_probs.shape[0]) if self.log_probs is not None else 0


def load_audio_mono_16k(path: str) -> Any:
    """A mono float32 signal at 16 kHz from ANY container ffmpeg can read, as a numpy array.

    `whisperx.load_audio` under the hood, which shells ffmpeg — the same decode every v1 alignment already
    used. `domain.audio.wav.read_wav_mono` deliberately reads only WAV/FLAC, and alignment's MIX target is
    the raw yt-dlp download (`original.webm`, `.m4a`): found LIVE when every v2 attempt on a mix target
    declined with `LibsndfileError: Format not recognised` while v1 sailed through the same file.
    """
    import whisperx  # noqa: PLC0415

    return whisperx.load_audio(path)


def forced_align_decoder(log_probs: Any, targets: Sequence[int]) -> tuple[list[int], list[float]]:
    """`domain.lyrics.generate`'s Decoder, over torchaudio's CTC kernel.

    DEPENDENCY RISK, recorded where the import lives: `torchaudio.functional.forced_align` is deprecated
    for REMOVAL in torchaudio 2.9 (the maintenance-phase refactor, pytorch/audio#3902). This project pins
    torchaudio 2.8.0, so nothing breaks today — but the torch-family pins move together, and whoever bumps
    them must either find the kernel's new home or vendor it. The benchmark suite will catch a silent
    behaviour change; this comment exists so the REMOVAL is not a surprise.
    """
    import torch  # noqa: PLC0415
    import torchaudio.functional as F  # noqa: PLC0415

    aligned, scores = F.forced_align(
        log_probs.unsqueeze(0), torch.tensor([list(targets)], dtype=torch.int32), blank=0
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
            # whisperx is untyped, so annotate the unpack here rather than letting Any escape upward.
            loaded: tuple[Any, Any] = whisperx.load_align_model(language_code=language, device=self._device)
            return loaded

        cached: tuple[Any, Any] = _cached(self._device, f"align:{language}", build)
        model, metadata = cached
        return model, metadata

    def emissions(self, audio_path: str, language: str) -> Emissions:
        """The full song's per-frame character log-probabilities, computed ONCE and reusable.

        THE EVIDENCE LAYER of alignment v2 (docs/PLAN-alignment-v2.md). `windowed align` runs the model per
        search span, so five lyrics candidates cost five model passes and every pass trusts its windows.
        This runs the model once over the whole recording — measured at 4.0 s CPU for a 194 s song — and
        every candidate text is then a millisecond `forced_align` decode over the same matrix.

        CHUNKED at 30 s windows to bound memory. wav2vec2's context is convolutional plus self-attention
        within the window, so frames near a chunk boundary see slightly less context than interior frames —
        accepted, because the benchmark measured no gross errors from it (0/75 lines >2 s off), and the
        alternative (overlap + splice) doubles compute for a defect the measurement could not find.

        CACHED per (device, language, audio_path): DBOS may re-enter the workflow, and a retry that
        recomputed 4 s of model time for the same file would pay for durability twice. The cache key is the
        PATH, not the content — safe because scratch files are written once and never mutated in place
        (`artifacts/local.py` stages then renames).
        """
        with ML_LOCK:
            key = f"emissions:{language}:{audio_path}"

            def build() -> Emissions:
                import torch  # noqa: PLC0415

                model, metadata = self._aligner(language)
                # ffmpeg-backed and already 16 kHz — see `load_audio_mono_16k` for why not read_wav_mono.
                mono = torch.from_numpy(load_audio_mono_16k(audio_path))
                duration = len(mono) / _EMISSION_SAMPLE_RATE

                # ON THE MODEL'S DEVICE, discovered from its own parameters rather than assumed from
                # config: on an MPS box the align model lives on the accelerator, and a CPU input tensor
                # fails inside the first conv with a device-mismatch RuntimeError. Found LIVE, not in the
                # benchmark — the benchmark always ran --device cpu, where the mismatch cannot exist.
                model_device = next(model.parameters()).device
                window = _EMISSION_CHUNK_SEC * _EMISSION_SAMPLE_RATE
                chunks = []
                with torch.inference_mode():
                    for start in range(0, len(mono), window):
                        piece = mono[start : start + window]
                        # A sliver shorter than the model's receptive field raises inside wav2vec2;
                        # a tenth of a second of audio carries no line onset worth keeping.
                        if len(piece) < _EMISSION_SAMPLE_RATE // 10:
                            break
                        out = model(piece.unsqueeze(0).to(model_device))
                        # whisperx's torchaudio-backed models return a tuple; HF-backed ones an object
                        # with `.logits`. Both shapes exist in the wild, so both are handled.
                        logits = out[0] if isinstance(out, tuple) else out.logits
                        # Back to CPU immediately: the matrix outlives this pass in a cache, and holding
                        # ~1 MB per song on the accelerator buys nothing — forced_align runs fine on CPU.
                        chunks.append(torch.log_softmax(logits, dim=-1)[0].cpu())
                matrix = torch.cat(chunks) if chunks else torch.zeros((0, 0))
                dictionary = dict(metadata.get("dictionary") or {})
                return Emissions(
                    log_probs=matrix,
                    frame_sec=(duration / matrix.shape[0]) if matrix.shape[0] else 0.0,
                    dictionary=dictionary,
                )

            emitted: Emissions = _cached(self._device, key, build)
            return emitted

    def align(self, search: Sequence[Segment], audio_path: str, language: str) -> Sequence[Segment]:
        # ML_LOCK covers LOADING AND RUNNING, and both halves matter: two jobs loading multi-GB
        # checkpoints at once exhausts the accelerator, and two inferences that each expect it to
        # themselves is the same failure a step later. Only reachable with
        # ENCORE_WORKER_CONCURRENCY > 1; at the default of 1 the lock is uncontended and free.
        with ML_LOCK:
            import whisperx  # noqa: PLC0415

            # CHECKED HERE so the failure names the contract instead of surfacing as `KeyError: 'start'` from
            # inside whisperx's cropping loop. A caller with untimed text must call `place.spread_over` first;
            # the step does, but a future caller that forgets should be told why rather than left guessing.
            untimed = [
                index
                for index, segment in enumerate(search)
                if not isinstance(segment.get("start"), (int, float))
                or isinstance(segment.get("start"), bool)
            ]
            if untimed:
                raise ModelUnavailable(
                    f"the aligner needs a start on every search segment (missing on {len(untimed)} of "
                    f"{len(search)}); whisperx crops the audio per segment. Give untimed text provisional "
                    "spans with domain.lyrics.place.spread_over first."
                )

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
                # about the song.
                raise ModelUnavailable("the aligner returned no word-timed segments")
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
