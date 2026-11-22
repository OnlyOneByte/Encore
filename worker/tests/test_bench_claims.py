"""`bench.py`, every mode through its real CLI: `--global --claims` now runs the SHIPPED `time_text`.

WHY. `--global --claims` crashed with NameError `merged_pre` before printing its last row,
and what it did print came from a hand reimplementation of R2 and adoption, not the shipped ladder.
Nothing ran the script, so nothing noticed. This drives `main()` exactly as the command line does, over
a synthetic song. The aligner is a fake whose emissions sing the song, and the decoder is the suite's
CTC Viterbi (frame-for-frame torchaudio's, `test_ml_contract.py`). So a NameError, a stale import or a
renamed helper in ANY mode fails here, the windowed offset sweep included. The claims row must also be
the shipped attempt's: graded lines, the verdict on the trail, and claims that diagnose an offset
without moving a single timing.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from encore_worker.host.config import Config
from tests.ctc_fixture import FRAME_SEC, ctc_viterbi, sung_matrix

SCRIPTS = Path(__file__).resolve().parents[2] / "docs" / "benchmarks" / "forced-alignment" / "scripts"
RATE = 16000
DIC = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz'")}
PHRASES = (
    ("come and fly away", 5.0, 7.0),
    ("with me tonight", 8.0, 10.0),
    ("over the silver water", 12.0, 14.5),
    ("carry me home", 16.0, 18.0),
    ("come and fly away", 22.0, 24.0),
    ("stars are out", 25.5, 27.5),
    ("morning light across the river", 30.0, 33.0),
    ("come and fly away", 35.0, 37.0),
)
DURATION = 40.0


def load_bench() -> ModuleType:
    if "bench" in sys.modules:
        return sys.modules["bench"]
    spec = importlib.util.spec_from_file_location("bench", SCRIPTS / "bench.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["bench"] = module
    spec.loader.exec_module(module)
    return module


@dataclass(frozen=True)
class Emitted:
    log_probs: Any
    frame_sec: float
    dictionary: dict[str, int]

    @property
    def frames(self) -> int:
        return len(self.log_probs)


class SungAligner:
    """Stands in for `WhisperXAligner`: its emissions hear PHRASES where they are sung."""

    def __init__(self, *, device: str = "cpu") -> None:
        self.device = device

    def emissions(self, _path: str, _language: str) -> Emitted:
        return Emitted(sung_matrix(PHRASES, DIC, DURATION), FRAME_SEC, DIC)

    def align(self, *_a: object, **_k: object) -> tuple[()]:
        raise AssertionError("--global never runs the windowed aligner")


@pytest.fixture()
def song(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A synthetic song dir: the mix (a tone per sung phrase), line truth and word truth."""
    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "WhisperXAligner", SungAligner)
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    signal = np.random.default_rng(0).normal(0.0, 0.002, int(DURATION * RATE))
    words: list[dict[str, float]] = []
    for text, start, end in PHRASES:
        t = np.arange(int((end - start) * RATE)) / RATE
        signal[int(start * RATE) : int(start * RATE) + len(t)] += 0.3 * np.sin(2 * math.pi * 220.0 * t)
        step = (end - start) / len(text.split())
        words += [
            {"start": start + k * step, "end": start + (k + 1) * step} for k in range(len(text.split()))
        ]
    sf.write(tmp_path / "mix.wav", signal, RATE)
    lines = [{"text": text, "start": start, "end": end} for text, start, end in PHRASES]
    (tmp_path / "truth-lines.json").write_text(json.dumps({"lines": lines}), encoding="utf-8")
    (tmp_path / "truth-words.json").write_text(json.dumps({"words": words}), encoding="utf-8")
    return tmp_path


def run_cli(song: Path, capsys: pytest.CaptureFixture[str], *flags: str) -> str:
    bench = load_bench()
    argv = ["bench.py", "--song", "synthetic", "--truth", str(song / "truth-lines.json")]
    argv += ["--audio", str(song / "mix.wav"), *flags]
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(sys, "argv", argv)
        bench.main()
    return capsys.readouterr().out


