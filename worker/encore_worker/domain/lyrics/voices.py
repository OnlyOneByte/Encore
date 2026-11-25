"""Which lines share a voice, from one speaker embedding per line. Pure numpy, so testable with no model.

Agglomerative clustering with average linkage on cosine distance, stopped at `SAME_VOICE_DISTANCE`: the
number of voices is whatever the lines say, never a number asked for, and a voice too small to trust is
dropped rather than kept as a guess. The turns this returns feed `attribute`, which still makes the
song-level call (docs/arch/04-alignment.md §11.1).
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from encore_worker.domain.document import Segment

#: Average cosine distance below which two groups of lines are one voice: the widest that made no solo a
#: duet on the bench's labelled set, where it coloured no duet either (LOG.md, "Voices: who sings which
#: line").
SAME_VOICE_DISTANCE = 0.35

#: The share of judged lines a voice must own to count. Below it a "voice" is a few odd lines of one singer
#: (a whisper, a shout), so those lines go unlabelled instead of inventing a singer.
MIN_VOICE_SHARE = 0.15


def cluster(embeddings: Sequence[np.ndarray], *, distance: float = SAME_VOICE_DISTANCE) -> list[int]:
    """One voice label per embedding, numbered by first appearance. Empty in, empty out."""
    if not embeddings:
        return []
    unit = np.stack([e / (np.linalg.norm(e) or 1.0) for e in embeddings])
    gaps = 1.0 - unit @ unit.T
    groups: list[list[int]] = [[i] for i in range(len(embeddings))]
    while len(groups) > 1:
        best, pair = distance, None
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                d = float(gaps[np.ix_(groups[a], groups[b])].mean())
                if d < best:
                    best, pair = d, (a, b)
        if pair is None:
            break
        a, b = pair
        groups[a] += groups.pop(b)
    order = sorted(groups, key=min)
    labels = [0] * len(embeddings)
    for label, members in enumerate(order):
        for i in members:
            labels[i] = label
    return labels


def line_turns(spans: Sequence[tuple[float, float]], labels: Sequence[int | None]) -> list[Segment]:
    """Speaker turns, one per labelled line, for `attribute`. A voice under `MIN_VOICE_SHARE` is dropped."""
    judged = [label for label in labels if label is not None]
    counts = {label: judged.count(label) for label in set(judged)}
    kept = {label for label, n in counts.items() if n >= MIN_VOICE_SHARE * len(judged)}
    return [
        {"start": start, "end": end, "speaker": f"V{label}"}
        for (start, end), label in zip(spans, labels, strict=True)
        if label is not None and label in kept
    ]
