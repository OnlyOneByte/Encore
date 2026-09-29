"""Word ENDS, held through the singing as a DISPLAY post-pass. Starts never move.

WHY THIS EXISTS (review §3 item 5; W4). CTC is peaky. 90.9% of 21,921 measured char spans are exactly ONE
frame, so what the decode carries is an ordered set of ONSETS on the frame grid and every END is merely the
model's last confident frame (`generate`'s docstring says the same). The TV acts on those ends: a word is
lit while `start <= pos < end` (`core/src/lib/tv/lyrics.ts`, `activeWordIndex`) and is struck through at
`end` (`tv/LyricsOverlay.svelte`, `done: cuePos >= w.end`). So a phrase-final word goes dark while it is
still being held, and the room sees the ball leave a word that is still sounding.

MEASURED, on the 20 JamendoLyrics songs with hand-measured word onsets AND offsets:

    phrase-final word ends     median 107 ms EARLY, only 40.0% within ±100 ms, 73.5% within ±250 ms
    the correct word is lit    67.7% of sung time (TV semantics, review §3.5)

Both on the review's clock. On W4's exact 20 ms grid they read WORSE, and honestly so: the old grid's
`duration / frames` came out 0.020014 s, a 0.07% stretch that pushed every end later and masked the
peakiness. `--level generate --modes blind --songs jamendo` on the exact clock: word end ±100 73.2 -> 68.7,
phrase-final ±100 40.6 -> 36.3, phrase-final bias -106 -> -121 ms, highlight 67.3% -> 66.0%. This module's
reject-if gates are read against THAT column (`ONSET_LEAD_SEC`, and the README's clock section).

WHAT IT DOES. Each word's end is walked forward while the target's activity envelope is still at or above
`theta`, and stopped at the NEXT word's start (the decode's own next onset) or `MAX_EXTENSION_SEC`,
whichever comes first. Never shrunk: a cap that already sits behind the end leaves the end where it was.

WHY THIS IS NOT THE REJECTED ENERGY-SNAP (docs/benchmarks/forced-alignment/README.md, "Onset-snap
prototype"). That prototype moved ONSETS to the nearest energy rise within ±0.35 s and measured a NET LOSS
— tfr-flyaway's lines within ±250 ms 77.3% -> 70.7% — because a snap jumps to a NEIGHBOURING onset, and the
word it jumped over is then wrong by a whole word. Nothing here reads an energy rise, searches in both
directions, or touches a start:

  * ONE-SIDED. Only ends move, and only forward. Every onset — the thing the ball follows and the thing
    every accuracy metric in this repo scores — is bit-for-bit the decode's. A test asserts it end to end,
    not just the bench (`tests/test_ends.py`, `tests/test_align_ends.py`).
  * BOUNDED BY THE DECODE ITSELF. The cap is the next word's own start, so an over-extension can at worst
    fill a gap the decode left empty; it can never reach into the next word's span, and the worst case is
    a word lit for a silence rather than a wrong word lit.
  * BOUNDED IN SIZE. `MAX_EXTENSION_SEC` keeps a decode that dropped a whole phrase from lighting one word
    across an instrumental break.
  * BOUNDED BY THE AUDIO. The walk stops at the last envelope frame, so an extension cannot run past the
    signal the envelope was measured on and cannot manufacture `TimingReport.overshoot_sec`.

EXPECTED (review, base model, theta = 0.1, its own clock): phrase-final end ±100 40.0 -> 57.3, ±250
73.5 -> 82.5, phrase-final bias -107 -> -10 ms, highlight 67.7 -> 78.2. A SwiftF0 voicing signal instead of
the RMS envelope read 67.3 -> 76.6, i.e. no better than the envelope already in hand, which is why no new
model is loaded here. Adding within-line gapless tiling reached 78.8 (82.7 with HuBERT-XL) — that is the
`ends-tile` arm below, not the default.

MEASURED HERE, on the shipped path and the exact clock, but on THREE Jamendo songs rather than twenty
(Color_Out, HILA, Wordsmith; `e2e.py --level time_text --modes blind`; 1127 words, 1046 ends, 116
phrase-final ends, 407 s sung; `_runs/w4-ends-{raw,held,tile}`). The corpus run is the wave's bench
agent's, and these are the rows it should expect:

    metric                    ends-raw     default     ends-tile
    word end ±100               75.9         79.0        75.0
    word end ±250               94.2         94.7        93.1
    word end bias              -34 ms       +10 ms      +25 ms
    phrase-final end ±100       34.5         50.9        50.9
    phrase-final end ±250       66.4         72.4        72.4
    phrase-final end bias     -115 ms       -16 ms      -16 ms
    HIGHLIGHT                   66.2%        79.1%       80.6%
    onsets ±100/±250/±300     80.1 / 92.8 / 94.1, bias +9 ms, 12 words > 2 s out, 5 gross lines — in all
                              three columns, and the harness's own `onsets_sha256` is byte-identical

So the direction and the size both reproduce (+16.4 pts phrase-final ±100, +12.9 highlight, bias -115 ->
-16 ms, every per-song highlight up: worst +9.5, best +17.9), and nothing on the onset side moves at all.
THE TILE ARM TRADES: +1.5 pts of highlight for -4.0 on word-end ±100 and -1.6 at ±250, with phrase-final
ends untouched (it only moves INTERIOR words). Which is evidence against the review's "80% of interior
truth ends are just the next word's start" being the whole story — where that held, tiling could only have
helped. The full corpus decides.

REJECT IF (review §3.5, rebased onto the W4 clock): the highlight gains less than 5 points; phrase-final
end ±100 gains less than 10; word-end ±100 gets WORSE on more than 3 of the 20 Jamendo songs; or ANY onset
moves. The last one is a test, not a bench row. The corpus pair is measured at `--level time_text` with
`ENCORE_ALIGN_EXPERIMENTS=ends-raw` as the control and nothing set as the default: `--level generate` is the
raw decode ALONE by definition, so this post-pass does not run there and the clock's 68.7 / 36.3 / 66.0
column is not the column to hold this to.

WHAT THE REVIEW'S END NUMBERS CANNOT SAY. 80% of Jamendo's non-final word ends (4825 words) are recorded as
exactly the next word's start, so a gain on INTERIOR ends is partly the truth set's construction. Only
phrase-final ends are independently measured, and the highlight — which reads the whole document through
the TV's own rule — is the metric that cannot be gamed that way.

PURE (`domain/` rule): floats, a sequence of envelope levels, and comparisons. The envelope is measured by
the step, which owns the numpy (`domain.audio.activity.envelope`), and handed over as a plain sequence —
the same seam `claimmap` uses for its audio-side candidate.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

from encore_worker.domain.lyrics.generate import Generated, Line, Word

#: Envelope level at or above which a frame still counts as SUNG, so an end may cross it.
#:
#: 0.1 of the track's own loud level (`activity.envelope` normalises against its 95th percentile, so this
#: is level-independent, and `_LOUD_PERCENTILE` is why one clipped frame cannot scale it away). It is the
#: level the review reports its numbers at, and the same level this repo's never-sung rule already calls
#: silence (`align_steps._NEVER_SUNG_ENV` = 0.10) — the property that matters here is exactly that: a word
#: may be held through anything that rule would not call silent, and no further.
ACTIVE_LEVEL = 0.1

#: The most an end may MOVE (not the most a word may last), whatever the envelope says.
#:
#: The review's cap. It binds only where a decode has dropped a line or a singer holds one note over an
#: outro; the next word's start binds everywhere else, and on the corpus slice measured above the median
#: move is tens of milliseconds. It is the same 3 s as `report.MAX_WORD_SEC` by coincidence of scale, NOT
#: by construction — the cap is on the delta, so a word already held 1 s may come out at 4 s, which
#: `measure` then counts as SMEARED. That is telemetry and never a decision (`policy._READS` offers the
#: global engine no knob that answers a smear), but it does reach the operator through
#: `TimingReport.summary`, where "1 smeared (worst 'oh' 3.4s)" on a held note is now an honest reading of
#: the display rather than a defect in the decode.
MAX_EXTENSION_SEC = 3.0


def extend_ends(
    generated: Generated,
    env: Sequence[float],
    hop: float,
    theta: float = ACTIVE_LEVEL,
    *,
    tile: bool = False,
) -> Generated:
    """`generated` with every word's END walked forward through the singing. Starts never move.

    `env` is the ALIGN TARGET's activity envelope (`activity.envelope`, one level per `hop` seconds) —
    the stem where the job separated one, else the mix. `theta` is the level at which the singing is
    judged to have stopped; `hop` is the envelope's frame, 20 ms, the same grid the onsets sit on since
    W4's exact clock, so an extended end quantises onto the decode's own grid.

    Each word's end is bounded by, in order: the frames the envelope still calls active, the NEXT word's
    start in document order, and `MAX_EXTENSION_SEC`. A word whose end already sits at or past its cap
    keeps it — this only ever moves an end LATER.

    `tile` is the `ends-tile` arm (`Config.align_experiments`): a word that is not the last of its line
    runs all the way to the next word's start whatever the envelope says, so a line's words TILE it
    gaplessly and only its final word is judged acoustically. The review measured 78.8% highlight that
    way against 78.2% for the envelope alone, but it is not free and that is why it is an arm rather than
    the default: the TV splits a line longer than 42 characters at word gaps of `LINE_GAP_SEC` = 0.45 s
    (`core/src/lib/tv/lyrics.ts`, `resegmentLine`), and a tiled line has no such gap left, so a long line
    that used to show as two rows at its pause now shows as one. The bench's highlight reads which word
    lights THROUGH that re-segmentation, so the metric already carries the part of this that moves a ball;
    what no number here can say is how the unsplit row reads in a room.

    DOCUMENT ORDER, not time order, is what "the next word" means: a misbound decode can publish a line
    whose words sit before the previous line's, and the cap then lands behind the end, which leaves that
    end alone. The alternative — sorting by time — would let a word be extended over a word the document
    shows LATER, which is the only way this could move a highlight onto the wrong word.

    Syllables: the last syllable of a word that moved is stretched with it, so a syllable-level ball ends
    where its word does; every other syllable, and every start, is untouched. The nesting invariant
    (`syllable <= word <= line`, all ordered) survives by construction, since only the outer bound of
    each level grows and no start moves.
    """
    flat = [(position, word) for position, line in enumerate(generated.lines) for word in line.words]
    if not flat:
        return generated
    ends: list[float] = []
    for index, (position, word) in enumerate(flat):
        ahead = flat[index + 1] if index + 1 < len(flat) else None
        cap = word.end + MAX_EXTENSION_SEC
        if ahead is not None:
            cap = min(cap, ahead[1].start)
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


def _through_the_singing(end: float, cap: float, env: Sequence[float], hop: float, theta: float) -> float:
    """The first instant at or after `end` where the envelope stops being active, capped at `cap`.

    A frame counts only if it fits WHOLLY before the cap, so the walk cannot step over the next onset to
    reach a frame that straddles it. The result is a frame boundary, the cap, or `end` itself; the caller
    keeps the larger of it and the word's own end, so a cap behind the end is a no-op, never a shrink.

    A walk that consumed NO frame returns `end` ITSELF rather than its frame's boundary, which is not
    cosmetic: `int(end / hop) * hop` differs from `end` in the last bits either way (1.4 / 0.02 is
    70.0 exactly, and 70 * 0.02 is 1.4000000000000001), so rounding to the grid would move every end in
    the document by a femtosecond and make "nothing was extended" impossible to state.
    """
    if hop <= 0 or len(env) == 0:
        return end
    first = frame = max(0, int(end / hop))
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
