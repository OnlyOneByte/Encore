"""Suite-wide guards: the socket is blocked unless a test says `@pytest.mark.allow_network`, and audio
decodes without whisperx where the `ml` extra is absent.

The block caught four tests that had quietly started making live DNS and HTTP calls when the lyrics
clients grew their own `urllib` opener and a monkeypatch stopped intercepting — still green, thirty
seconds slower, against whatever the public API returned that day. Nothing in this suite marks itself.
"""

from __future__ import annotations

import importlib.util
import socket
import sys
from collections.abc import Iterator
from typing import Any

import numpy as np
import pytest

_REAL_CONNECT = socket.socket.connect


class NetworkAccessDenied(RuntimeError):
    """A test tried to open a socket.

    The message names the address, because the useful question is not "did something use the network" but
    "which host, and which adapter reached for it".
    """


@pytest.fixture(autouse=True)
def _no_network(request: pytest.FixtureRequest) -> Iterator[None]:
    """Refuse every outbound socket unless the test opted in.

    Patches `socket.socket.connect` rather than a specific HTTP client, so it cannot be bypassed by
    swapping libraries — which is exactly how the original leak happened.
    """
    # `ml` tests download model checkpoints on first use. Their network access is a declared consequence
    # of the marker rather than a separate opt-in, so a new ML test does not silently fail on a cold cache.
    if request.node.get_closest_marker("allow_network") or request.node.get_closest_marker("ml"):
        yield
        return

    def denied(self: socket.socket, address: Any) -> None:
        raise NetworkAccessDenied(
            f"this test tried to connect to {address!r}. Tests must not touch the network: pass a fake "
            "opener or client instead, or mark the test with @pytest.mark.allow_network if it genuinely "
            "must. See tests/conftest.py for why this is blocked."
        )

    socket.socket.connect = denied  # type: ignore[assignment,method-assign]
    try:
        yield
    finally:
        socket.socket.connect = _REAL_CONNECT  # type: ignore[method-assign]


#: Whether the real `whisperx` is installed (the `ml` extra). Probed once: it is the box, not the test.
_HAS_WHISPERX = importlib.util.find_spec("whisperx") is not None


@pytest.fixture(autouse=True)
def _decode_without_whisperx(request: pytest.FixtureRequest) -> Iterator[None]:
    """Stand in for `whisperx.load_audio` where the `ml` extra is absent, so `-m 'not ml'` runs anywhere.

    `ml.load_audio_mono_16k` is the one seam the alignment steps reach whisperx through (TL-01). The fixtures
    are 16 kHz WAVs, so this reads them with `read_wav_mono`, quantised to int16 like ffmpeg's `s16le` pipe,
    and refuses anything else with the real one's typed `InfraFault`. A test that fakes `whisperx` in
    `sys.modules` gets the real function. Its own `MonkeyPatch`, so a test's `monkeypatch.undo()` keeps it.
    """
    if _HAS_WHISPERX or request.node.get_closest_marker("ml"):
        yield
        return
    from encore_worker.adapters import ml
    from encore_worker.domain.audio.wav import read_wav_mono

    real = ml.load_audio_mono_16k

    def load_audio_mono_16k(path: str) -> Any:
        if "whisperx" in sys.modules:
            return real(path)
        try:
            signal, rate = read_wav_mono(path)
            if rate != 16000:
                raise ValueError(f"the whisperx stand-in decodes 16 kHz only, not {rate} Hz: mark it `ml`")
        except Exception as failed:
            raise ml._machinery_fault(f"decoding {path!r} through ffmpeg", failed) from failed
        return np.clip(np.round(signal * 32768.0), -32768, 32767).astype(np.float32) / 32768.0

    with pytest.MonkeyPatch.context() as patched:
        patched.setattr(ml, "load_audio_mono_16k", load_audio_mono_16k)
        yield


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "allow_network: this test genuinely needs outbound network access")
