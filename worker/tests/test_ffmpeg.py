"""The ffmpeg dependency, which is really TWO dependencies that look like one.

  the BINARY        the worker shells `ffmpeg` for yt-dlp's WAV postprocess, `decode_to_wav`, the FLAC and
                    guide-mix encoders and the silence probe. `host.ffmpeg` resolves it, preferring a
                    bundled static build so the published FLAC is reproducible across machines.
  SHARED LIBRARIES  torchcodec (via pyannote 4.0) `dlopen`s `libavutil.<major>` and friends. A static
                    binary CANNOT satisfy that, so the worker's answer is to not need it.

Both halves are asserted here because conflating them is the mistake: "we bundle ffmpeg" sounds like it
fixes torchcodec and does not.
"""

from __future__ import annotations

import importlib.util
import os

import numpy as np
import pytest
import soundfile as sf

from encore_worker.host import ffmpeg
from encore_worker.host.config import Config

# ── resolution order ─────────────────────────────────────────────────────────────────────────────


def test_an_explicit_binary_always_wins() -> None:
    """An operator naming a binary has a reason — a build with NVENC, VideoToolbox, a patched libopus. No
    heuristic here may override it, and it is returned UNVALIDATED: a path that does not exist should fail
    loudly at exec rather than be quietly swapped for something else."""
    assert ffmpeg.resolve("/nonexistent/my-ffmpeg") == "/nonexistent/my-ffmpeg"


def test_an_empty_override_is_treated_as_unset() -> None:
    """`ENCORE_FFMPEG_BIN=` in a .env file is a blank, not a request to exec the empty string."""
    assert ffmpeg.resolve("") == ffmpeg.resolve(None)


def test_the_bundled_build_is_preferred_over_path() -> None:
    """THE ONE CHOICE HERE THAT COULD GO EITHER WAY, so it is pinned rather than left to reading the code.

    The case for PATH-first is that an operator's own build is probably better. The case that wins is
    reproducibility: two workers in a pool must not encode stems with different FFmpeg majors, and
    `job_attempts` records no ffmpeg version to explain it afterwards if they do.
    """
    bundled = ffmpeg.bundled()
    if bundled is None:
        pytest.skip("the `ffmpeg` extra is not installed here, so there is no preference to observe")
    assert ffmpeg.resolve(None) == bundled
    assert ffmpeg.resolve(None) != ffmpeg.FALLBACK


def test_path_is_the_fallback_when_nothing_is_bundled(monkeypatch: pytest.MonkeyPatch) -> None:
    """A platform with no wheel (musl/Alpine, BSD, ppc64le) must still work exactly as it does today.
    This is why the bundle is an EXTRA rather than a base dependency — as a base dependency it would break
    those platforms outright, which is the opposite of the goal."""
    monkeypatch.setattr(ffmpeg, "bundled", lambda: None)
    ffmpeg.resolve.cache_clear()
    try:
        assert ffmpeg.resolve(None) == ffmpeg.FALLBACK
    finally:
        ffmpeg.resolve.cache_clear()


def test_config_resolves_rather_than_reading_the_raw_env() -> None:
    """The wiring, not the resolver: an unset env var must reach `resolve()` and come back as a real path.
    Asserted because `text("ENCORE_FFMPEG_BIN", "ffmpeg")` — reading with a literal default — is the
    obvious-looking form and silently defeats the whole feature."""
    resolved = Config.from_env({}).ffmpeg_bin
    assert resolved == ffmpeg.resolve(None)


def test_an_explicit_env_var_reaches_the_config() -> None:
    assert Config.from_env({"ENCORE_FFMPEG_BIN": "/opt/ffmpeg"}).ffmpeg_bin == "/opt/ffmpeg"


# ── the binary actually runs, and does what this worker needs ────────────────────────────────────


def test_the_resolved_binary_runs() -> None:
    """`probe_version` returning None is exactly the state that makes `stems` unavailable, so a green here
    is what says this box can separate at all."""
    assert ffmpeg.probe_version(ffmpeg.resolve(None)) is not None


def test_describe_names_the_origin_so_an_encode_is_reproducible() -> None:
    """Three facts in one log line — which binary, where it came from, what version. Without the origin,
    "ffmpeg 7.1" does not distinguish a bundled build from a system one that happens to match."""
    line = ffmpeg.describe(ffmpeg.resolve(None))
    assert any(origin in line for origin in ("bundled", "PATH", "explicit"))


def test_describe_never_raises_on_a_binary_that_cannot_run() -> None:
    """A box that cannot run ffmpeg still has to be able to SAY so — this line is how an operator finds
    out, so it must not be the thing that crashes."""
    assert "will not run" in ffmpeg.describe("/nonexistent/my-ffmpeg")


