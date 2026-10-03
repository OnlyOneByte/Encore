"""The repair ladder's output invariant: a published document never runs backwards (XA-08).

Seeded random scenarios go through the REAL `time_text` — the never-sung drop, R3/R4/R1/R2, adoption,
`_clamped`, the gate and the grading — and the published document must satisfy what the TV and
`policy.decide` both rely on: `measure`'s `out_of_order == 0`, no word starting before the one ahead of it,
every word inside its line. A backwards start makes the highlight jump and `decide` reads it as incoherent
timing. The property runs PER SEED so one violation names its seed, and every test runs on BOTH arms: the
default, whose 4 known-inverting seeds keep `xfail(strict=True)`, and `m2-order-clamp`, which passes all 32.

The scenarios, the four pre-W1 violations, what the arm costs and the mutation that justifies the per-seed
shape are in docs/benchmarks/forced-alignment/README.md, "The repair-order property test, seed by seed".
"""

from __future__ import annotations

import asyncio
import json
import math
import random
import re
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from encore_worker.domain.lyrics import measure
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.host.config import Config
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import AudioRef, JobRef, TextRef, TimedDoc, TimeRequest
from tests.ctc_fixture import FRAME_SEC, ctc_viterbi, sung_matrix

RATE = 16000
DIC = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz'")}
WORDS = (
    "love night fire run home stay light dance rain sky hold on baby tonight heart gold we are the young "
    "oh yeah down river shine"
).split()

#: The seeds. 32 scenarios take about 5 s through the real `time_text`, including one ffmpeg read each.
SEEDS = range(32)

#: The seeds that published backwards word starts before W1 — review M2's three shapes (see above). The
#: default clamp still does; the `m2-order-clamp` arm does not.
FORMERLY_M2 = (2, 6, 12, 30)

#: The two clamps every test here runs on: the shipped default and review M2's arm.
ARMS: Mapping[str, Config] = {
    "default": Config(),
    "m2-order-clamp": Config(align_experiments=frozenset({"m2-order-clamp"})),
}
KINDS = ("claims", "stem-gap", "claims", "untimed")

Phrase = tuple[str, float, float]


@dataclass(frozen=True)
class Scenario:
    seed: int
    kind: str
    #: What is sung, and where.
    truth: tuple[Phrase, ...]
    #: What the sheet claims: the truth plus 50 ms jitter, with one line or a run of two misclaimed.
    claims: tuple[Phrase, ...]
    duration_sec: float
    #: The line the vocals stem lost (`stem-gap`): silent there, still sung in the mix.
    lost: int | None


def scenario(seed: int) -> Scenario:
    rng = random.Random(seed)
    kind = KINDS[seed % len(KINDS)]
    count = rng.randint(6, 10)
    texts: list[str] = []
    for _ in range(count):
        if texts and rng.random() < 0.3:
            texts.append(rng.choice(texts))
        else:
            texts.append(" ".join(rng.choice(WORDS) for _ in range(rng.randint(2, 5))))
    clock = rng.uniform(1.0, 3.0)
    truth: list[Phrase] = []
    for text in texts:
        length = rng.uniform(0.8, 2.5)
        truth.append((text, clock, clock + length))
        clock += length + rng.uniform(0.05, 1.2)
    first = rng.randrange(count)
    wrong = set(range(first, min(count, first + rng.choice((1, 1, 2)))))
    claims: list[Phrase] = []
    for index, (text, start, end) in enumerate(truth):
        shift = rng.gauss(0.0, 0.05)
        if kind != "stem-gap" and index in wrong:
            shift += rng.choice((-1.0, 1.0)) * rng.uniform(0.8, 3.0)
        claims.append((text, max(0.0, start + shift), max(0.0, end + shift)))
    lost = rng.randrange(1, count - 1) if kind == "stem-gap" else None
    return Scenario(seed, kind, tuple(truth), tuple(claims), clock + 2.0, lost)


