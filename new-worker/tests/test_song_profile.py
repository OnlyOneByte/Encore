"""The `songProfile` analysis, against SYNTHESISED signals whose answer is known.

WHY SYNTHESISED AND NOT A FIXTURE. A committed audio file makes a test assert whatever that file happens to
contain; a generated A-minor triad has a correct answer, so these check ACCURACY rather than shape. The key
detector either finds A minor in an A-minor chord or it does not.

THE TOTAL CONTRACT IS THE MOST IMPORTANT THING HERE and it is asserted directly: `build_song_profile` must
never raise and must always return all nine keys. Core's process gate reads a PRESENT profile as "the
analysis step ran" and an ABSENT one as "still processing" — so a raise that lost the artifact would leave
core waiting forever for a step it thinks already happened, making the song permanently unsingable and never
reprocessed. Every test below that feeds it garbage is testing that, not error handling for its own sake.

Pure numpy, so all of this is in the fast suite — no models, no ffmpeg.
"""

from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np
import pytest

from encore_worker.domain.audio import key, loudness, profile, vocal_range, wav

RATE = 22050

#: The nine keys core validates. Pinned as data so a field added on one side and not the other fails here.
WIRE_KEYS = {
    "keyTonic",
    "keyMode",
    "keyConfidence",
    "lowMidi",
    "highMidi",
    "p05Midi",
    "p95Midi",
    "histogram",
    "loudnessLufs",
}


def tone(freqs: list[float], seconds: float = 2.0, rate: int = RATE, amp: float = 0.3) -> np.ndarray:
    """A sum of sine partials — a chord when given several, a note when given one."""
    t = np.arange(int(seconds * rate), dtype=np.float64) / rate
    out = np.zeros_like(t)
    for f in freqs:
        out += amp * np.sin(2.0 * math.pi * f * t)
    return out / max(1.0, len(freqs))


def midi_hz(midi: int) -> float:
    return float(440.0 * (2.0 ** ((midi - 69) / 12.0)))


def write_wav(path: Path, samples: np.ndarray, rate: int = RATE) -> str:
    """A real 16-bit PCM WAV, so the stdlib reader path is exercised rather than mocked."""
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(samples, -1.0, 1.0)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((pcm * 32767.0).astype("<i2").tobytes())
    return str(path)


# ── the wire shape, which is the contract ─────────────────────────────────────────────────────────


def test_an_empty_profile_has_every_key_core_validates() -> None:
    assert set(profile.empty_profile()) == WIRE_KEYS


def test_an_empty_profile_is_all_nulls_not_zeros() -> None:
    """A fabricated 0.0 loudness reads as a deafening master and gets attenuated into inaudibility; a
    fabricated keyTonic of 0 is a confident claim of C. Unknown must be null."""
    assert all(v is None for v in profile.empty_profile().values())


def test_a_fresh_profile_is_not_shared_between_calls() -> None:
    """A module-level dict returned by reference would let one job's measurement leak into the next."""
    first = profile.empty_profile()
    first["keyTonic"] = 7
    assert profile.empty_profile()["keyTonic"] is None


# ── key detection: a known chord ──────────────────────────────────────────────────────────────────


def test_it_finds_a_minor_in_an_a_minor_triad() -> None:
    """A, C, E — three octaves of each so the chromagram sees real harmonic weight rather than one partial."""
    notes = [midi_hz(m) for m in (57, 60, 64, 69, 72, 76, 45, 48, 52)]
    tonic, mode, confidence = key.detect_key(tone(notes, seconds=3.0), RATE)
    assert tonic == 9, f"expected A (9), got {key.key_name(tonic, mode)}"
    assert mode == "minor"
    assert confidence is not None and confidence > 0.5


def test_it_finds_c_major_in_a_c_major_triad() -> None:
    notes = [midi_hz(m) for m in (48, 52, 55, 60, 64, 67, 72)]
    tonic, mode, _conf = key.detect_key(tone(notes, seconds=3.0), RATE)
    assert (tonic, mode) == (0, "major"), f"expected C major, got {key.key_name(tonic, mode)}"


def test_silence_has_no_key_rather_than_a_default_one() -> None:
    """A zero chroma must report None, not pitch class 0 — which would be a confident claim of C on a
    signal with no tonal content at all."""
    assert key.detect_key(np.zeros(RATE, dtype=np.float64), RATE) == (None, None, None)


def test_confidence_is_scale_invariant() -> None:
    """Pearson rather than a dot product, so a loud and a quiet take of the same chord score the same. That
    is what makes `confidence` comparable ACROSS songs rather than only within one."""
    notes = [midi_hz(m) for m in (57, 60, 64, 69)]
    loud = key.detect_key(tone(notes, amp=0.9), RATE)
    quiet = key.detect_key(tone(notes, amp=0.02), RATE)
    assert loud[0] == quiet[0] and loud[1] == quiet[1]
    assert loud[2] is not None and quiet[2] is not None
    assert abs(loud[2] - quiet[2]) < 0.05