@pytest.mark.parametrize(
    "codec",
    [
        "flac",  # published stems
        "opus",  # yt-dlp's usual webm audio
        "aac",  # yt-dlp's m4a audio
        "vorbis",  # older webm audio
        "pcm_s16le",  # decode_to_wav
    ],
)
def test_the_resolved_binary_carries_every_codec_this_worker_uses(codec: str) -> None:
    """A MINIMAL static build is the real risk with bundling, and it would fail per-codec at job time —
    the input that happened to be Vorbis, months later. Checked once, up front, instead."""
    import subprocess

    done = subprocess.run(
        [ffmpeg.resolve(None), "-hide_banner", "-codecs"],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert done.returncode == 0
    assert any(line.split()[1:2] == [codec] for line in done.stdout.splitlines() if line.startswith(" ")), (
        f"the resolved ffmpeg cannot handle {codec}"
    )


@pytest.mark.parametrize("filt", ["amix", "join", "volume"])
def test_the_resolved_binary_carries_the_filters_the_guide_mix_needs(filt: str) -> None:
    """`join` with an explicit channel map is how the guide mix folds two stems into one four-channel
    file. A build without it fails only on guide-mix jobs."""
    import subprocess

    done = subprocess.run(
        [ffmpeg.resolve(None), "-hide_banner", "-filters"],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert done.returncode == 0
    assert any(line.split()[1:2] == [filt] for line in done.stdout.splitlines())


# ── the OTHER half: torchcodec, which bundling a binary does not fix ─────────────────────────────


def test_the_diarizer_hands_pyannote_the_shape_its_loader_asserts_on() -> None:
    """`(channel, time)` float32 plus an int rate. pyannote's loader rejects anything else by contract
    (`'waveform' must be provided as a (channel, time) torch Tensor`), and float64 — which
    `read_wav_mono` returns — would raise on dtype inside the model.
    """
    if importlib.util.find_spec("torch") is None:
        pytest.skip("torch is not installed here")
    from encore_worker.adapters.ml import PyannoteDiarizer

    rate = 16000
    signal = (0.2 * np.sin(2 * np.pi * 220 * np.arange(rate * 2) / rate)).astype("float32")
    path = os.path.join(os.environ.get("TMPDIR", "/tmp"), "test_ffmpeg_diar.wav")
    sf.write(path, signal, rate)
    try:
        preloaded = PyannoteDiarizer._preloaded(path)
    finally:
        os.unlink(path)

    waveform = preloaded["waveform"]
    assert waveform.ndim == 2, "pyannote asserts on (channel, time)"
    # Its own check is literally `shape[0] > shape[1]`, so channels must come first.
    assert waveform.shape[0] < waveform.shape[1]
    assert str(waveform.dtype) == "torch.float32", "the models are float32; float64 raises"
    assert preloaded["sample_rate"] == rate
    assert isinstance(preloaded["sample_rate"], int)


def test_pyannote_itself_accepts_that_input_without_touching_torchcodec() -> None:
    """THE DEFECT THIS FIXES, asserted against the real library rather than a mock.

    MEASURED on this project's Mac, which has the ffmpeg BINARY but no libav* shared libraries: all four
    of torchcodec's version probes fail, and yet `import pyannote.audio` still SUCCEEDS with only a
    warning — so `module_available("pyannote.audio")` advertised the `diarize` capability on a box where
    diarization could not decode one file. Feeding a preloaded waveform takes torchcodec off the runtime
    path, which makes that capability honest again.

    pyannote's own warning text prescribes exactly this ("use audio preloaded in-memory as a
    {'waveform': ..., 'sample_rate': int} dictionary"), so this is the supported route, not a trick.
    """
    if importlib.util.find_spec("pyannote.audio") is None:
        pytest.skip("pyannote.audio is not installed here")
    import sys

    from pyannote.audio import Audio

    from encore_worker.adapters.ml import PyannoteDiarizer

    rate = 16000
    signal = (0.2 * np.sin(2 * np.pi * 220 * np.arange(rate * 2) / rate)).astype("float32")
    path = os.path.join(os.environ.get("TMPDIR", "/tmp"), "test_ffmpeg_diar2.wav")
    sf.write(path, signal, rate)
    try:
        preloaded = PyannoteDiarizer._preloaded(path)
    finally:
        os.unlink(path)

    sys.modules.pop("torchcodec", None)
    waveform, got_rate = Audio()(preloaded)
    assert got_rate == rate
    assert waveform.shape == (1, rate * 2)
    # The point of the whole change: pyannote read the audio and never reached for the decoder that
    # cannot load here.
    assert "torchcodec" not in sys.modules, "pyannote fell back to its own decoder; the bypass is not working"


def test_no_torchcodec_version_bundles_the_libraries_it_needs() -> None:
    """Recorded as a test so "just upgrade torchcodec" is not proposed again. Checked against the installed
    wheel: it ships `libtorchcodec_core{4..9}` and NO `libav*`, which is also true of 0.16.0 — the newest
    release at the time of writing. There is no version of this dependency that makes the shared-library
    requirement go away.
    """
    if importlib.util.find_spec("torchcodec") is None:
        pytest.skip("torchcodec is not installed here")
    import glob
    import pathlib

    root = pathlib.Path(str(importlib.util.find_spec("torchcodec").origin)).parent  # type: ignore[union-attr]
    shipped = {os.path.basename(p) for p in glob.glob(str(root / "*"))}
    assert any(n.startswith("libtorchcodec_core") for n in shipped), "expected its own core libs"
    assert not any(n.startswith("libav") for n in shipped), (
        "torchcodec now bundles libav* — if so, the diarizer's preloaded-waveform bypass is no longer "
        "load-bearing and this comment tree can be simplified. Verify before removing anything."
    )