def sung(path: Path, phrases: Sequence[Phrase], duration_sec: float, seed: int) -> str:
    """A tone wherever a phrase is sung, faint noise elsewhere: what the envelope gate reads."""
    signal = np.random.default_rng(seed).normal(0.0, 0.002, int(duration_sec * RATE))
    for _text, start, end in phrases:
        t = np.arange(int((end - start) * RATE)) / RATE
        first = int(start * RATE)
        signal[first : first + len(t)] += 0.3 * np.sin(2 * math.pi * 220.0 * t)
    sf.write(path, signal, RATE)
    return str(path)


@dataclass(frozen=True)
class Emitted:
    log_probs: Any
    frame_sec: float
    dictionary: dict[str, int]

    @property
    def frames(self) -> int:
        return len(self.log_probs)


class HearingAligner:
    """Emissions per file: each audio path hears exactly the phrases sung on it."""

    def __init__(self, heard: Mapping[str, Any]) -> None:
        self._heard = heard

    def emissions(self, path: str, _language: str) -> Emitted:
        return Emitted(log_probs=self._heard[path], frame_sec=FRAME_SEC, dictionary=DIC)

    def align(self, *_a: object, **_k: object) -> tuple[()]:
        raise AssertionError("the global path must not fall back to the windowed aligner")


class Trail:
    def __init__(self) -> None:
        self.states: list[tuple[Any, ...]] = []

    async def state(self, *args: Any) -> None:
        self.states.append(args)

    async def progress(self, *_a: Any) -> None: ...

    async def confirm_ownership(self, *_a: object, **_k: object) -> bool:
        return True

    def explain_ownership(self, *_a: object) -> str:
        return ""


@dataclass(frozen=True)
class Published:
    scenario: Scenario
    #: The written document, or None when `time_text` published nothing.
    doc: dict[str, Any] | None
    why: str


def publish(case: Scenario, media: Path, config: Config) -> Published:
    """One scenario through the shipped `time_text`, on its own stem and mix, under `config`."""
    media.mkdir(parents=True, exist_ok=True)
    mix = sung(media / "mix.wav", case.truth, case.duration_sec, case.seed)
    on_stem = [p for i, p in enumerate(case.truth) if i != case.lost]
    stem = sung(media / "vocals.wav", on_stem, case.duration_sec, case.seed + 1)
    aligner = HearingAligner(
        {
            stem: sung_matrix(on_stem, DIC, case.duration_sec),
            mix: sung_matrix(case.truth, DIC, case.duration_sec),
        }
    )
    trail = Trail()
    impl = AlignStepsImpl(config=config, adapters=Adapters(aligner=aligner), reporter=trail)
    timed = case.kind != "untimed"
    text = TextRef(
        tier=Tier.CANDIDATE,
        label="sheet",
        segments=tuple({"text": t, **({"start": s, "end": e} if timed else {})} for t, s, e in case.claims),
        timing="line" if timed else None,
    )
    job = JobRef(job_id=f"s{case.seed}", media_id=f"s{case.seed}", media_dir=str(media), source_uri=None)
    audio = AudioRef(path=mix, vocals_path=stem, duration_sec=case.duration_sec)
    out = asyncio.run(impl.time_text(TimeRequest(job=job, text=text, audio=audio, language="en")))
    notes = [s for s in trail.states if s[1] == "align-global"]
    why = f"{notes[-1][3]}: {notes[-1][4]}" if notes else "(no note)"
    if not isinstance(out, TimedDoc) or out.timing != "word":
        return Published(case, None, why)
    doc: dict[str, Any] = json.loads((media / out.ref).read_text(encoding="utf-8"))
    return Published(case, doc, why)


@pytest.fixture(scope="module")
def runs(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Callable[[str], list[Published]]]:
    """Every scenario under an arm, run ONCE per arm for the module: every test reads the same documents."""
    from encore_worker.adapters import ml

    root = tmp_path_factory.mktemp("repair-order")
    done: dict[str, list[Published]] = {}

    def of(arm: str) -> list[Published]:
        if arm not in done:
            done[arm] = [publish(scenario(seed), root / arm / f"s{seed}", ARMS[arm]) for seed in SEEDS]
        return done[arm]

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(ml, "forced_align_decoder", ctc_viterbi)
        yield of