def test_noise_scores_lower_than_a_chord() -> None:
    """The point of reporting confidence at all: a drums-only or atonal passage must be distinguishable
    from a clear tonal read, so a consumer can decline to show a key it should not trust."""
    rng = np.random.default_rng(7)
    _t, _m, noisy = key.detect_key(rng.standard_normal(RATE * 2) * 0.1, RATE)
    _t2, _m2, tonal = key.detect_key(tone([midi_hz(m) for m in (57, 60, 64, 69)], seconds=2.0), RATE)
    assert noisy is not None and tonal is not None
    assert tonal > noisy


def test_a_clip_shorter_than_one_frame_still_yields_a_chroma() -> None:
    """Zero-padded rather than skipped, so a short clip is measurable instead of silently keyless."""
    chroma = key.chromagram(tone([440.0], seconds=0.05), RATE)
    assert chroma.sum() > 0


def test_a_chroma_is_l1_normalised() -> None:
    """Relative weight across the twelve classes is the whole signal; absolute magnitude is not."""
    chroma = key.chromagram(tone([midi_hz(m) for m in (60, 64, 67)]), RATE)
    assert chroma.sum() == pytest.approx(1.0)


# ── vocal range ───────────────────────────────────────────────────────────────────────────────────


def test_it_recovers_the_midi_note_of_a_steady_tone(tmp_path: Path) -> None:
    """A 220 Hz tone is A3 = MIDI 57. The tracker is autocorrelation-based, so a pure tone is the case it
    must get exactly right before anything sung is believable."""
    path = write_wav(tmp_path / "v.wav", tone([220.0], seconds=2.0, amp=0.5))
    summary = vocal_range.summarize_wav(path)
    assert summary["lowMidi"] is not None, f"no pitch found at all: {summary}"
    assert abs(float(summary["lowMidi"]) - 57) <= 1  # type: ignore[arg-type]
    assert abs(float(summary["highMidi"]) - 57) <= 1  # type: ignore[arg-type]


def test_percentiles_trim_a_single_outlier_note(tmp_path: Path) -> None:
    """THE reason p05/p95 exist beside low/high: one screamed high note should move the extremes and NOT the
    range a singer actually sings for four minutes."""
    body = tone([220.0], seconds=4.0, amp=0.5)
    spike = tone([880.0], seconds=0.25, amp=0.5)  # A5, two octaves up
    path = write_wav(tmp_path / "v.wav", np.concatenate([body, spike]))
    summary = vocal_range.summarize_wav(path)

    high = float(summary["highMidi"])  # type: ignore[arg-type]
    p95 = float(summary["p95Midi"])  # type: ignore[arg-type]
    assert high > p95 + 6, f"the outlier must raise the extreme well above the 95th pct: {summary}"


def test_a_silent_stem_reports_no_range(tmp_path: Path) -> None:
    path = write_wav(tmp_path / "v.wav", np.zeros(RATE * 2, dtype=np.float64))
    summary = vocal_range.summarize_wav(path)
    assert summary["lowMidi"] is None and summary["highMidi"] is None


# ── loudness ──────────────────────────────────────────────────────────────────────────────────────


def test_digital_silence_is_unmeasurable_not_zero() -> None:
    """A stored 0.0 LUFS reads as a deafeningly loud master and gets attenuated into inaudibility. "I could
    not measure this" and "this is maximally loud" must never be the same value."""
    assert loudness.measure_lufs_samples(np.zeros(RATE * 2, dtype=np.float64), RATE) is None


def test_a_clip_shorter_than_one_gating_block_is_unmeasurable() -> None:
    """BS.1770 integrates over 400 ms blocks; anything shorter cannot be gated, and pyloudnorm raises. The
    guard is explicit so the answer is None rather than whatever the exception would decide."""
    assert loudness.measure_lufs_samples(np.ones(int(0.1 * RATE)) * 0.1, RATE) is None


def test_absent_samples_are_unmeasurable() -> None:
    assert loudness.measure_lufs_samples(None, RATE) is None
    assert loudness.measure_lufs(None) is None


def test_a_missing_file_is_unmeasurable_rather_than_an_error() -> None:
    assert loudness.measure_lufs("/nope/does-not-exist.wav") is None


def test_a_real_level_is_negative_and_finite() -> None:
    """Skipped rather than faked when pyloudnorm is absent: a test that silently asserts nothing is worse
    than one that says why it did not run."""
    pytest.importorskip("pyloudnorm")
    got = loudness.measure_lufs_samples(tone([440.0], seconds=2.0, amp=0.5), RATE)
    assert got is not None and math.isfinite(got) and got < 0.0


