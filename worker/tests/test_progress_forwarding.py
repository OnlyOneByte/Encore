"""A real percentage reaches the core where one exists, and none is invented where it does not (WK-07).

Before this, every step passed `on_progress=None`, so the only `job:progress` frames were the keepalive's
`pct=0` and the phone sat at the stage floor for a whole separation.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from encore_worker.adapters.cli import parse_pct
from encore_worker.adapters.ports import ProgressSink
from encore_worker.adapters.separate import Stems
from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.host.config import Config
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import JobRef
from encore_worker.steps.separate_steps import FetchStepsImpl, SeparateStepsImpl

CFG = Config(worker_id="w1")


class Reporter:
    def __init__(self) -> None:
        self.progress_frames: list[tuple[Stage, int]] = []

    async def progress(self, job_id: str, stage: Stage, pct: int) -> None:
        self.progress_frames.append((stage, pct))

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        pass

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        return True

    def explain_ownership(self, job_id: str) -> str:
        return "ours"


async def _settle() -> None:
    """The sink hands each report to the loop from the port's thread; let those land."""
    for _ in range(10):
        await asyncio.sleep(0)


def _job(tmp: Path) -> JobRef:
    return JobRef(job_id="j1", media_id="m1", media_dir=str(tmp), source_uri="https://x.test/v")


class Engine:
    """A separator that prints a bar, as demucs does, including a repeat and a dip."""

    def __init__(self, name: str = "demucs", figures: tuple[float, ...] = (5, 5, 12, 9, 40)) -> None:
        self.name = name
        self.figures = figures
        self.got_sink = False

    def separate(self, input_wav: str, out_dir: str, *, on_progress: ProgressSink | None = None) -> Stems:
        self.got_sink = on_progress is not None
        for pct in self.figures:
            if on_progress is not None:
                on_progress(int(pct))
        return Stems(instrumental_path=f"{out_dir}/no_vocals.wav", vocals_path=None, engine=self.name)


def _separate_steps(tmp: Path, reporter: Reporter, engine: Engine) -> SeparateStepsImpl:
    audio = AlignStepsImpl(config=CFG, adapters=Adapters(), reporter=reporter)
    return SeparateStepsImpl(
        config=CFG,
        audio=audio,
        reporter=reporter,
        store=LocalArtifactStore(Roots.under(str(tmp / "media"))),
        separator=engine,
    )


def test_the_demucs_bar_is_parsed() -> None:
    assert parse_pct(" 45%|████▌     | 52.6/117.0 [00:10<00:12,  5.10seconds/s]") == 45
    assert parse_pct("100%|██████████| 117.0/117.0 [00:23<00:00,  5.01seconds/s]") == 100
    assert parse_pct("Separated tracks will be stored in /tmp/x") is None


async def test_a_separators_rising_figures_reach_the_core_as_separating(tmp_path: Path) -> None:
    reporter = Reporter()
    await _separate_steps(tmp_path, reporter, Engine()).separate(_job(tmp_path), str(tmp_path / "in.wav"))
    await _settle()
    assert reporter.progress_frames == [(Stage.SEPARATING, 5), (Stage.SEPARATING, 12), (Stage.SEPARATING, 40)]


async def test_the_in_process_zoo_gets_no_sink_so_its_clock_is_never_sent_as_progress(tmp_path: Path) -> None:
    """`audiosep._heartbeat` creeps toward 95% on a timer: a clock, which the phone would draw as a bar."""
    reporter, engine = Reporter(), Engine(name="audiosep:bs-roformer")
    await _separate_steps(tmp_path, reporter, engine).separate(_job(tmp_path), str(tmp_path / "in.wav"))
    await _settle()
    assert engine.got_sink is False
    assert reporter.progress_frames == []


class Fetcher:
    def __init__(self) -> None:
        self.got_sink = False
        self.with_captions = False

    def fetch(
        self,
        source_uri: str,
        out_dir: str,
        *,
        on_progress: ProgressSink | None = None,
        with_captions: bool = False,
    ) -> str:
        self.got_sink = on_progress is not None
        self.with_captions = with_captions
        if on_progress is not None:
            for pct in (10, 60, 100):
                on_progress(pct)
        return f"{out_dir}/original.mp3"


async def test_a_fetch_job_forwards_its_download_percentage(tmp_path: Path) -> None:
    reporter, fetcher = Reporter(), Fetcher()
    audio = AlignStepsImpl(config=CFG, adapters=Adapters(fetcher=fetcher), reporter=reporter)
    store = LocalArtifactStore(Roots.under(str(tmp_path / "media")))
    steps = FetchStepsImpl(config=CFG, audio=audio, reporter=reporter, store=store)
    await steps.acquire_audio(_job(tmp_path))
    await _settle()
    assert reporter.progress_frames == [(Stage.DOWNLOADING, p) for p in (10, 60, 100)]
    assert fetcher.with_captions, "the fetch job's download brings the captions in the same call"


async def test_a_download_inside_a_later_job_does_not_drag_its_bar_back(tmp_path: Path) -> None:
    """A stems or align job that has to fetch is past the download band; its percentage would pull the bar
    back to it."""
    reporter, fetcher = Reporter(), Fetcher()
    audio = AlignStepsImpl(config=CFG, adapters=Adapters(fetcher=fetcher), reporter=reporter)
    await audio.acquire_audio(_job(tmp_path))
    await _settle()
    assert fetcher.got_sink is False and reporter.progress_frames == []
