"""PublishStems' guide-mix emission, driven through the real step with a fake runner.

Exists because a prior mutation audit deleted the entire emission block, and renamed the artifact key,
with the suite staying green — nothing asserted the `guideMix` string against the real step. That's
dangerous specifically because the core reads `msg.artifacts?.stems?.guideMix` with optional chaining,
so a missing/typo'd key silently arrives as `undefined` and every room falls back to the two-element
guide forever, with nothing in any log.

The property each test defends: ENCODING and PUBLISHING are one atom. A ref published for a file never
written points the TV at a 404; a file written whose ref is never published wastes the work.
"""

from __future__ import annotations

import os
import wave

import pytest

from src.processor import JobSpec, guide_mix_path, instrumental_path, vocals_path
from src.runtime import Ctx
from src.steps.separate import PublishStems


class FakeRunner:
    """Records every argv it is asked to run, and creates the output file the real ffmpeg would."""

    def __init__(self, *, fail_on: str | None = None) -> None:
        self.calls: list[list[str]] = []
        self._fail_on = fail_on

    def __call__(self, argv: list[str]):  # noqa: ANN204 - matches the runner protocol
        self.calls.append(list(argv))
        out = argv[-1]
        if self._fail_on and self._fail_on in " ".join(argv):
            raise RuntimeError("ffmpeg exploded")

        async def _gen():
            # The real runner writes the output as a side effect; the temp-then-rename path in the step
            # depends on the temp actually existing, so create it.
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "wb") as fh:
                fh.write(b"\0" * 16)
            if False:
                yield ""

        return _gen()

    def argv_for(self, needle: str) -> list[list[str]]:
        return [c for c in self.calls if any(needle in tok for tok in c)]


