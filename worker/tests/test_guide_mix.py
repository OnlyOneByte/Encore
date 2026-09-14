"""The guide mix: both stems in ONE 4-channel FLAC, so the TV plays the guide from ONE playhead.

Two halves, deliberately:

  A. ARGV — the pure builder. Cheap, runs everywhere, and pins the two things a silent change could
     break without any test noticing: that the instrumental is input 0 (so it lands in channels 0/1)
     and that nothing downmixes.

  B. REAL ENCODE — actually run ffmpeg and read the channels back out. The argv test cannot tell you
     that `join` put the vocals where the browser will look for them; only a decoded file can. Skipped
     when there is no ffmpeg, because the argv half already guards the shape.

There is no unit test here for "the browser exposes four channels" — that is not a claim Python can
make. It was verified by driving Chromium 1232 and Firefox 140 ESR at a file built by this argv; see
`encode_guide_mix_argv`'s docstring for the numbers.
"""

from __future__ import annotations

import shutil
import struct
import subprocess
import wave

import numpy as np
import pytest

from src.processor import guide_mix_path
from src.separation.demucs import encode_guide_mix_argv

# ── A. the argv ───────────────────────────────────────────────────────────────────────────────────


def test_both_stems_are_inputs_instrumental_first() -> None:
    """Channel order is the contract: the instrumental must be input 0, the vocals input 1.

    The browser splits by channel INDEX, so swapping these puts the vocals in the instrumental's gain —
    audible only as a room that hears isolated vocals at full volume.
    """
    argv = encode_guide_mix_argv("/w/inst.wav", "/w/vox.wav", "/w/mix.flac")
    assert argv.count("-i") == 2
    first, second = (i for i, tok in enumerate(argv) if tok == "-i")
    assert argv[first + 1] == "/w/inst.wav"
    assert argv[second + 1] == "/w/vox.wav"
    assert first < second


def test_maps_each_stem_to_its_own_channel_pair() -> None:
    """The mapping is spelled out rather than left to `join`'s default ordering."""
    argv = encode_guide_mix_argv("/w/inst.wav", "/w/vox.wav", "/w/mix.flac")
    fc = argv[argv.index("-filter_complex") + 1]
    assert "join=inputs=2" in fc
    assert "0.0-FL" in fc and "0.1-FR" in fc  # instrumental -> channels 0/1
    assert "1.0-BL" in fc and "1.1-BR" in fc  # vocals       -> channels 2/3


def test_never_downmixes() -> None:
    """`-ac` here would collapse the four channels and silently make the whole feature a stereo mix."""
    argv = encode_guide_mix_argv("/w/inst.wav", "/w/vox.wav", "/w/mix.flac")
    assert "-ac" not in argv


def test_lossless_flac_at_the_requested_level() -> None:
    argv = encode_guide_mix_argv("/w/i.wav", "/w/v.wav", "/w/m.flac", level=5)
    assert argv[argv.index("-c:a") + 1] == "flac"
    assert argv[argv.index("-compression_level") + 1] == "5"
    assert argv[argv.index("-sample_fmt") + 1] == "s16"
    assert argv[-1] == "/w/m.flac"


def test_declares_the_muxer_so_the_callers_temp_output_still_encodes() -> None:
    """The output FORMAT must be declared, because the caller's filename cannot imply it.

    PublishStems encodes to a temp sibling and renames (atomicity: a killed ffmpeg finalises a valid
    but SHORT file, and the mix owns the master's `duration`). So the path it hands this builder ends
    in `.tmp` — `<id>-guidemix.flac.<pid>.tmp` — and with no `-f`, ffmpeg maps that extension to no
    container and aborts with "Unable to find a suitable output format" before encoding a frame. The
    mix then failed for EVERY song and the room fell back to the two-element guide, which is exactly
    the drift the mix exists to make unrepresentable.

    THE TRAP THIS CLOSES: every other argv test here names a `.flac` output, so the muxer is inferred
    and the defect is invisible to all of them. Passing the shape the REAL caller uses is the whole
    point of this test — do not "tidy" it to `/w/m.flac`.
    """
    tmp = "/media/derived/stems/abc123-guidemix.flac.4242.tmp"
    argv = encode_guide_mix_argv("/w/i.wav", "/w/v.wav", tmp)
    assert argv[argv.index("-f") + 1] == "flac"
    # The declared format must not disturb the output position or the channel-preserving contract.
    assert argv[-1] == tmp
    assert "-ac" not in argv