def backwards(doc: Mapping[str, Any]) -> list[str]:
    """Each word start that precedes the one before it, as `measure` counts `out_of_order`."""
    words = measure.timed_words(doc)
    return [
        f"{b[0]!r}@{b[1]:.3f} after {a[0]!r}@{a[1]:.3f}"
        for a, b in zip(words, words[1:], strict=False)
        if b[1] < a[1]
    ]


def outside(doc: Mapping[str, Any]) -> list[str]:
    """Each word whose span leaves its line's."""
    return [
        f"{word['word']!r} [{word['start']:.3f}, {word['end']:.3f}] "
        f"in line [{line['start']:.3f}, {line['end']:.3f}]"
        for line in doc["lines"]
        for word in line["words"]
        if not line["start"] - 1e-9 <= word["start"] <= word["end"] <= line["end"] + 1e-9
    ]


@pytest.mark.parametrize("arm", ARMS)
def test_every_repair_scenario_publishes_a_word_timed_document(
    runs: Callable[[str], list[Published]], arm: str
) -> None:
    """So the property below cannot be met by refusing. Every scenario has the right text on audio
    that sings it; a refusal here is a regression in its own right."""
    published = runs(arm)
    refused = [f"seed {p.scenario.seed} ({p.scenario.kind}): {p.why}" for p in published if p.doc is None]
    assert not refused, "\n".join(refused)
    assert {p.scenario.kind for p in published} == set(KINDS)


@pytest.mark.parametrize("arm", ARMS)
def test_this_test_reads_out_of_order_exactly_as_measure_counts_it(
    runs: Callable[[str], list[Published]], arm: str
) -> None:
    """`backwards` is this file's reading of `measure`'s `out_of_order`; if the two drift, the property
    below measures something `policy.decide` does not act on. On the default arm, the 4 inverted seeds
    are where it has something to count."""
    drifted = []
    for p in runs(arm):
        if p.doc is None:
            continue
        report = measure.measure(p.doc, duration_sec=p.scenario.duration_sec)
        if report.out_of_order != len(backwards(p.doc)):
            drifted.append(
                f"seed {p.scenario.seed}: measure {report.out_of_order}, here {len(backwards(p.doc))}"
            )
    assert not drifted, "\n".join(drifted)


#: (arm, seed) for the property: the default's M2 seeds are STRICT xfails, so a default that stops
#: inverting them (or an arm that starts) is a red test, not a silent pass.
PROPERTY = [
    pytest.param(
        arm,
        seed,
        marks=pytest.mark.xfail(strict=True, reason="review M2: the default clamp squeezes, not refuses"),
    )
    if arm == "default" and seed in FORMERLY_M2
    else pytest.param(arm, seed)
    for arm in ARMS
    for seed in SEEDS
]


@pytest.mark.parametrize(("arm", "seed"), PROPERTY)
def test_repairs_never_publish_backwards_word_starts_or_words_outside_their_line(
    runs: Callable[[str], list[Published]], arm: str, seed: int
) -> None:
    p = runs(arm)[seed]
    assert p.scenario.seed == seed
    tag = f"{arm} seed {seed} ({p.scenario.kind})"
    assert p.doc is not None, f"{tag}: published nothing ({p.why})"
    failures = [f"{tag} backwards: {w}" for w in backwards(p.doc)]
    failures += [f"{tag} outside: {w}" for w in outside(p.doc)]
    assert not failures, f"{len(failures)} violation(s):\n" + "\n".join(failures)


