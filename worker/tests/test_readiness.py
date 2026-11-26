"""Proposal 39: what this box knows is broken reaches core, and the lyrics check names how it failed.

Hermetic: the providers are stand-ins that raise what the real ones raise (`ProviderUnreachable` from the
transport error, as `lrcmux._fetch` does), so no test dials out.
"""

from __future__ import annotations

import socket
import ssl
import urllib.error
from collections.abc import Sequence

from encore_worker.adapters import lrcmux
from encore_worker.adapters.ports import Segment
from encore_worker.protocol import frames as f
from encore_worker.steps import readiness


class _Provider:
    def __init__(self, name: str, error: BaseException | None = None) -> None:
        self.name = name
        self._error = error
        self.asked: list[tuple[str, str]] = []

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[Segment]:
        self.asked.append((artist, track))
        if self._error is not None:
            raise self._error
        return ()  # a miss: the service answered, which is all the check claims


def _unreachable(cause: BaseException) -> lrcmux.ProviderUnreachable:
    """What `lrcmux._fetch` raises: the transport error, wrapped, with the cause kept."""
    try:
        raise lrcmux.ProviderUnreachable(f"lrcmux unreachable: {cause}") from cause
    except lrcmux.ProviderUnreachable as wrapped:
        return wrapped


def test_a_tls_failure_is_lyrics_unreachable_with_its_class() -> None:
    """The goal-2 run's failure: a certificate error, which today only falls back to ASR in silence."""
    tls = urllib.error.URLError(ssl.SSLCertVerificationError("certificate verify failed"))
    note = readiness.lyrics_check([_Provider("lrcmux", _unreachable(tls))])
    assert note == f.Note("lyrics-unreachable", readiness.LYRICS_UNREACHABLE, "lrcmux: TLS")


def test_dns_timeout_and_http_status_are_told_apart() -> None:
    cases = {
        "DNS": _unreachable(urllib.error.URLError(socket.gaierror(-2, "Name or service not known"))),
        "timeout": _unreachable(TimeoutError("timed out")),
        "HTTP 503": lrcmux.ProviderUnreachable("lrcmux answered 503: down for maintenance"),
    }
    for expected, error in cases.items():
        note = readiness.lyrics_check([_Provider("lrcmux", error)])
        assert note is not None and note.detail == f"lrcmux: {expected}", expected


def test_any_provider_answering_is_green_because_songs_fall_back_the_same_way() -> None:
    first = _Provider("lrcmux", _unreachable(TimeoutError("timed out")))
    second = _Provider("lrclib")
    assert readiness.lyrics_check([first, second]) is None
    assert second.asked == [(readiness.PROBE_ARTIST, readiness.PROBE_TRACK)]


def test_every_provider_failing_names_each() -> None:
    note = readiness.lyrics_check(
        [_Provider("lrcmux", _unreachable(TimeoutError("t"))), _Provider("lrclib", RuntimeError("boom"))]
    )
    assert note is not None and note.detail == "lrcmux: timeout; lrclib: RuntimeError"


def test_offline_is_red_too_and_says_why() -> None:
    note = readiness.lyrics_check([])
    assert note is not None and note.code == "lyrics-unreachable" and "ENCORE_OFFLINE" in (note.detail or "")


def test_the_boot_notes_are_the_lines_main_prints() -> None:
    notes = readiness.boot_notes(
        capabilities=frozenset(),
        diarize_off="no pyannote token",
        lyrics_off="no whisper",
        youtube_gap="deno on PATH",
    )
    assert [(n.code, n.text) for n in notes] == [
        ("diarize-off", "diarize off: no pyannote token"),
        ("auto-lyrics-off", "auto lyrics off: no whisper; a pasted sheet still aligns"),
        ("youtube-gap", "YouTube downloads will fail without deno on PATH"),
        ("no-capabilities", "no capabilities proven, so the core will route nothing here"),
    ]
    assert (
        readiness.boot_notes(
            capabilities=frozenset({"stems"}), diarize_off=None, lyrics_off=None, youtube_gap=None
        )
        == ()
    )


def test_notes_and_the_new_frames_on_the_wire() -> None:
    note = f.Note("youtube-gap", "YouTube downloads will fail without deno on PATH")
    hello = f.Hello(worker_id="w1", capabilities=("stems",), concurrency=1, version="1", warnings=(note,))
    assert hello.to_wire()["warnings"] == [{"code": "youtube-gap", "text": note.text}]
    assert f.Warnings(worker_id="w1", warnings=()).to_wire() == {
        "type": "worker:warnings",
        "workerId": "w1",
        "warnings": [],
    }
    assert f.parse({"type": "worker:recheck"}) == f.Recheck()
