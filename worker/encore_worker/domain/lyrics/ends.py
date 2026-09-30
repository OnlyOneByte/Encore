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

MEASURED HERE, on the shipped path and the exact clock, over the WHOLE 20-song Jamendo corpus at
`--level time_text` (`results/w4-time_text.json` against `results/w4-endsoff-time_text.json`, the
post-pass off; 5183 aligned words, 4870 scored ends, 702 phrase-final ends, 2433 s sung under `truth`).
This supersedes the 3-song sanity slice this paragraph used to carry (`_runs/w4-ends-{raw,held,tile}`,
Color_Out/HILA/Wordsmith), which read the same direction and a smaller size:

    metric                     off      on         off      on
                               ── truth claims ──   ── blind ──
    word end ±100             69.06    80.02       68.74    79.48
    word end ±250             93.06    94.97       92.79    94.64
    word end bias            -54.5 ms  -2.9 ms    -55.3 ms  -3.8 ms
    phrase-final end ±100     37.46    59.83       36.30    56.75
    phrase-final end ±250     73.79    83.05       72.74    81.78
    phrase-final end bias    -114 ms   -5.6 ms    -121 ms  -15.5 ms
    HIGHLIGHT                 65.83%   77.10%      65.92%   77.51%
                                       (CI 72.9-81.5)       (CI 72.8-81.8)
    onsets ±100/±300, AAE     83.25 / 94.98 / 87.8 ms and 80.11 / 91.58 / 297.9 ms — EQUAL TO THE DIGIT in
                              both columns, with all 20 songs' `onsets_sha256` byte-identical

So every reject-if clears on the corpus (`gates/w4-ends.yaml` 6/6): +22.4 pts of phrase-final ±100 and
+11.3 of highlight under truth claims, the phrase-final bias -114 -> -5.6 ms, EVERY song's highlight up
(worst +6.6 Tom_Orlando, best +15.8 Cortez) and 2 of 20 songs worse at word-end ±100 against the 3 the
review allows — Avercage -6.19 and Color_Out -1.28, both of which gain on the independently measured half
(their phrase-final ±100 goes +12.5 and +16.1). That is the shape §3.5's objection predicts: interior ends
and phrase-final ends can move in opposite directions on one song, and only the second is really measured.

THE REVIEW-ROUND FIXES BELOW MOVED THIS TABLE BY 0.2 ms, measured rather than assumed (`_GRID_TOLERANCE`, so
a walk starts on the frame the end actually sits in, and `_next_sung`, so a trailing OOV placeholder does not
cap the word before it: `_runs/w4r1b-time_text` over the same 20 songs). Truth end bias -3.0 -> -2.9 ms,
phrase-final bias -5.8 -> -5.6 — both folded into the table above, which is now the committed row to the
digit — and end ±100 / ±250 / phrase-final ±100 / ±250 / highlight EQUAL TO THE DIGIT
(80.02 / 94.97 / 59.83 / 83.05 / 77.10) — the two defects are real and rare, not a recalibration.

THE OFF-COLUMN IS THE DOCUMENTED ARM, NOT A CODE SHIM (W4 rebench round 2). The pair's off-column,
`results/w4-endsoff-time_text.json`, was re-recorded as `ENCORE_ALIGN_EXPERIMENTS=ends-raw` on the on-column's
SAME code (`meta.code 8c576cc6200b02a0` on both, which `e2e.py`'s fingerprint takes over every file of the
imported package), so the pair is one population and the reject-if below was read on a reproducible setup
rather than on an edited tree. The arm reproduced the shim it replaced to the digit, and the onset half is now
read off the rows rather than only off the gate: across the 40 paired song-modes of
`results/w4-{,endsoff-}time_text.cases.jsonl`, `onsets_sha256` is unchanged on 40 of 40 while `doc_sha256`
changes on 40 of 40 — review §3.5's "any onset moves" as an exact statement (`gates/w4-ends.yaml`).

THE TILE ARM TRADES, on the 3-song slice it was measured on (`_runs/w4-ends-tile`): +1.5 pts of highlight
(79.1 -> 80.6) for -4.0 on word-end ±100 (79.0 -> 75.0) and -1.6 at ±250, with phrase-final ends untouched
(it only moves INTERIOR words). Which is evidence against the review's "80% of interior truth ends are just
the next word's start" being the whole story — where that held, tiling could only have helped.

REJECT IF (review §3.5, rebased onto the W4 clock): the highlight gains less than 5 points; phrase-final
end ±100 gains less than 10; word-end ±100 gets WORSE on more than 3 of the 20 Jamendo songs; or ANY onset
moves. The last one is a test, not a bench row. The corpus pair is measured at `--level time_text` against
the same code with the post-pass off: `--level generate` is the raw decode ALONE by definition, so this
post-pass does not run there and the clock's 68.7 / 36.3 / 66.0 column is not the column to hold this to.