def _wav(path: str, frames: int = 4410, rate: int = 44100) -> None:
    """A real stereo PCM WAV. Real, because the step now reads the two stems' headers to confirm they are
    the same length before folding them — `join` truncates to the shorter and exits 0."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0" * (frames * 4))


def _ctx(tmp_path, runner, *, vocals: bool, silent: bool = False, vox_frames: int = 4410) -> Ctx:
    raw_inst = str(tmp_path / "work" / "inst.wav")
    raw_vox = str(tmp_path / "work" / "vox.wav")
    _wav(raw_inst)
    if vocals:
        _wav(raw_vox, frames=vox_frames)
    job = JobSpec(
        job_id="j1", media_id="m1", job_type="stems", source_uri="u", params={}, media_dir=str(tmp_path)
    )
    ctx = Ctx(job=job, work=str(tmp_path / "work"), runner=runner)
    ctx.stems.raw["instrumental"] = raw_inst
    if vocals:
        ctx.stems.raw["vocals"] = raw_vox
    ctx.stems.vocals_silent = silent
    return ctx


async def _run(step: PublishStems, ctx: Ctx) -> None:
    async for _ in step.run(ctx):
        pass


async def test_encoding_and_publishing_are_one_atom(tmp_path) -> None:
    """A mix argv was issued AND the ref was published — neither without the other."""
    runner = FakeRunner()
    ctx = _ctx(tmp_path, runner, vocals=True)
    await _run(PublishStems(), ctx)

    mix = guide_mix_path(str(tmp_path), "m1")
    assert ctx.out.artifacts["stems"]["guideMix"] == mix
    # The KEY is what the core reads; a typo here is invisible on both sides of the wire.
    assert "guideMix" in ctx.out.artifacts["stems"]
    # And the encode really ran, to a TEMP path that was then renamed onto the published one.
    mix_calls = runner.argv_for("-guidemix.")
    assert len(mix_calls) == 1
    assert mix_calls[0][-1].endswith(".tmp"), "the mix must be encoded to a temp sibling, not in place"
    assert os.path.exists(mix)


async def test_no_temp_file_is_left_behind(tmp_path) -> None:
    """An orphan temp would sit in derived/ and be counted against the retention cap forever."""
    runner = FakeRunner()
    ctx = _ctx(tmp_path, runner, vocals=True)
    await _run(PublishStems(), ctx)
    stems_dir = os.path.dirname(guide_mix_path(str(tmp_path), "m1"))
    assert [f for f in os.listdir(stems_dir) if f.endswith(".tmp")] == []


async def test_a_failed_mix_encode_publishes_no_ref_and_leaves_no_file(tmp_path) -> None:
    """The published path must never hold a partial file, and no ref may point at one.

    This is the durability half: ffmpeg finalises its output on SIGTERM, so a killed encode leaves a valid
    but SHORT file. Written in place it is indistinguishable from a good mix, and the core's backfill adopts
    anything that exists — pinning the room to a mix that truncates the song, permanently.
    """
    runner = FakeRunner(fail_on="-guidemix.")
    ctx = _ctx(tmp_path, runner, vocals=True)
    await _run(PublishStems(), ctx)

    assert "guideMix" not in ctx.out.artifacts["stems"]
    assert not os.path.exists(guide_mix_path(str(tmp_path), "m1"))
    stems_dir = os.path.dirname(guide_mix_path(str(tmp_path), "m1"))
    assert [f for f in os.listdir(stems_dir) if f.endswith(".tmp")] == []


async def test_a_failed_mix_encode_still_publishes_the_instrumental(tmp_path) -> None:
    """BEST-EFFORT, as the docstring promises: the load-bearing instrumental must survive."""
    runner = FakeRunner(fail_on="-guidemix.")
    ctx = _ctx(tmp_path, runner, vocals=True)
    await _run(PublishStems(), ctx)
    assert ctx.out.artifacts["stems"]["instrumental"] == instrumental_path(str(tmp_path), "m1")
    assert ctx.out.artifacts["stems"]["vocals"] == vocals_path(str(tmp_path), "m1")


@pytest.mark.parametrize(
    ("vocals", "silent"),
    [(False, False), (True, True)],
    ids=["no-vocals-stem", "silent-vocals-stem"],
)
async def test_no_mix_without_a_publishable_vocals_stem(tmp_path, vocals: bool, silent: bool) -> None:
    """A mix of the instrumental alone is just the instrumental, and advertising one is a lie.

    A silent vocals stem is the case the silence refusal above exists for: publishing a mix there would
    offer a guiding track that carries nothing, which reads as working.
    """
    runner = FakeRunner()
    ctx = _ctx(tmp_path, runner, vocals=vocals, silent=silent)
    await _run(PublishStems(), ctx)
    assert "guideMix" not in ctx.out.artifacts["stems"]
    assert runner.argv_for("-guidemix.") == []
    assert not os.path.exists(guide_mix_path(str(tmp_path), "m1"))


async def test_a_length_mismatch_skips_the_mix_rather_than_truncating_the_song(tmp_path) -> None:
    """`join` truncates to the shorter input and exits 0 — and the mix is the MASTER, so it owns duration.

    Measured against real ffmpeg: a 3 s instrumental against a 1 s vocals stem produces a 1 s output with
    exit 0. Channels 0/1 are the instrumental the TV plays, so the room would hear the song cut off early
    with nothing in any log. Not reachable with today's engines, which is exactly why it needs a guard
    rather than a comment: nothing else would notice if that stopped being true.
    """
    runner = FakeRunner()
    ctx = _ctx(tmp_path, runner, vocals=True, vox_frames=2205)
    await _run(PublishStems(), ctx)
    assert "guideMix" not in ctx.out.artifacts["stems"]
    assert runner.argv_for("-guidemix.") == []
    # The instrumental and the vocals stem are still published — only the mix is refused.
    assert ctx.out.artifacts["stems"]["instrumental"] == instrumental_path(str(tmp_path), "m1")
    assert ctx.out.artifacts["stems"]["vocals"] == vocals_path(str(tmp_path), "m1")


async def test_a_guide_mix_is_built_without_any_alignment_gate(tmp_path) -> None:
    """A guide mix is built whenever both stems are publishable — no alignment gate. The stems are
    sample-aligned by construction (one separation pass, one decoded input, one rate), and the TV
    carries the guide inside the master as channels 2/3, so a song with no mix offers NO guide at all —
    refusing on a measured offset would withhold the only guide mechanism there is.
    """
    runner = FakeRunner()
    ctx = _ctx(tmp_path, runner, vocals=True)
    await _run(PublishStems(), ctx)
    assert ctx.out.artifacts["stems"]["guideMix"] == guide_mix_path(str(tmp_path), "m1")
    assert runner.argv_for("-guidemix.") != [], "no guide-mix encode ran"
    # The measurement is gone from the wire too: nothing measures an offset, so nothing reports one.
    assert "guideOffsetMs" not in ctx.out.artifacts


async def test_ENCORE_GUIDE_MIX_0_turns_the_extra_encode_off(tmp_path) -> None:
    """The disk-cost escape hatch: off means every song takes the pre-feature two-element path."""
    runner = FakeRunner()
    ctx = _ctx(tmp_path, runner, vocals=True)
    await _run(PublishStems(guide_mix=False), ctx)
    assert "guideMix" not in ctx.out.artifacts["stems"]
    assert runner.argv_for("-guidemix.") == []
    assert ctx.out.artifacts["stems"]["instrumental"] == instrumental_path(str(tmp_path), "m1")
