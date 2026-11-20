"""The model-zoo separator: any of ~135 checkpoints, with its stem roles MEASURED rather than trusted.

This is the plug-and-play path. `zoo.catalogue()` says what can run; this runs it, behind the same
`ports.Separator` contract demucs and bs-roformer satisfy, so nothing downstream knows the difference.

Three things it does that the hand-registered adapters do not, each because a zoo model is an unknown
quantity: it NAMES THE STEMS ITSELF from `domain/audio/roles` (XW-01), it REFUSES RATHER THAN GUESSES when the
output files cannot be sorted into roles, and it HEARTBEATS FROM A THREAD because the library's separate call
is blocking with no progress callback.

All three with their reasons: `docs/arch/05-worker.md` §2.3.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass

from encore_worker.adapters.separate import SeparationFailed, Stems
from encore_worker.domain.audio import roles
from encore_worker.host.mlrt import ML_LOCK

#: How often the ticker reports while a blocking separation runs. Well inside the lease window; the point is
#: that SOMETHING arrives, not that it arrives often.
_HEARTBEAT_SEC = 5.0

#: Extensions `audio-separator` may write. It defaults to wav; flac appears when configured.
_AUDIO_SUFFIXES = (".wav", ".flac", ".mp3", ".m4a", ".ogg")


@dataclass(frozen=True, slots=True)
class ZooSeparation:
    """A completed zoo separation, with the evidence behind its stem roles."""

    stems: Stems
    instrumental_bass: float
    vocals_bass: float
    ratio: float
    #: True when the model's own metadata agreed with what the audio said. False is not an error — it is the
    #: bs-roformer inversion, and it is worth a log line.
    declaration_agreed: bool | None


def _heartbeat(on_progress: object, stop: threading.Event) -> None:
    """Report liveness while a blocking call runs.

    DELIBERATELY NOT A PROGRESS ESTIMATE. There is no information about how far along the inference is, so
    inventing a percentage would be a lie that a UI would render as a progress bar. This creeps toward but
    never reaches 95%, which is honest about being a clock rather than a measurement, and it keeps the lease
    alive — the one thing that actually matters here.
    """
    if not callable(on_progress):
        return
    started = time.monotonic()
    while not stop.wait(_HEARTBEAT_SEC):
        # Asymptotic: 60 s -> ~48%, 300 s -> ~86%, never 100%.
        elapsed = time.monotonic() - started
        pct = 95.0 * (1.0 - 1.0 / (1.0 + elapsed / 65.0))
        try:
            on_progress(pct)
        except Exception:  # noqa: BLE001 - a reporting failure must never abort a separation
            return


def _outputs(out_dir: str, before: frozenset[str]) -> list[str]:
    """Audio files that appeared in `out_dir` during the run, newest-stable order.

    DIFFED AGAINST A SNAPSHOT rather than globbed outright: the scratch directory is reused across attempts
    within one job, so a previous attempt's stems could otherwise be mistaken for this one's — and with two
    stale files present the role detection would happily classify the wrong pair.
    """
    now = {
        os.path.join(out_dir, name) for name in os.listdir(out_dir) if name.lower().endswith(_AUDIO_SUFFIXES)
    }
    return sorted(now - before)


def _declared_instrumental(model_stems: tuple[str, ...], path: str) -> bool | None:
    """Does the model's own metadata call this file the backing track? None when it does not say.

    Matched on the filename, because `audio-separator` interpolates the stem name into it
    (`<track>_(Instrumental)_<model>.wav`). Only ever used to CROSS-CHECK the measurement.
    """
    lowered = os.path.basename(path).lower()
    backing = [s for s in model_stems if s.lower() in {"instrumental", "no_vocals", "accompaniment", "other"}]
    vocal = [s for s in model_stems if s.lower() in {"vocals", "vocal", "voice"}]
    if any(s.lower() in lowered for s in backing):
        return True
    if any(s.lower() in lowered for s in vocal):
        return False
    return None


class ZooSeparator:
    """`Separator` over `audio-separator`, for any model in `zoo.catalogue()`."""

    def __init__(
        self,
        *,
        token: str,
        model_file_dir: str,
        device: str = "cpu",
        log_level: int = 40,
    ) -> None:
        from encore_worker.adapters import zoo  # noqa: PLC0415 - avoids importing the zoo on non-zoo boxes

        model = zoo.by_token(token)
        if model is None:
            raise SeparationFailed(
                f"unknown zoo model {token!r}. `zoo.catalogue()` lists what this box can run; a token that "
                "was valid on another box means a different audio-separator version is installed there."
            )
        self._model = model
        self._model_file_dir = model_file_dir
        self._device = device
        self._log_level = log_level

    @property
    def name(self) -> str:
        """What RAN, never what was asked — so a completion fact identifies the actual checkpoint."""
        return f"audiosep:{self._model.token}"

    @property
    def model(self) -> str:
        return self._model.token

    def separate(self, input_wav: str, out_dir: str, *, on_progress: object = None) -> Stems:
        return self.separate_verbosely(input_wav, out_dir, on_progress=on_progress).stems

    def separate_verbosely(
        self, input_wav: str, out_dir: str, *, on_progress: object = None
    ) -> ZooSeparation:
        """The full result including the role evidence. `separate` is the port-shaped wrapper over this."""
        os.makedirs(out_dir, exist_ok=True)
        before = frozenset(
            os.path.join(out_dir, n) for n in os.listdir(out_dir) if n.lower().endswith(_AUDIO_SUFFIXES)
        )

        # ML_LOCK covers LOADING AND RUNNING, matching the MLX and pyannote paths: two jobs pulling
        # multi-hundred-MB checkpoints onto one accelerator at the same time is the failure this prevents.
        # Uncontended at the default concurrency of 1.
        with ML_LOCK:
            from audio_separator.separator import Separator  # noqa: PLC0415

            separator = Separator(
                output_dir=out_dir,
                model_file_dir=self._model_file_dir,
                log_level=self._log_level,
            )
            separator.load_model(model_filename=self._model.filename)

            stop = threading.Event()
            ticker = threading.Thread(
                target=_heartbeat, args=(on_progress, stop), name="zoo-heartbeat", daemon=True
            )
            ticker.start()
            try:
                separator.separate(input_wav)
            finally:
                stop.set()
                ticker.join(timeout=_HEARTBEAT_SEC * 2)

        produced = _outputs(out_dir, before)
        if len(produced) != 2:
            raise SeparationFailed(
                f"{self.name} wrote {len(produced)} audio files, expected exactly 2 "
                f"({[os.path.basename(p) for p in produced]}). This worker publishes a two-stem karaoke "
                "master; a model emitting a different number is not one it can use."
            )

        verdict = self._roles_of(produced)
        declared = _declared_instrumental(self._model.stems, verdict.instrumental_path)
        return ZooSeparation(
            stems=Stems(
                instrumental_path=verdict.instrumental_path,
                vocals_path=verdict.vocals_path,
                engine=self.name,
            ),
            instrumental_bass=verdict.instrumental_bass,
            vocals_bass=verdict.vocals_bass,
            ratio=verdict.ratio,
            declaration_agreed=declared,
        )

    def _roles_of(self, produced: list[str]) -> roles.Roles:
        """Measure which file is the backing track, or fail the job saying why it could not be decided."""
        from encore_worker.domain.audio.wav import read_wav_mono  # noqa: PLC0415

        loaded = []
        for path in produced:
            signal, rate = read_wav_mono(path)
            loaded.append((path, signal, rate))

        verdict = roles.classify(loaded[0], loaded[1])
        if verdict is None:
            raise SeparationFailed(
                f"{self.name} produced two stems whose low-frequency content is too similar to tell apart "
                f"({[os.path.basename(p) for p in produced]}). Either this checkpoint does not separate "
                "vocals from a backing track, or it returned its input twice. Refusing rather than guessing: "
                "publishing the vocals as the karaoke master is silent, and nothing downstream could catch "
                "it. See domain/audio/roles.py."
            )
        return verdict
