"""The zoo separator's REFUSALS, and the heartbeat that keeps a quiet job alive.

A real zoo separation is a 200 MB download and a minute of inference, so what is exercised here is
everything around the model call — which is where the safety lives. The happy path was verified by hand on a
20 s excerpt of `tfr-flyaway` with `bs-roformer-instrumental-resurrection-by-unwa`: it wrote two files, and
role detection named `(other)` the instrumental at 86.73% low-frequency energy against the vocals stem's
2.64% — a 32.9x margin, on the very model whose filenames bs-roformer-infer reports inverted.
"""

from __future__ import annotations

import os
import threading

import numpy as np
import pytest
import soundfile as sf

from encore_worker.adapters import audiosep, zoo
from tests.zoo_fixture import catalogue_or_skip, needs_zoo

RATE = 44100


def write(path: str, freqs: tuple[float, ...], seconds: float = 2.0, gain: float = 0.3) -> str:
    t = np.arange(int(seconds * RATE)) / RATE
    signal = sum(gain * np.sin(2 * np.pi * f * t) for f in freqs)
    sf.write(path, np.asarray(signal), RATE)
    return path


# ── what counts as this run's output ─────────────────────────────────────────────────────────────


def test_only_files_that_appeared_during_this_run_are_considered(tmp_path: object) -> None:
    """DIFFED AGAINST A SNAPSHOT, because scratch is reused across attempts within one job. A previous
    attempt's stems left in the directory would give role detection four files to choose two from — and it
    would classify a pair happily, just not this attempt's pair."""
    out = str(tmp_path)
    stale = write(os.path.join(out, "stale_(Vocals)_x.wav"), (440.0,))
    before = frozenset({stale})
    fresh = write(os.path.join(out, "fresh_(Instrumental)_x.wav"), (110.0,))

    got = audiosep._outputs(out, before)
    assert got == [fresh]


def test_non_audio_files_in_the_output_directory_are_ignored(tmp_path: object) -> None:
    out = str(tmp_path)
    with open(os.path.join(out, "notes.txt"), "w") as handle:
        handle.write("not audio")
    audio = write(os.path.join(out, "a_(Vocals)_x.wav"), (440.0,))
    assert audiosep._outputs(out, frozenset()) == [audio]


# ── the declaration is a cross-check, never the answer ───────────────────────────────────────────


def test_a_declared_backing_stem_is_recognised_in_the_filename() -> None:
    """`audio-separator` interpolates the stem name into the output name, so the declaration is readable —
    and it is used ONLY to note agreement, never to assign the role."""
    assert audiosep._declared_instrumental(("instrumental", "vocals"), "song_(Instrumental)_m.wav") is True
    assert audiosep._declared_instrumental(("instrumental", "vocals"), "song_(Vocals)_m.wav") is False


def test_a_model_declaring_no_stems_yields_no_opinion() -> None:
    """The 62 undeclared entries. None means "the metadata is silent", which is not the same as "disagrees"
    — and it must not read as a disagreement in a log line."""
    assert audiosep._declared_instrumental((), "song_(other)_m.wav") is None


# ── the heartbeat ────────────────────────────────────────────────────────────────────────────────


def test_the_heartbeat_reports_while_a_blocking_call_runs() -> None:
    """The lease is what this protects. `Separator.separate` is an in-process blocking call with no progress
    callback, and a quiet multi-minute step is what the core's reaper treats as a dead worker."""
    seen: list[float] = []
    stop = threading.Event()
    ticker = threading.Thread(target=audiosep._heartbeat, args=(seen.append, stop), daemon=True)

    original = audiosep._HEARTBEAT_SEC
    audiosep._HEARTBEAT_SEC = 0.02
    try:
        ticker.start()
        assert not stop.wait(0.25)
        stop.set()
        ticker.join(timeout=2.0)
    finally:
        audiosep._HEARTBEAT_SEC = original

    assert seen, "no progress was reported, so a long separation would look like a hang"
    assert all(0.0 <= pct < 95.0 for pct in seen), seen