@pytest.mark.parametrize("seed", FORMERLY_M2)
def test_a_repair_that_cannot_keep_order_goes_back_to_the_blind_decode(
    runs: Callable[[str], list[Published]], seed: int
) -> None:
    """What M2's fix does instead of squeezing: the run's BLIND lines, named on the trail, graded low.

    The blind decode here is exact (tones at the true spans), so a refused line must sit where it is
    sung. A fix that dropped the line, squeezed it into the gap, or kept the misclaimed timing in order
    would each fail this, and so would one that refused silently or still graded the line on the
    corroboration its refused repair earned. The `m2-order-clamp` arm's behaviour."""
    p = runs("m2-order-clamp")[seed]
    assert p.doc is not None, f"seed {seed}: published nothing ({p.why})"
    named = re.search(r"kept the blind decode for \d+ repaired lines[^:]*: ((?:\[\d+\](?:, )?)+)", p.why)
    assert named, f"seed {seed}: no refusal on the trail ({p.why})"
    refused = [int(i) for i in re.findall(r"\[(\d+)\]", named.group(1))]
    lines = p.doc["lines"]
    assert len(lines) == len(p.scenario.truth), "every line alignable: positions are input indexes"
    for index in refused:
        line, (_text, sung_at, _end) = lines[index], p.scenario.truth[index]
        assert abs(line["start"] - sung_at) < 0.1, (
            f"seed {seed} [{index}] at {line['start']:.2f}, sung {sung_at:.2f}"
        )
        assert line["confidence"] == "low", f"seed {seed} [{index}]: a refused repair is graded low"
    # Every adoption in these 4 scenarios sat in a refused run, so none may still be counted.
    assert "adopted" not in p.why, f"seed {seed}: a refused adoption is still counted ({p.why})"


def test_the_arm_changes_only_refusals_and_the_default_only_neighbour_ends(
    runs: Callable[[str], list[Published]],
) -> None:
    """The knob's difference is its REFUSALS plus the one thing the default does that the arm does not.

    W1 could say "byte for byte": the arm and the default agreed wherever no run was refused. W6 gave the
    DEFAULT a bounded left floor — where the line before a repair ends past its start, that neighbour's END
    comes back to the repair (`_clamped_v2`, `_pulled_end`) — while the arm keeps refusing instead. So on a
    seed the arm refused nothing, every line's TEXT, START, grade and word STARTS are still the default's,
    and the only cells that may differ are neighbour `end`s the default pulled IN: strictly earlier, landing
    on the following line's start. Nothing here is scored on a line's end."""
    default, arm = runs("default"), runs("m2-order-clamp")
    refusing = [p.scenario.seed for p in arm if "kept the blind decode" in p.why]
    assert set(FORMERLY_M2) <= set(refusing)
    seams: list[tuple[int, int]] = []
    for d, a in zip(default, arm, strict=True):
        if a.scenario.seed in refusing:
            assert a.doc != d.doc, f"seed {a.scenario.seed}: a refusal on the trail, the default's document"
            continue
        assert a.doc is not None and d.doc is not None
        tag = f"seed {a.scenario.seed}"
        pushed, pulled = a.doc["lines"], d.doc["lines"]
        assert len(pushed) == len(pulled), tag
        for position, (theirs, ours) in enumerate(zip(pushed, pulled, strict=True)):
            where = f"{tag} [{position}]"
            assert (theirs["text"], theirs["confidence"]) == (ours["text"], ours["confidence"]), where
            # A pull can only bring a span IN: the neighbour's end onto the repair, and the repair's own
            # start back off that end. `high` is monotone in `low`, so neither side may run LATER.
            assert ours["start"] <= theirs["start"] + 1e-9, f"{where}: the default starts later"
            assert ours["end"] <= theirs["end"] + 1e-9, f"{where}: the default ends later"
            if (ours["start"], ours["end"]) == (theirs["start"], theirs["end"]):
                assert ours["words"] == theirs["words"], f"{where}: words moved inside an unmoved span"
                continue
            seams.append((a.scenario.seed, position))
            if ours["end"] < theirs["end"] and position + 1 < len(pulled):
                assert ours["end"] == pytest.approx(pulled[position + 1]["start"]), (
                    f"{where}: an end moved without landing on the following line's start"
                )
    assert seams, "no seed exercises W6's pull, so this test proves nothing about it"
