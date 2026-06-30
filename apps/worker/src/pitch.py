"""Pitch-shift (±key) helper (M7-C9): render transposed variants of a make-karaoke instrumental so
a singer can move the song into their range. The PURE half (semitone→ratio math, ffmpeg argv, the
keyed output path, the ±range) is unit-tested; the actual ffmpeg render only runs on a worker box
with a full ffmpeg build (this sandbox's ffmpeg is a stripped 16-filter build with no atempo/
asetrate). Mirrors demucs.py / whisperx.py: pure logic split from the binary.

ffmpeg has no single "shift pitch, keep tempo" knob without rubberband, so we use the classic
asetrate (resample → pitch+tempo both change) → aresample (back to the device rate) → atempo
(undo the tempo change) chain. rubberband is higher quality if the build has it (GPU/worker image).
"""
from __future__ import annotations

import os

MAX_KEY_SHIFT = 7  # mirrors @encore/shared MAX_KEY_SHIFT (perfect fifth either way)
SAMPLE_RATE = 44100


def clamp_semitones(semitones: int) -> int:
    """Clamp to the supported ±MAX_KEY_SHIFT integer range (matches shared clampKeyShift)."""
    return max(-MAX_KEY_SHIFT, min(MAX_KEY_SHIFT, int(semitones)))


def pitch_ratio(semitones: int) -> float:
    """Frequency ratio for N equal-tempered semitones: 2**(N/12). +12 → 2.0 (octave up)."""
    return 2.0 ** (clamp_semitones(semitones) / 12.0)


def keyed_filename(base_instrumental: str, semitones: int) -> str:
    """Output path for a keyed variant. 0 → the base file unchanged; ±N → `<base>.+N<ext>` /
    `<base>.-N<ext>` (matches @encore/shared keyedMediaRef so the TV resolves the same name)."""
    k = clamp_semitones(semitones)
    if k == 0:
        return base_instrumental
    root, ext = os.path.splitext(base_instrumental)
    sign = f"+{k}" if k > 0 else f"{k}"
    return f"{root}.{sign}{ext}"


def shift_argv(input_path: str, output_path: str, semitones: int, *, sample_rate: int = SAMPLE_RATE,
               use_rubberband: bool = False, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """ffmpeg argv to render `input_path` shifted by `semitones` to `output_path`, tempo preserved.

    rubberband (if the build has it) does pitch-only directly. Otherwise the asetrate→aresample→
    atempo chain: asetrate scales the playback rate (shifting BOTH pitch and tempo by `ratio`),
    aresample returns to `sample_rate`, and atempo=1/ratio undoes the tempo change — net: pitch
    shifted, duration unchanged.
    """
    k = clamp_semitones(semitones)
    ratio = pitch_ratio(k)
    if use_rubberband:
        af = f"rubberband=pitch={ratio:.6f}"
    else:
        af = f"asetrate={sample_rate}*{ratio:.6f},aresample={sample_rate},atempo={1.0 / ratio:.6f}"
    return [ffmpeg_bin, "-y", "-i", input_path, "-af", af, output_path]


def variants_to_render(base_instrumental: str, max_shift: int = MAX_KEY_SHIFT) -> list[tuple[int, str]]:
    """All non-zero (semitones, output_path) pairs to pre-render for a song so any ± key the singer
    picks is already on disk (instant switch — no render-on-tap latency). 0 is the base file."""
    out: list[tuple[int, str]] = []
    for n in range(-max_shift, max_shift + 1):
        if n != 0:
            out.append((n, keyed_filename(base_instrumental, n)))
    return out
