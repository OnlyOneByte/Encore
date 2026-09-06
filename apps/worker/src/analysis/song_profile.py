"""songProfile builder — the ONE place both separator engines turn the two stem WAVs (still on disk
in scratch, before encoding) into the `songProfile` artifact core validates.

WHY this is its own module: the always-publish contract is subtle and load-bearing, and duplicating
it across demucs.py and roformer.py is how the two would drift. Core's cook gate treats a PRESENT
profile as "the analysis step ran" and an ABSENT one as "still cooking". So a stems job MUST publish
a songProfile object on every success — even when analysis finds nothing — with inner fields null.
The failure this prevents is real: a song whose vocals stem is digital silence (which happens on this
box) would, if we omitted the profile on empty analysis, be permanently unsingable AND never re-cook,
because core would wait forever for a step that already ran.

So BOTH analyses are wrapped best-effort here: key detection and range summary each fail independently
to nulls, are logged, and NEVER raise. The instrumental is the load-bearing output; a profile failure
must never fail the job.
"""

from __future__ import annotations

from . import key_detect, vocal_range

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
}


def empty_profile() -> dict:
    """A fresh, fully-null profile object. Returned as-is when both analyses are skipped or fail, so
    the artifact is still PRESENT (core's gate: present == the step ran)."""
    return dict(_NULL_PROFILE)


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

    # ── key (instrumental) ──────────────────────────────────────────────────────────
    if instrumental_wav:
        try:
            samples, sample_rate = vocal_range.read_wav_mono(instrumental_wav)
            tonic, mode, confidence = key_detect.detect_key(samples, sample_rate)
            profile["keyTonic"] = tonic
            profile["keyMode"] = mode
            profile["keyConfidence"] = confidence
        except Exception as exc:  # noqa: BLE001 — analysis must never fail the cook
            log(
                f"[worker] key detection failed for {media_id} "
                f"({type(exc).__name__}: {exc}); publishing null key",
                flush=True,
            )

    # ── range (vocals) ────────────────────────────────────────────────────────────────
    if vocals_wav:
        try:
            rng = vocal_range.summarize_wav(vocals_wav)
            profile["lowMidi"] = rng["lowMidi"]
            profile["highMidi"] = rng["highMidi"]
            profile["p05Midi"] = rng["p05Midi"]
            profile["p95Midi"] = rng["p95Midi"]
            profile["histogram"] = rng["histogram"]
        except Exception as exc:  # noqa: BLE001 — analysis must never fail the cook
            log(
                f"[worker] vocal-range summary failed for {media_id} "
                f"({type(exc).__name__}: {exc}); publishing null range",
                flush=True,
            )

    return profile
