"""Line voices: which lines share a singer, from one embedding per line (#1166). Pure, so no model here."""

from __future__ import annotations

import numpy as np

from encore_worker.domain.lyrics import attribute, voices


def _voice(seed: int, n: int, spread: float = 0.05) -> list[np.ndarray]:
    rng = np.random.default_rng(seed)
    centre = rng.normal(size=64)
    return [centre + spread * rng.normal(size=64) * np.linalg.norm(centre) for _ in range(n)]


def test_one_singer_is_one_voice() -> None:
    assert set(voices.cluster(_voice(1, 12))) == {0}


def test_two_singers_are_two_voices_numbered_by_first_appearance() -> None:
    a, b = _voice(1, 6), _voice(2, 6)
    labels = voices.cluster([b[0], a[0], b[1], a[1], *a[2:], *b[2:]])
    assert labels[:4] == [0, 1, 0, 1] and set(labels) == {0, 1}


def test_three_singers_are_three_voices_never_more() -> None:
    lines = [*_voice(1, 5), *_voice(2, 5), *_voice(3, 5)]
    assert len(set(voices.cluster(lines))) == 3


def test_a_voice_with_too_few_lines_is_dropped_rather_than_invented() -> None:
    spans = [(float(i), float(i) + 1) for i in range(10)]
    labels: list[int | None] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
    turns = voices.line_turns(spans, labels)
    assert attribute.speaker_count(turns) == 1 and len(turns) == 9


def test_an_unjudged_line_gets_no_turn() -> None:
    turns = voices.line_turns([(0.0, 1.0), (1.0, 2.0)], [0, None])
    assert [t["start"] for t in turns] == [0.0]


def test_nothing_in_nothing_out() -> None:
    assert voices.cluster([]) == [] and voices.line_turns([], []) == []
