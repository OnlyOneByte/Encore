"""songProfile builder — the ONE place both separator engines turn the two stem WAVs into the
`songProfile` artifact core validates, so the always-publish contract cannot drift between them.

Core's process gate treats a PRESENT profile as "the analysis step ran" and an ABSENT one as "still
processing" — so a stems job MUST publish a songProfile on every success, even with all inner fields
null, or a song whose vocals stem is digital silence would be permanently unsingable AND never
re-process (core waits forever for a step it thinks already ran).

Both analyses are therefore wrapped best-effort: each fails independently to nulls, logs, and NEVER
raises. A profile failure must never fail the job.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator

from . import key_detect, loudness, vocal_range, wav

# The exact wire shape core validates. Every key is always present; values are null when unknown.
# Building the null profile from one place means "publish nulls on failure" cannot forget a field.
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


def empty_profile() -> dict:
    """A fresh, fully-null profile object. Returned as-is when both analyses are skipped or fail, so
    the artifact is still PRESENT (core's gate: present == the step ran)."""
    return dict(_NULL_PROFILE)


@contextlib.contextmanager
def _degrades_to_nulls(log, problem: str, media_id: str, consequence: str) -> Iterator[None]:
    """Run one half of the analysis, degrading to nulls with a REASON if it raises.

    The "each half fails independently" contract stated once, so the three halves below cannot be given
    three subtly different versions of it. What varies is only the wording — `problem` names what broke,
    `consequence` names which fields stay null — and both are the operator's whole diagnosis, so neither
    is optional.
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
    log=print,
) -> dict:
    """Build the songProfile from the two scratch WAVs. ALWAYS returns the full shape.

    - key* comes from the INSTRUMENTAL (chords carry the key; a monophonic vocal is key-ambiguous).
    - *Midi/histogram comes from the VOCALS (where the original singer sang).

    Each half is independent best-effort: a missing/unreadable instrumental leaves key* null but a
    good vocals stem still yields the range, and vice versa. Any exception (unreadable WAV, empty
    stem, a numpy edge case) is caught, logged with its reason, and degraded to nulls for that half.
    Nothing here can raise to the caller — that is the whole contract.
    """
    profile = empty_profile()

    # The instrumental is decoded ONCE and shared by both measurements below (key + loudness), rather
    # than each re-reading the same multi-minute file. A DECODE failure degrades both halves; a
    # MEASUREMENT failure degrades only its own half — an unreadable chromagram must not throw away a
    # good level, nor the reverse — which is why the two try blocks below stay separate.
    inst_samples = None
    inst_rate = 0
    if instrumental_wav:
        with _degrades_to_nulls(
            log, "could not read the instrumental", media_id, "publishing null key and null loudness"
        ):
            inst_samples, inst_rate = wav.read_wav_mono(instrumental_wav)

    if inst_samples is not None:
        with _degrades_to_nulls(log, "key detection failed", media_id, "publishing null key"):
            tonic, mode, confidence = key_detect.detect_key(inst_samples, inst_rate)
            profile["keyTonic"] = tonic
            profile["keyMode"] = mode
            profile["keyConfidence"] = confidence

    # The INSTRUMENTAL is the file that plays in the room, so its level is what's stored — never a
    # derived gain, since the actual gain is an outlier clamp against the whole library and would go
    # stale on disk; playback derives it from stored levels. Tri-state: an unmeasurable stem (silence /
    # too short / unreadable) stores None, never a fabricated 0.0, which would read as a deafening
    # master and get attenuated into inaudibility.
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
