"""Word ENDS, held through the singing as a DISPLAY post-pass. Starts never move (XA-01).

CTC is peaky, so every end is merely the model's last confident frame and a phrase-final word goes dark while
it is still being held. Each end is walked forward while the target's activity envelope still calls it
singing, and never shrunk. PURE: the envelope is measured by the step and handed over as a plain sequence.
The four bounds, and why this is not the energy-snap this repo rejected: `docs/arch/04-alignment.md` §10;
README, "Word ends, held through the singing" and "Word ends: the full corpus table".
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

from encore_worker.domain.lyrics.generate import Generated, Line, Word

#: Envelope level at or above which a frame still counts as SUNG: a fraction of the TARGET's own loud level,
#: portable across masters and meaningless on a mix. The same level the never-sung rule calls silence, but NOT
#: the same calibration — that one reads a whole span's mean where this tests one frame.
ACTIVE_LEVEL = 0.1

#: Seconds an end may MOVE — not the most a word may last — whatever the envelope says, binding only where a
#: decode dropped a line or a singer holds a note over an outro. On the DELTA, so a word already held may come
#: out longer and read as SMEARED, which is telemetry.
MAX_EXTENSION_SEC = 3.0

#: A fraction of one frame, used to floor a time onto the grid it came from: `(k * hop) / hop` undershoots `k`
#: for 4.9% of k, so a bare floor lands a frame early. Nine orders either side of what matters.
_GRID_TOLERANCE = 1e-9


def extend_ends(
    generated: Generated,
    env: Sequence[float],
    hop: float,
    theta: float = ACTIVE_LEVEL,
    *,
    tile: bool = False,
) -> Generated:
    """`generated` with every word's END walked forward through the singing. Starts never move (XA-01).

    `env` is a VOCALS STEM's activity envelope at one level per `hop` seconds, `hop` being the grid the onsets
    sit on. Each end is bounded by the active frames, the next SUNG word's start in DOCUMENT order and
    `MAX_EXTENSION_SEC`, and never shrunk. `tile` is the `ends-tile` arm, which is not free — the TV splits a
    long line at a word gap. The last syllable of a word that moved is stretched with it, so the nesting
    invariant survives by construction (XA-09; docs/arch/04-alignment.md §10).
    """
    flat = [(position, word) for position, line in enumerate(generated.lines) for word in line.words]
    if not flat:
        return generated
    ends: list[float] = []
    for index, (position, word) in enumerate(flat):
        ahead = _next_sung(flat, index + 1)
        cap = word.end + MAX_EXTENSION_SEC
        if ahead is not None:
            cap = min(cap, ahead[1].start)
        if word.end <= word.start:
            ends.append(word.end)  # a placeholder is never held (see `_next_sung`)
            continue
        reach = (
            cap
            if tile and ahead is not None and ahead[0] == position
            else _through_the_singing(word.end, cap, env, hop, theta)
        )
        ends.append(max(word.end, reach))
    lines: list[Line] = []
    cursor = 0
    for line in generated.lines:
        held = tuple(
            _held(word, end)
            for word, end in zip(line.words, ends[cursor : cursor + len(line.words)], strict=True)
        )
        cursor += len(line.words)
        lines.append(
            line if not held else replace(line, words=held, end=max(line.end, *(w.end for w in held)))
        )
    return replace(generated, lines=tuple(lines))


def _next_sung(flat: Sequence[tuple[int, Word]], start: int) -> tuple[int, Word] | None:
    """The next word from `start` that HAS a span, or None — the word whose start caps an extension.

    ZERO-WIDTH WORDS ARE SKIPPED: read as a cap, an interpolated out-of-vocabulary token pinned the real last
    word at its own end and absorbed the whole hold. Reaching past one cannot light the wrong word, a
    zero-width span containing no position at all.
    """
    for index in range(start, len(flat)):
        if flat[index][1].end > flat[index][1].start:
            return flat[index]
    return None


def _through_the_singing(end: float, cap: float, env: Sequence[float], hop: float, theta: float) -> float:
    """The first instant at or after `end` where the envelope stops being active, capped at `cap`.

    A frame counts only if it fits WHOLLY before the cap, so the walk cannot step over the next onset.
    FLOORED WITH A TOLERANCE rather than a bare `int`, every decoded end being an integer multiple of `hop`
    and the bare floor landing one frame early; not `round`, which would test a frame a NON-grid end does not
    sit in. A walk that consumed NO frame returns `end` ITSELF, so "nothing was extended" is statable.
    """
    if hop <= 0 or len(env) == 0:
        return end
    first = frame = max(0, int(end / hop + _GRID_TOLERANCE))
    while frame < len(env) and (frame + 1) * hop <= cap and env[frame] >= theta:
        frame += 1
    return end if frame == first else min(frame * hop, cap)


def _held(word: Word, end: float) -> Word:
    """`word` ending at `end`, with its last syllable stretched to match. Identity when nothing moved."""
    if end <= word.end:
        return word
    syllables = word.syllables
    if syllables:
        syllables = (*syllables[:-1], replace(syllables[-1], end=max(syllables[-1].end, end)))
    return replace(word, end=end, syllables=syllables)