ON A VOCALS STEM ONLY, and that is `theta`'s doing rather than a preference (W4 review r1; the caller is
`align_steps._time_text_global`, which skips the whole post-pass when the align target is the MIX).
`ACTIVE_LEVEL` is a fraction of the TARGET's own 95th-percentile level, so on a stem it separates singing
from silence and on a full mix it separates almost nothing: measured with this repo's own
`activity.envelope` over four corpus songs, frames at or above 0.1 are 95.5 / 98.4 / 95.5 / 92.4% of the
MIX against 64.8 / 58.9 / 76.7 / 72.2% of the same songs' stems, and the longest CONTINUOUS active run is
152.8 / 183.8 / 70.1 / 37.6 s against 12.0 / 13.5 / 19.3 / 10.1 s. A walk with a stem's theta over a mix's
envelope therefore never stops: the post-pass would silently become the `ends-tile` arm inside each line
AND run every line's last word to the next line's onset (or +3 s at the document end) on every stemless
song and every `ALIGN_ON_MIX` retry — unmeasured, since all 20 corpus songs the table above is read on
have stems. A mix-calibrated theta is fittable (`e2e.py --no-stem`, twice) and is NOT fitted here; the
reject-if such a fit owes is written down in `gates/w4-stemless.yaml`'s header before anyone fits one, and the
skip's exhibit — the raw ends published AND the counterfactual walk run over the same mix's envelope — is
`tests/test_align_ends.py`'s stemless case, which needs no sweep.

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
#:
#: A VOCALS STEM'S CALIBRATION. Normalising against the TRACK's own loud level is what makes it portable
#: across masters and what makes it meaningless on a mix, where 92-98% of frames clear it (module docstring,
#: ON A VOCALS STEM ONLY). The caller applies the post-pass only where the envelope is a stem's.
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

#: A fraction of one frame, used to floor a time onto the grid it came from (`_through_the_singing`).
#:
#: Times here are frame multiples computed in binary floats, and `(k * hop) / hop` undershoots `k` by one
#: ulp for 4.9% of k, so a bare floor lands a frame early. 1e-9 of a frame is nine orders of magnitude
#: larger than that error at any song length (a 5-hour grid's worst case is ~1e-10 frames) and nine orders
#: smaller than anything that could move a stamp.
_GRID_TOLERANCE = 1e-9


def extend_ends(
    generated: Generated,
    env: Sequence[float],
    hop: float,
    theta: float = ACTIVE_LEVEL,
    *,
    tile: bool = False,
) -> Generated:
    """`generated` with every word's END walked forward through the singing. Starts never move.

    `env` is a VOCALS STEM's activity envelope (`activity.envelope`, one level per `hop` seconds) — see the
    module docstring for why the caller does not hand it a mix's. `theta` is the level at which the singing
    is judged to have stopped; `hop` is the envelope's frame, 20 ms, the same grid the onsets sit on since
    W4's exact clock, so an extended end quantises onto the decode's own grid.

    Each word's end is bounded by, in order: the frames the envelope still calls active, the next SUNG
    word's start in document order (`_next_sung`, which steps over zero-width interpolated placeholders),
    and `MAX_EXTENSION_SEC`. A word whose end already sits at or past its cap keeps it — this only ever
    moves an end LATER — and a placeholder's own end never moves at all.

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

    ZERO-WIDTH WORDS ARE SKIPPED (W4 review r1). A word whose every character is out of the dictionary gets
    its span interpolated from its neighbours, and a trailing one — a digit run, a non-Latin token; 497 of
    the corpus's 5693 Jamendo words are interpolated — has no aligned word after it in its line, so
    `generate` gives it `start = end = the previous word's end` (`generate.py`, the OOV branch). Read as a
    cap, that pins the real last word of the line at its own end: `cap == word.end`, nothing to extend,
    while the un-pronounceable token beside it (capped by the NEXT line's onset) absorbed the entire hold.
    The post-pass inverted itself — the line held a token nobody sang on screen through the sung tail while
    the word actually being sung went dark early.

    So the cap comes from the next word with a span of its own, and a zero-width word is never extended
    (`extend_ends`). That cannot light the wrong word: the TV lights `start <= pos < end`
    (`core/src/lib/tv/lyrics.ts`, `activeWordIndex`, which returns the FIRST word containing `pos`), so a
    zero-width span matches no position at all — it is a placeholder for a token with no evidence, and
    reaching past it extends the word that has some.
    """
    for index in range(start, len(flat)):
        if flat[index][1].end > flat[index][1].start:
            return flat[index]
    return None


def _through_the_singing(end: float, cap: float, env: Sequence[float], hop: float, theta: float) -> float:
    """The first instant at or after `end` where the envelope stops being active, capped at `cap`.

    A frame counts only if it fits WHOLLY before the cap, so the walk cannot step over the next onset to
    reach a frame that straddles it. The result is a frame boundary, the cap, or `end` itself; the caller
    keeps the larger of it and the word's own end, so a cap behind the end is a no-op, never a shrink.

    WHICH FRAME THE WALK STARTS ON is the one `end` sits in — which, for a decoded end, is the first frame
    AFTER the word: `_char_spans` stamps an end at `index * frame_sec` where `index` is the frame after the
    token's last, so frame `end / hop` is the first frame the word does not already own.

    FLOORED WITH A TOLERANCE, not with a bare `int` (W4 review r1). Since W4's exact clock every decoded end
    IS an integer multiple of `hop` (0.02 exactly), which is the worst case for a binary division: for 9721
    of the first 200001 k, `int((k * 0.02) / 0.02)` is `k - 1`, so the walk used to start one frame EARLY
    and a word whose own end frame is active but whose preceding frame is not was left unextended — the
    loop exited at `first` and returned `end`. `_GRID_TOLERANCE` absorbs those last bits. Not `round`,
    which would move a NON-grid end (an adopted claim span, an interpolated OOV word, `spread_over`'s even
    division) up onto the following frame and test a frame the end does not sit in.

    A walk that consumed NO frame returns `end` ITSELF rather than its frame's boundary, and that is not
    cosmetic either: `int(end / hop) * hop` differs from `end` in the last bits (70 * 0.02 is
    1.4000000000000001), so snapping to the grid would move every end in the document by a femtosecond and
    make "nothing was extended" impossible to state.
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
