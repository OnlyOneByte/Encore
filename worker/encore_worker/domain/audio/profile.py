"""songProfile builder — the ONE place both separator engines turn the two stem WAVs into the
`songProfile` artifact core validates, so the always-publish contract cannot drift between them.

Every half is wrapped best-effort: each fails independently to nulls, logs, and NEVER raises, because core
reads a PRESENT profile as "the analysis step ran". Why that makes an absent profile unrecoverable rather
than merely incomplete: XW-06, `docs/arch/05-worker.md` §3.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any, Protocol

from encore_worker.domain.audio import key, loudness, vocal_range, wav


def _silent(*args: Any, flush: bool = False) -> None:
    """The default sink: DROP the diagnostics, the operator surface being the `job:state` trail."""


class Log(Protocol):
    """A `print`-shaped sink. A Protocol rather than `Callable[..., None]` so the `flush=` keyword every
    call site passes is part of the type rather than erased into `*args`."""

    def __call__(self, *args: Any, flush: bool = ...) -> None: ...


# The exact wire shape core validates, from one place so "publish nulls on failure" cannot forget a field.
_NULL_PROFILE = {
    "keyTonic": None,
    "keyMode": None,
    "keyConfidence": None,
    "lowMidi": None,
    "highMidi": None,
    "p05Midi": None,
    "p95Midi": None,
    "histogram": None,
    "loudnessLufs": None,
}


def empty_profile() -> dict[str, object]:
    """A fresh, fully-null profile. Returned as-is when every analysis is skipped or fails, so the
    artifact is still PRESENT — core's gate reads present as "the step ran"."""
    return dict(_NULL_PROFILE)


@contextlib.contextmanager
def _degrades_to_nulls(log: Log, problem: str, media_id: str, consequence: str) -> Iterator[None]:
    """Run one half of the analysis, degrading to nulls with a REASON if it raises.

    The contract stated once, so the three halves cannot be given three subtly different versions of it.
    `problem` names what broke and `consequence` which fields stay null: together the whole diagnosis.
    """
    try:
        yield
    except Exception as exc:  # noqa: BLE001 — analysis must never fail the process
        log(
            f"[worker] {problem} for {media_id} ({type(exc).__name__}: {exc}); {consequence}",
            flush=True,
        )


def build_song_profile(
    instrumental_wav: str | None,
    vocals_wav: str | None,
    media_id: str = "?",
    *,
    log: Log = _silent,
) -> dict[str, object]:
    """Build the songProfile from the two scratch WAVs. ALWAYS returns the full shape and cannot raise.

    `key*` and `loudnessLufs` come from the INSTRUMENTAL, the `*Midi`/`histogram` half from the VOCALS, and
    each half degrades to nulls on its own (`docs/arch/05-worker.md` §3).
    """
    profile = empty_profile()

    # Decoded ONCE and shared by both measurements below; the blocks stay separate so a measurement
    # failure costs only its own half (docs/arch/05-worker.md §3.1).
    inst_samples = None
    inst_rate = 0
    if instrumental_wav:
        with _degrades_to_nulls(
            log, "could not read the instrumental", media_id, "publishing null key and null loudness"
        ):
            inst_samples, inst_rate = wav.read_wav_mono(instrumental_wav)

    if inst_samples is not None:
        with _degrades_to_nulls(log, "key detection failed", media_id, "publishing null key"):
            tonic, mode, confidence = key.detect_key(inst_samples, inst_rate)
            profile["keyTonic"] = tonic
            profile["keyMode"] = mode
            profile["keyConfidence"] = confidence

    # The stored number is the instrumental's LEVEL and never a derived gain: the gain is an outlier clamp
    # against the whole library, so it would go stale on disk and playback derives it instead.
    if instrumental_wav:  # measured and STORED here; the log line is for the operator, not the room
        measured_lufs = loudness.measure_lufs_samples(inst_samples, inst_rate)
        profile["loudnessLufs"] = measured_lufs
        log(
            f"[worker] instrumental loudness for {media_id}: "
            f"{'unmeasurable (null)' if measured_lufs is None else f'{measured_lufs:.2f} LUFS'}",
            flush=True,
        )

    if vocals_wav:
        with _degrades_to_nulls(log, "vocal-range summary failed", media_id, "publishing null range"):
            rng = vocal_range.summarize_wav(vocals_wav)
            profile["lowMidi"] = rng["lowMidi"]
            profile["highMidi"] = rng["highMidi"]
            profile["p05Midi"] = rng["p05Midi"]
            profile["p95Midi"] = rng["p95Midi"]
            profile["histogram"] = rng["histogram"]

    return profile
