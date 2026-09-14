"""songProfile builder — the ONE place both separator engines turn the two stem WAVs (still on disk
in scratch, before encoding) into the `songProfile` artifact core validates.

WHY this is its own module: the always-publish contract is subtle and load-bearing, and duplicating
it across demucs.py and roformer.py is how the two would drift. Core's process gate treats a PRESENT
profile as "the analysis step ran" and an ABSENT one as "still processing". So a stems job MUST publish
a songProfile object on every success — even when analysis finds nothing — with inner fields null.
The failure this prevents is real: a song whose vocals stem is digital silence (which happens on this
box) would, if we omitted the profile on empty analysis, be permanently unsingable AND never re-process,
because core would wait forever for a step that already ran.

So BOTH analyses are wrapped best-effort here: key detection and range summary each fail independently
to nulls, are logged, and NEVER raise. The instrumental is the load-bearing output; a profile failure
must never fail the job.
"""

from __future__ import annotations

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

    # ── the instrumental, decoded ONCE ──────────────────────────────────────────────
    # Both halves below measure the same file, and each used to read it for itself: the key path called
    # `wav.read_wav_mono` and `measure_lufs(path)` re-opened and re-decoded the very same stem. That was
    # two full decodes of a multi-minute file inside one function for two measurements over identical
    # samples. One decode, shared.
    #
    # A DECODE failure is distinct from a MEASUREMENT failure and degrades both halves, which is what
    # happened before too (the key path logged and nulled; the loudness path returned None from its own
    # failed read). A measurement failure still degrades only its own half — an unreadable chromagram must
    # not throw away a good level, nor the reverse — which is why the two try blocks stay separate below.
    inst_samples = None
    inst_rate = 0
    if instrumental_wav:
        try:
            inst_samples, inst_rate = wav.read_wav_mono(instrumental_wav)
        except Exception as exc:  # noqa: BLE001 — analysis must never fail the process
            log(
                f"[worker] could not read the instrumental for {media_id} "
                f"({type(exc).__name__}: {exc}); publishing null key and null loudness",
                flush=True,
            )

    # ── key (instrumental) ──────────────────────────────────────────────────────────
    if inst_samples is not None:
        try:
            tonic, mode, confidence = key_detect.detect_key(inst_samples, inst_rate)
            profile["keyTonic"] = tonic
            profile["keyMode"] = mode
            profile["keyConfidence"] = confidence
        except Exception as exc:  # noqa: BLE001 — analysis must never fail the process
            log(
                f"[worker] key detection failed for {media_id} "
                f"({type(exc).__name__}: {exc}); publishing null key",
                flush=True,
            )

    # ── loudness (instrumental) ─────────────────────────────────────────────────────
    # Its OWN half of the profile, measured off the same WAV the key came from but independent of it:
    # an unreadable chromagram must not throw away a good level, nor the reverse. The
    # INSTRUMENTAL is the file that plays in the room, and the guide-vocal knob is a fraction of it, so
    # levelling the instrumental is also what makes a guide set to 15% mean the same on the next song.
    #
    # The MEASUREMENT is stored, never a gain. The ruling is an outlier clamp against the library, so
    # the gain depends on every OTHER song's level and moves whenever one is processed; baking it in here
    # would be derived state going stale on disk. Playback derives it from the stored levels.
    #
    # Best-effort like the halves above — measure_lufs never raises — and tri-state: an unmeasurable
    # stem (silence / shorter than one gating block / unreadable) stores None, never a fabricated
    # level. A stored 0.0 would read as a deafening master and be attenuated into inaudibility.
    if instrumental_wav:  # measured and STORED here; the log line is for the operator, not the room
        measured_lufs = loudness.measure_lufs_samples(inst_samples, inst_rate)
        profile["loudnessLufs"] = measured_lufs
        log(
            f"[worker] instrumental loudness for {media_id}: "
            f"{'unmeasurable (null)' if measured_lufs is None else f'{measured_lufs:.2f} LUFS'}",
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
        except Exception as exc:  # noqa: BLE001 — analysis must never fail the process
            log(
                f"[worker] vocal-range summary failed for {media_id} "
                f"({type(exc).__name__}: {exc}); publishing null range",
                flush=True,
            )

    return profile