# ── the WAV reader ────────────────────────────────────────────────────────────────────────────────


def test_it_reads_a_real_pcm_wav(tmp_path: Path) -> None:
    path = write_wav(tmp_path / "a.wav", tone([440.0], seconds=0.5))
    samples, rate = wav.read_wav_mono(path)
    assert rate == RATE
    assert samples.ndim == 1 and samples.size == int(0.5 * RATE)
    assert float(np.max(np.abs(samples))) <= 1.0


def test_it_downmixes_stereo_to_mono(tmp_path: Path) -> None:
    """Key detection, pitch tracking and loudness are all defined on a mono signal."""
    path = tmp_path / "s.wav"
    left = tone([440.0], seconds=0.5)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        inter = np.stack([left, -left], axis=1).ravel()
        w.writeframes((np.clip(inter, -1, 1) * 32767).astype("<i2").tobytes())
    samples, _rate = wav.read_wav_mono(str(path))
    assert samples.ndim == 1
    # L and R are inverses, so the mono downmix is ~silence. Asserts averaging, not concatenation.
    assert float(np.max(np.abs(samples))) < 0.01


def test_a_header_read_needs_no_decode(tmp_path: Path) -> None:
    path = write_wav(tmp_path / "a.wav", tone([440.0], seconds=1.0))
    assert wav.wav_frame_length(path) == (RATE, RATE)


def test_an_unreadable_header_is_none_rather_than_a_raise(tmp_path: Path) -> None:
    """An unreadable header is a reason to skip the guide mix, not to fail a job whose instrumental is
    fine."""
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"not a wav at all")
    assert wav.wav_frame_length(str(bad)) is None


# ── the total contract: build_song_profile CANNOT fail ────────────────────────────────────────────


def test_it_measures_both_halves_from_real_stems(tmp_path: Path) -> None:
    """The whole artifact, end to end: key from the INSTRUMENTAL (chords carry the key) and range from the
    VOCALS (where the singer sang). Crossing them would report the vocal's momentary pitch class as the
    song's key, which is key-ambiguous by construction."""
    inst = write_wav(tmp_path / "i.wav", tone([midi_hz(m) for m in (57, 60, 64, 69)], seconds=3.0))
    voc = write_wav(tmp_path / "v.wav", tone([220.0], seconds=3.0, amp=0.5))

    got = profile.build_song_profile(inst, voc, "m1")
    assert set(got) == WIRE_KEYS
    assert got["keyTonic"] == 9 and got["keyMode"] == "minor"
    assert got["lowMidi"] is not None, "the vocals half must have measured a range"


def test_a_missing_instrumental_still_yields_the_vocal_range(tmp_path: Path) -> None:
    """Each half degrades INDEPENDENTLY. An unreadable chromagram must not throw away a good range."""
    voc = write_wav(tmp_path / "v.wav", tone([220.0], seconds=2.0, amp=0.5))
    got = profile.build_song_profile("/nope/missing.wav", voc, "m1")
    assert got["keyTonic"] is None
    assert got["lowMidi"] is not None


def test_a_missing_vocals_still_yields_the_key(tmp_path: Path) -> None:
    inst = write_wav(tmp_path / "i.wav", tone([midi_hz(m) for m in (48, 52, 55)], seconds=3.0))
    got = profile.build_song_profile(inst, "/nope/missing.wav", "m1")
    assert got["keyTonic"] == 0
    assert got["lowMidi"] is None


@pytest.mark.parametrize(
    ("inst", "voc"),
    [
        (None, None),
        ("/nope/a.wav", "/nope/b.wav"),
        ("", ""),
    ],
)
def test_it_never_raises_and_always_returns_the_full_shape(inst: str | None, voc: str | None) -> None:
    """THE contract, stated as a test. Core's gate reads present-vs-absent, so losing the artifact to an
    exception is strictly worse than returning nulls: the song becomes unsingable AND never reprocesses,
    because core waits forever for a step it thinks already ran."""
    got = profile.build_song_profile(inst, voc, "m1")
    assert set(got) == WIRE_KEYS


def test_garbage_bytes_degrade_to_nulls_rather_than_raising(tmp_path: Path) -> None:
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"\x00\x01\x02 definitely not audio")
    got = profile.build_song_profile(str(bad), str(bad), "m1")
    assert set(got) == WIRE_KEYS
    assert got["keyTonic"] is None


def test_a_directory_where_a_stem_should_be_degrades_to_nulls(tmp_path: Path) -> None:
    """A refused publish can leave a directory where a file was expected; the analysis must survive it."""
    got = profile.build_song_profile(str(tmp_path), str(tmp_path), "m1")
    assert set(got) == WIRE_KEYS