def test_every_global_mode_runs_through_the_cli(song: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = run_cli(
        song,
        capsys,
        "--global",
        "--repair",
        "--dump",
        "--words",
        str(song / "truth-words.json"),
        "--claims",
        "--snap",
        "--evidence",
        "--rescue",
    )
    for row in ("global:", "R3:", "global+R3:", "words:", "time_text(claims", "time_text+claims:"):
        assert row in out, f"missing {row!r} in:\n{out}"
    for row in ("global+snap:", "evidence (song median", "never-sung dropped:", "syllable spans emitted:"):
        assert row in out, f"missing {row!r} in:\n{out}"


def test_claims_run_the_shipped_attempt_and_grade_every_line(
    song: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = run_cli(song, capsys, "--global", "--claims")
    header = next(line for line in out.splitlines() if "time_text(claims" in line)
    assert "published (doc confidence high); verdict=agree; 8/8 lines high" in header, header
    assert "repair faults: none" in header
    assert "time_text+claims: lines 8/8" in out and ">2s 0" in out.split("time_text+claims:")[1]


class EchoAligner:
    """The windowed engine's shape: aligned segments come back exactly where they were searched."""

    def __init__(self, *, device: str = "cpu") -> None:
        self.device = device

    def align(self, search: Any, _audio: str, _language: str) -> list[dict[str, object]]:
        return [dict(segment) for segment in search]


def test_the_windowed_offset_sweep_still_runs(
    song: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """bench.py's default mode, untouched by the claims rewrite, and still a working command. An echo
    aligner passes every offset through at unity gain, which is the windowed engine's measured failure."""
    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "WhisperXAligner", EchoAligner)
    out = run_cli(song, capsys)
    assert "exact" in out and "shifted +5.00s" in out and "blind" in out, out
    shifted = next(line for line in out.splitlines() if "shifted +2.00s" in line)
    assert "+2000m" in shifted, "an echo aligner passes the offset straight through"


def test_offset_claims_are_diagnosed_on_the_trail_and_move_nothing(song: Path) -> None:
    """The shipped design, measured through the bench: a +1 s sheet grades lines and names its offset,
    but the published starts are the decode's, identical to the truth-claims run's.

    WHICH NUMBER NAMES THE OFFSET changed with the claim clock, which maps the sheet onto our clock
    before the first reconcile, so the VERDICT's own offset is what is left afterwards (`agree`, -0.04 s of
    onset lead) and the sheet's 1 s is the MAP's. Both are on the same trail line. What did not change is
    the half this test exists for: the claims still move no timing.
    """
    bench = load_bench()
    truth = [{"text": text, "start": start, "end": end} for text, start, end in PHRASES]
    runs = {}
    for offset in (0.0, 1.0):
        media = song / f"media{offset}"
        media.mkdir()
        runs[offset] = bench.time_text_claims(
            SungAligner(),
            audio=str(song / "mix.wav"),
            vocals=None,
            truth=truth,
            offset=offset,
            language="en",
            media_dir=str(media),
            config=Config(),
        )
    agree, late = runs[0.0], runs[1.0]
    assert agree["outcome"] == late["outcome"] == "published"
    # -1.00 exactly, not a lead short of it: the envelope candidate wins the vote, and it reads the CLAIMS
    # against the audio's own activity rather than against our decode, which carries `ONSET_LEAD_SEC`.
    assert late["verdict"] == "agree", late["why"]
    assert "claims mapped onto our clock by envelope-lag -1.00s" in late["why"], late["why"]
    assert [ln.index for ln in late["lines"]] == list(range(len(PHRASES))), "paired by identity"
    assert [ln.start for ln in late["lines"]] == [ln.start for ln in agree["lines"]], "claims moved a timing"