def test_the_heartbeat_never_claims_completion() -> None:
    """DELIBERATELY NOT A PROGRESS ESTIMATE — there is no information about how far along inference is, so a
    percentage that reached 100 would be a lie a UI renders as a finished bar. It is asymptotic to 95."""
    seen: list[float] = []
    stop = threading.Event()
    original = audiosep._HEARTBEAT_SEC
    audiosep._HEARTBEAT_SEC = 0.01
    try:
        ticker = threading.Thread(target=audiosep._heartbeat, args=(seen.append, stop), daemon=True)
        ticker.start()
        stop.wait(0.3)
        stop.set()
        ticker.join(timeout=2.0)
    finally:
        audiosep._HEARTBEAT_SEC = original
    assert max(seen) < 95.0
    assert seen == sorted(seen), "progress must not go backwards"


def test_a_reporting_failure_does_not_abort_the_separation() -> None:
    """The callback crosses into transport. A websocket that closed mid-job must not take the separation
    with it — the work is nearly done and the result may still be publishable."""

    def explode(_pct: float) -> None:
        raise RuntimeError("socket closed")

    stop = threading.Event()
    original = audiosep._HEARTBEAT_SEC
    audiosep._HEARTBEAT_SEC = 0.01
    try:
        ticker = threading.Thread(target=audiosep._heartbeat, args=(explode, stop), daemon=True)
        ticker.start()
        ticker.join(timeout=1.0)
        assert not ticker.is_alive(), "the thread should have returned quietly, not hung or propagated"
    finally:
        audiosep._HEARTBEAT_SEC = original
        stop.set()


def test_no_callback_is_not_an_error() -> None:
    """Called with `on_progress=None` from any caller that does not report."""
    stop = threading.Event()
    stop.set()
    audiosep._heartbeat(None, stop)


# ── refusing an unknown token ────────────────────────────────────────────────────────────────────


def test_an_unknown_token_is_refused_at_construction() -> None:
    """Before any audio is touched. A token valid on another box means a different audio-separator version
    is installed there, and the message says so — otherwise this looks like a corrupt job."""
    from encore_worker.adapters.separate import SeparationFailed

    with pytest.raises(SeparationFailed, match="unknown zoo model"):
        audiosep.ZooSeparator(token="not-a-real-model-token", model_file_dir="/tmp/nope")


# ── refusing to publish something it cannot identify ─────────────────────────────────────────────


def _a_separator(models: tuple[zoo.ZooModel, ...]) -> audiosep.ZooSeparator:
    assert models, "the catalogue was read and offers nothing; see test_zoo for which filter rejected it"
    return audiosep.ZooSeparator(token=models[0].token, model_file_dir="/tmp/zoo-models")


@needs_zoo
def test_two_stems_it_cannot_tell_apart_are_refused(tmp_path: object) -> None:
    """THE REFUSAL EVERYTHING ELSE RESTS ON. A model that returned its input twice — this project has
    already shipped one passthrough — or one that does not separate vocals at all, must fail rather than
    have one of its outputs picked as the karaoke master.

    Non-retryable by nature: re-running a multi-minute inference reaches the same verdict.
    """
    from encore_worker.adapters.separate import SeparationFailed

    models = catalogue_or_skip()
    out = str(tmp_path)
    both = (110.0, 440.0)
    a = write(os.path.join(out, "x_(Vocals)_m.wav"), both)
    b = write(os.path.join(out, "x_(Instrumental)_m.wav"), both)

    with pytest.raises(SeparationFailed, match="too similar to tell apart"):
        _a_separator(models)._roles_of([a, b])


@needs_zoo
def test_a_decidable_pair_is_named_by_measurement_not_by_filename(tmp_path: object) -> None:
    """The filenames here are DELIBERATELY INVERTED — the bass-heavy file is called `(Vocals)`. The
    measurement must win, because that is exactly the bs-roformer case: its `_instrumental` file holds the
    vocals, and believing the name would publish the voice as the backing track."""
    models = catalogue_or_skip()
    out = str(tmp_path)
    lying_vocals = write(os.path.join(out, "x_(Vocals)_m.wav"), (55.0, 80.0, 110.0))
    lying_inst = write(os.path.join(out, "x_(Instrumental)_m.wav"), (330.0, 660.0, 990.0))

    verdict = _a_separator(models)._roles_of([lying_vocals, lying_inst])
    assert verdict.instrumental_path == lying_vocals, "the measurement must override the filename"
    assert verdict.ratio > 3.0