def test_writes_quietly_and_overwrites() -> None:
    """Same preamble as every other writing call — a stale scratch file must not fail the encode."""
    argv = encode_guide_mix_argv("/w/i.wav", "/w/v.wav", "/w/m.flac", ffmpeg_bin="/opt/ffmpeg")
    assert argv[0] == "/opt/ffmpeg"
    assert argv[1] == "-hide_banner"
    assert "-loglevel" in argv and argv[argv.index("-loglevel") + 1] == "error"
    assert "-y" in argv


def test_path_is_a_sibling_of_the_stems_and_never_reads_as_a_mixdown() -> None:
    assert guide_mix_path("/media", "abc123") == "/media/derived/stems/abc123-guidemix.flac"


# ── B. the real encode ────────────────────────────────────────────────────────────────────────────


def _tone(path: str, hz: float, sr: int = 48000, dur: float = 1.5) -> None:
    t = np.arange(int(sr * dur)) / sr
    mono = 0.5 * np.sin(2 * np.pi * hz * t)
    pcm = (np.stack([mono, mono], axis=1) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def _dominant_hz(samples: np.ndarray, sr: int) -> float:
    spec = np.abs(np.fft.rfft(samples * np.hanning(len(samples))))
    return float(np.fft.rfftfreq(len(samples), 1 / sr)[int(np.argmax(spec))])


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs a real ffmpeg to encode and read back")
def test_real_encode_puts_each_stem_in_its_own_channel_pair(tmp_path) -> None:
    """The claim the argv test cannot make: the DECODED file has the stems where the browser looks.

    300 Hz stands in for the instrumental and 1200 Hz for the vocals, so a swap or a downmix is a
    frequency the assertion can name rather than a byte difference nobody can read.
    """
    sr = 48000
    inst, vox = str(tmp_path / "i.wav"), str(tmp_path / "v.wav")
    mix, back = str(tmp_path / "m.flac"), str(tmp_path / "b.wav")
    _tone(inst, 300.0, sr)
    _tone(vox, 1200.0, sr)

    subprocess.run(encode_guide_mix_argv(inst, vox, mix), check=True, capture_output=True)
    # Decode back to PCM we can read with the stdlib, keeping all four channels.
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", mix, "-c:a", "pcm_s16le", back],
        check=True,
        capture_output=True,
    )

    with wave.open(back, "rb") as w:
        assert w.getnchannels() == 4, "the mix must survive the round trip as FOUR channels"
        frames = w.readframes(w.getnframes())
        rate = w.getframerate()
    flat = np.array(struct.unpack(f"<{len(frames) // 2}h", frames), dtype=np.float64)
    ch = [flat[i::4] for i in range(4)]

    assert _dominant_hz(ch[0], rate) == pytest.approx(300, abs=15)
    assert _dominant_hz(ch[1], rate) == pytest.approx(300, abs=15)
    assert _dominant_hz(ch[2], rate) == pytest.approx(1200, abs=15)
    assert _dominant_hz(ch[3], rate) == pytest.approx(1200, abs=15)
    # And the pairs are ISOLATED, not summed: the instrumental channels carry no vocals energy.
    spec0 = np.abs(np.fft.rfft(ch[0] * np.hanning(len(ch[0]))))
    freqs = np.fft.rfftfreq(len(ch[0]), 1 / rate)
    at1200 = spec0[int(np.argmin(np.abs(freqs - 1200)))]
    at300 = spec0[int(np.argmin(np.abs(freqs - 300)))]
    assert at1200 < at300 / 100, "channel 0 must be the instrumental alone, not a mixdown"
