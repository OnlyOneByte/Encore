"""Generating OUR OWN timings from text alone: one global CTC decode over the whole song.

No incoming timing ever enters as a search space. CHAR-LEVEL NATIVELY, which is what makes syllables free —
words, lines and syllables are three groupings of one span per character — and A CHAR SPAN IS NOT A DURATION
but an ORDERED ONSET. The whole-path CTC score does NOT detect wrong text.
The inversion and what it was worth: `docs/arch/04-alignment.md` §1, §10 and §13.
"""

from __future__ import annotations

from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Protocol

from encore_worker.domain.lyrics.language import fold_to_base
from encore_worker.domain.lyrics.units import WHOLE_WORD, Rules, plain

#: A word whose every character is out-of-dictionary gets its span INTERPOLATED from its neighbours and
#: this confidence, so a non-Latin token or a run of digits degrades one word rather than failing the line.
OOV_CONFIDENCE = "low"

#: A word whose ONSET came from its cue rather than from the decode (`reopened_line`); its own span is still
#: measured, unlike `OOV_CONFIDENCE`. Nothing that scores onsets may score it. docs/arch/04-alignment.md §4.
CUE_OPENED = "cue-opened"

#: Seconds every char span's START is pulled back toward the true acoustic onset, clamped at the previous
#: span's end. MEASURED and not tuned, on STARTS only (LOG.md, "Re-fitting `ONSET_LEAD_SEC`").
ONSET_LEAD_SEC = 0.03


@dataclass(frozen=True, slots=True)
class Syllable:
    text: str
    start: float
    end: float


@dataclass(frozen=True, slots=True)
class Word:
    word: str
    start: float
    end: float
    #: Mean per-frame log-probability over this word's chars. Comparable WITHIN a song, not across songs.
    score: float
    syllables: tuple[Syllable, ...] = ()
    #: "aligned" for a word the decode placed; OOV_CONFIDENCE for one interpolated from its neighbours.
    provenance: str = "aligned"


@dataclass(frozen=True, slots=True)
class Line:
    text: str
    start: float
    end: float
    words: tuple[Word, ...]
    #: Mean per-frame log-probability across the line's aligned chars — the within-song grading signal.
    score: float
    #: Index into the INPUT `line_texts`, carried because a line with no alignable characters is DROPPED from
    #: the output: identity has to travel with the line, not be inferred from order.
    index: int = 0


@dataclass(frozen=True, slots=True)
class Generated:
    """A full document of our own timings, plus what grading needs."""

    lines: tuple[Line, ...]
    language: str

    def as_doc(self) -> dict[str, Any]:
        """The core-contract document shape. `syllables` is an optional key an older core ignores."""
        return {
            "language": self.language,
            "lines": [
                {
                    "text": line.text,
                    "start": line.start,
                    "end": line.end,
                    "words": [
                        {
                            "word": w.word,
                            "start": w.start,
                            "end": w.end,
                            "score": w.score,
                            **(
                                {
                                    "syllables": [
                                        {"text": s.text, "start": s.start, "end": s.end} for s in w.syllables
                                    ]
                                }
                                if w.syllables
                                else {}
                            ),
                        }
                        for w in line.words
                    ],
                }
                for line in self.lines
            ],
        }


class Decoder(Protocol):
    """`(log_probs, targets, blank) -> (frame_labels, frame_scores)`, the real one being
    `adapters.ml.forced_align_decoder` — injected because `domain/` must run with no ML installed (XA-15).

    `blank` IS PART OF THE CONTRACT rather than a kernel default, the blank column belonging to the matrix
    (XA-10), and defaulted for a caller with no matrix to ask. POSITIONAL-ONLY, so an implementation's
    parameter NAMES stay its own.
    """

    def __call__(
        self, log_probs: Any, targets: Sequence[int], blank: int = 0, /
    ) -> tuple[Sequence[int], Sequence[float]]: ...


def blank_of(emissions: Any) -> int:
    """`emissions.blank_id`, or CTC's usual 0 for a matrix that does not say (XA-10).

    `getattr` ON PURPOSE: every fake and every older bench cache entry is a duck type with three attributes,
    and the one place the default is wrong is the shipped matrix, which always says.
    """
    return int(getattr(emissions, "blank_id", 0))


def excluded_of(emissions: Any) -> frozenset[int]:
    """Every vocabulary id a TARGET may never contain: CTC's blank plus the matrix's other non-character
    entries — the ONE filter every reader of this matrix shares (XA-10).

    `getattr` and a frozenset, for `blank_of`'s reason (docs/arch/04-alignment.md §14.1).
    """
    named: Mapping[str, int] = getattr(emissions, "specials", None) or {}
    return frozenset({blank_of(emissions), *(int(code) for code in named.values())})


def separator_of(emissions: Any) -> int | None:
    """The WORD-SEPARATOR id this matrix names, or None — the token `generate(separate_lines=True)` emits at
    LINE BOUNDARIES (the `linesep` arm).

    None for either of two different reasons, which `separator_named` is the reader that does not fold
    (docs/arch/04-alignment.md §14.1).
    """
    code = separator_named(emissions)
    return None if code is None or code == blank_of(emissions) else code


def separator_named(emissions: Any) -> int | None:
    """The id this matrix names for `|`, WHATEVER column it is — the blank included — or None when it names no
    `|` at all, so the trail can say which of the two inert cases happened.

    ONE LITERAL FOR ONE IDEA: which key names the separator lives here and nowhere else.
    """
    named: Mapping[str, int] = getattr(emissions, "specials", None) or {}
    code = named.get("|")
    return None if code is None else int(code)


#: The `Emissions.specials` key the STAR column is named under (`adapters.ml.STAR_NAME`; the `star` arm of
#: docs/arch/04-alignment.md §14). RESTATED HERE, as `|`'s key is in `separator_named`, because `domain/`
#: may not import the adapters; a test holds the two literals equal (`tests/test_star.py`).
_STAR_NAME = "<star>"


def star_of(emissions: Any) -> int | None:
    """The STAR id this matrix names, or None — the token `generate(stars=True)` emits BEFORE EVERY LINE (the
    `star` arm).

    None, and so an INERT arm, for either of `separator_of`'s two reasons — no star named, or a star id that
    IS the blank. The second cannot arise through `ml.starred`, whose id is the matrix's width, which is why
    it is refused here rather than trusted upstream (docs/arch/04-alignment.md §14.1).
    """
    named: Mapping[str, int] = getattr(emissions, "specials", None) or {}
    code = named.get(_STAR_NAME)
    return None if code is None or int(code) == blank_of(emissions) else int(code)


def char_ids(
    word: str,
    dictionary: Mapping[str, int],
    excluded: Collection[int],
    units: Rules | None = None,
) -> list[tuple[int, int]]:
    """`(index within `word`, vocabulary id)` for every character of `word` this vocabulary can align — THE
    target filter, and the only copy of it.

    Rules in order: LOWERCASED, then `units.fold` where it has one, then NFKD-folded to base LETTERS, and a
    non-character column is never a target (XA-10). A folded or ROMANISED character may yield SEVERAL
    targets, all carrying the index of the grapheme they came from (docs/arch/04-alignment.md §9, §9.1;
    XA-20).
    """
    spelled = units.chars if units is not None else None
    fold = units.fold if units is not None else None
    out: list[tuple[int, int]] = []
    for index, ch in spelled(word) if spelled is not None else enumerate(word.lower()):
        token = dictionary.get(ch)
        if token is None:
            if not ch.isalpha():
                continue  # the fold is a LETTER's (see above); a symbol is dropped, as it always was
            for folded in _folds(ch, fold):
                code = dictionary.get(folded) if folded.isalpha() else None
                if code is not None and code not in excluded:
                    out.append((index, int(code)))
            continue
        if token not in excluded:
            out.append((index, int(token)))
    return out


def _folds(ch: str, fold: Callable[[str], str] | None) -> str:
    """The characters to try for a `ch` the vocabulary lacks: the unit rule's own fold where it has one and
    that fold changed something, else NFKD to base letters."""
    if fold is not None:
        mapped = fold(ch)
        if mapped != ch:
            return mapped.lower()
    return fold_to_base(ch).lower()


def alignable_chars(text: str, emissions: Any, units: Rules | None = None) -> int:
    """Characters of `text` this matrix can align: in its dictionary, and not one of its non-character
    columns (XA-10).

    ONE LITERAL FOR ONE IDEA. This count is a FLOOR's input in two modules and was written out twice; both
    copies survived mutation, because the floor only ever gets LOOSER when the count is too small — on a
    vocabulary whose blank is a LETTER the two floors would be read off different texts. `char_ids` is shared
    rather than restated, so this counts TARGETS: a folded `ﬁ` costs two frames, not one.
    """
    excluded = excluded_of(emissions)
    words = units.words(text) if units is not None else text.split()
    return sum(len(char_ids(word, emissions.dictionary, excluded, units)) for word in words)


def _char_spans(
    frame_labels: Sequence[int], frame_scores: Sequence[float], frame_sec: float, blank: int = 0
) -> list[tuple[float, float, float]]:
    """Per-emitted-token `(start, end, mean_score)`, in target order.

    A hand-rolled merge rather than torchaudio's, so the grouping half of this module runs without torch. A
    span is a maximal run of one non-`blank` label and the flushing sentinel is a `blank` frame, both read off
    the MATRIX (XA-10): a literal 0 produced spans for the blank's own runs.
    """
    spans: list[tuple[float, float, float]] = []
    run_label, run_start, run_scores = blank, 0, []  # type: int, int, list[float]
    for index, label in enumerate([*frame_labels, blank]):  # sentinel blank flushes the last run
        if label == run_label:
            if label != blank:
                run_scores.append(frame_scores[index] if index < len(frame_scores) else 0.0)
            continue
        if run_label != blank:
            spans.append(
                (
                    run_start * frame_sec,
                    index * frame_sec,
                    sum(run_scores) / len(run_scores) if run_scores else 0.0,
                )
            )
        run_label, run_start = label, index
        run_scores = [frame_scores[index]] if label != blank and index < len(frame_scores) else []
    return spans


@dataclass(frozen=True, slots=True)
class _SlicedEmissions:
    """A frame window over another emission matrix — the same duck type `generate` reads, and what makes
    windowed REPAIR nearly free: a Viterbi over a slice of the matrix already in hand."""

    log_probs: Any
    frame_sec: float
    dictionary: Mapping[str, int]
    #: Carried from the sliced matrix, so a repair decode reads the same blank column the global one did.
    #: Without it `regenerate`'s inner `generate` would fall back to 0 on exactly the models
    #: where 0 is a letter.
    blank_id: int = 0
    #: Carried one filter further out, so a repair decode drops exactly the ids the global decode dropped. It
    #: MAY NAME A STAR, harmlessly: `regenerate` never asks for one, so the column is never a target.
    specials: Mapping[str, int] = field(default_factory=dict)

    @property
    def frames(self) -> int:
        return len(self.log_probs)


def _shifted(line: Line, offset: float, index: int) -> Line:
    return Line(
        text=line.text,
        start=line.start + offset,
        end=line.end + offset,
        words=tuple(
            Word(
                word=w.word,
                start=w.start + offset,
                end=w.end + offset,
                score=w.score,
                syllables=tuple(
                    Syllable(text=s.text, start=s.start + offset, end=s.end + offset) for s in w.syllables
                ),
                provenance=w.provenance,
            )
            for w in line.words
        ),
        score=line.score,
        index=index,
    )


def regenerate(
    runs: Sequence[tuple[Sequence[Line], tuple[float, float]]],
    emissions: Any,
    *,
    language: str = "en",
    decoder: Decoder,
    syllabifier: Callable[[str, str], list[str]] | None = None,
    faults: list[str] | None = None,
    separate_lines: bool = False,
    units: Rules | None = None,
) -> dict[int, Line]:
    """Re-decode runs of lines INSIDE evidence-derived windows, on the same emission matrix.

    The repair primitive behind `align_steps`' tactics: each run is decoded JOINTLY so order within it stays
    monotone, and one whose window cannot hold its text keeps its originals. `faults` gets one
    `"<Type>: <message>"` per run whose decode RAISED, and `separate_lines` is COUNTED in the window guard
    rather than merely forwarded (XA-11; docs/arch/04-alignment.md §4).
    """
    repaired: dict[int, Line] = {}
    blank = blank_of(emissions)
    separator = separator_of(emissions) if separate_lines else None
    for run, (window_start, window_end) in runs:
        if not run or emissions.frame_sec <= 0:
            continue
        first = max(0, int(window_start / emissions.frame_sec))
        last = min(emissions.frames, int(window_end / emissions.frame_sec))
        per_line = [alignable_chars(line.text, emissions, units) for line in run]
        alignable = sum(per_line)
        # Only a line that emits a character takes part in the boundary count, exactly as `generate` emits
        # them: a decorative row between two sung lines is one boundary, not two.
        separators = max(0, sum(1 for chars in per_line if chars) - 1) if separator is not None else 0
        # CTC needs at least one frame per target; anything tighter than 2x is a forced smear, not a fix.
        if alignable == 0 or (last - first) < 2 * (alignable + separators):
            continue
        window = _SlicedEmissions(
            log_probs=emissions.log_probs[first:last],
            frame_sec=emissions.frame_sec,
            dictionary=emissions.dictionary,
            blank_id=blank,
            specials=dict(getattr(emissions, "specials", None) or {}),
        )
        try:
            got = generate(
                [line.text for line in run],
                window,
                language=language,
                decoder=decoder,
                syllabifier=syllabifier,
                separate_lines=separate_lines,
                units=units,
            )
        except Exception as exc:  # noqa: BLE001 - a failed repair keeps the original, never degrades it
            if faults is not None:
                faults.append(f"{type(exc).__name__}: {exc}")
            continue
        if len(got.lines) != len(run):
            continue
        offset = first * emissions.frame_sec
        for original, redecoded in zip(run, got.lines, strict=True):
            repaired[original.index] = _shifted(redecoded, offset, original.index)
    return repaired


def remapped(line: Line, start: float, end: float) -> Line:
    """The same line affinely re-fitted onto `[start, end]`, internal proportions preserved.

    Exists for CLAMPING: a repaired line measured inside a PADDED claim window can spill over its
    neighbour, and two overlapping lines read as out-of-order words downstream — which `policy.decide`
    treats as incoherent word timing and degrades the whole document to line sync. Found live: a
    `structural` repair with 21/23 corroborating lines was thrown away over exactly 2 such words.
    """
    span = max(line.end - line.start, 1e-6)
    scale = max(end - start, 1e-6) / span

    def moved(t: float) -> float:
        return start + (t - line.start) * scale

    return Line(
        text=line.text,
        start=start,
        end=end,
        words=tuple(
            Word(
                word=w.word,
                start=moved(w.start),
                end=moved(w.end),
                score=w.score,
                syllables=tuple(
                    Syllable(text=s.text, start=moved(s.start), end=moved(s.end)) for s in w.syllables
                ),
                provenance=w.provenance,
            )
            for w in line.words
        ),
        score=line.score,
        index=line.index,
    )


def trimmed(line: Line, end: float, *, frame_sec: float) -> Line | None:
    """The same line ENDING at `end`: every word onset it measured before `end` survives and only the tail
    the decode smeared past it is re-fitted. None when no word of the line starts before `end`.

    `remapped`'s sibling and NOT a special case of it — only the sub-series from the ANCHOR moves, and the
    anchor WALKS BACK while its tail cannot hold one `frame_sec` per word still to be placed. Called by
    `align_steps._pulled_end`, the bounded left floor of the repair clamp (XA-07). Both properties, the walk
    and its price: docs/arch/04-alignment.md §4; LOG.md, "The clamp's left floor was the bug, not the ladder".
    """
    kept = [word for word in line.words if word.start < end]
    while kept and end - kept[-1].start < (len(line.words) - len(kept)) * frame_sec:
        kept.pop()
    if not kept:
        return None
    anchor = kept[-1].start
    scale = max(end - anchor, 1e-6) / max(line.end - anchor, 1e-6)

    def moved(t: float) -> float:
        return t if t <= anchor else anchor + (t - anchor) * scale

    return Line(
        text=line.text,
        start=line.start,
        end=end,
        words=tuple(
            Word(
                word=w.word,
                start=moved(w.start),
                end=moved(w.end),
                score=w.score,
                syllables=tuple(
                    Syllable(text=s.text, start=moved(s.start), end=moved(s.end)) for s in w.syllables
                ),
                provenance=w.provenance,
            )
            for w in line.words
        ),
        score=line.score,
        index=line.index,
    )


def adopted_line(text: str, index: int, start: float, end: float) -> Line | None:
    """A line carrying a CLAIM's own timing, built when the decode cannot hear the line at all.

    A human's hand timing beats a decode that heard nothing, so the claim's span is adopted wholesale: words
    spread evenly, every one flagged interpolated, score zero, and the caller grades the line `low`. This is
    a surrender to better evidence, not a measurement (docs/arch/04-alignment.md §4).
    """
    words = text.split()
    if not words or end <= start:
        return None
    step = (end - start) / len(words)
    spread = tuple(
        Word(
            word=word,
            start=start + i * step,
            end=start + (i + 1) * step,
            score=0.0,
            provenance=OOV_CONFIDENCE,
        )
        for i, word in enumerate(words)
    )
    return Line(text=text, start=start, end=end, words=spread, score=0.0, index=index)


def reopened_line(line: Line, start: float) -> Line | None:
    """`line` re-opened at `start`, its first word and that word's first syllable with it. None if it cannot.

    For a decode that heard the line but not its OPENING — a sustained leading vowel the forced path absorbs
    into blank. Only the opening boundary moves; the first word's onset is the SHEET'S, so it is CUE_OPENED
    and scores 0.0. REFUSED when no OTHER word is aligned: that leaves the line unmeasured and graded `low`,
    which is an adoption with a kept end (docs/arch/04-alignment.md §4).
    """
    if not line.words or not start < line.words[0].end or start >= line.start:
        return None
    if not any(word.provenance == "aligned" for word in line.words[1:]):
        return None
    first = line.words[0]
    syllables = first.syllables
    if syllables:
        syllables = (replace(syllables[0], start=min(syllables[0].start, start)), *syllables[1:])
    opened = replace(first, start=start, syllables=syllables, score=0.0, provenance=CUE_OPENED)
    return replace(line, start=start, words=(opened, *line.words[1:]))


@dataclass(frozen=True, slots=True)
class CharTargets:
    """The CTC target sequence one text becomes, and who owns each target.

    Extracted so a SECOND reader of the same trellis exists (`domain.lyrics.margin`): recomputing it there
    would be two copies of the target filter, the lower-casing and the separator's lazy placement, whose
    disagreement would make the margin describe a decode that never ran.
    """

    #: Vocabulary ids in decode order, separators included: exactly what the decoder is given.
    targets: tuple[int, ...]
    #: `(line index, word index)` per CHARACTER target, in order — separators own no character and so have
    #: no entry, which is why this is shorter than `targets` under `separate_lines`.
    owners: tuple[tuple[int, int], ...]
    #: Each character target's index WITHIN its word, for regrouping into syllables.
    char_of: tuple[int, ...]
    #: The words of each input line (`Rules.words`, `text.split()` by default), kept so the caller splits
    #: once.
    words_by_line: tuple[tuple[str, ...], ...]
    #: How many of `targets` are line separators (`separator_of`), i.e. targets with no character.
    separators: int
    #: Line index -> the position in `targets` of that line's FIRST character target. A line that emitted no
    #: target at all (a decorative row, a line the never-sung rule blanked) is absent.
    first_char_target: Mapping[int, int]
    #: How many of `targets` are STARS (`star_of`, the `star` arm) — the other kind of target that owns no
    #: character, counted separately because the two arms are independent and the span-count invariant below
    #: has to subtract both.
    stars: int = 0
    #: Each CHARACTER target's position in `targets`, parallel to `owners`: what a reader of the trellis needs
    #: to name a line's own states when separators or stars sit between them (`line_blocks`).
    char_positions: tuple[int, ...] = ()


def char_targets(
    line_texts: Sequence[str],
    emissions: Any,
    *,
    separate_lines: bool = False,
    stars: bool = False,
    units: Rules | None = None,
) -> CharTargets:
    """Flatten `line_texts` into the decoder's target sequence (see `CharTargets`, and `generate`, its
    caller and the definition of every rule here).

    `units` is the script's own word rule and vocabulary spelling (`units.Rules`); without one this is the
    whitespace rule every recorded row was measured on.
    """
    dictionary: Mapping[str, int] = emissions.dictionary
    excluded = excluded_of(emissions)
    separator = separator_of(emissions) if separate_lines else None
    star = star_of(emissions) if stars else None
    targets: list[int] = []
    owners: list[tuple[int, int]] = []
    char_of: list[int] = []
    positions: list[int] = []
    words_by_line: list[tuple[str, ...]] = []
    first: dict[int, int] = {}
    separators = 0
    starred = 0
    pending_separator: int | None = None
    for line_index, text in enumerate(line_texts):
        words_by_line.append(tuple(units.words(text) if units is not None else text.split()))
        # A STAR IS OWED BY THIS LINE and paid at its first character target, for the separator's reason one
        # line down: a decorative row (`♪`, a line the never-sung rule blanked) contributes no character, and
        # two stars in a row would be a second absorbing token nobody asked for.
        pending_star = star
        for word_index, word in enumerate(words_by_line[-1]):
            for char_index, token in char_ids(word, dictionary, excluded, units):
                if pending_separator is not None:
                    targets.append(pending_separator)
                    separators += 1
                    pending_separator = None
                if pending_star is not None:
                    targets.append(pending_star)
                    starred += 1
                    pending_star = None
                first.setdefault(line_index, len(targets))
                positions.append(len(targets))
                targets.append(token)
                owners.append((line_index, word_index))
                char_of.append(char_index)
        if separator is not None and targets:
            # A BOUNDARY IS OWED, and is paid at the next line that has a character (so never trailing, and
            # never twice over a line that contributes none).
            pending_separator = separator
    return CharTargets(
        targets=tuple(targets),
        owners=tuple(owners),
        char_of=tuple(char_of),
        words_by_line=tuple(words_by_line),
        separators=separators,
        first_char_target=first,
        stars=starred,
        char_positions=tuple(positions),
    )


def line_blocks(flat: CharTargets) -> dict[int, tuple[int, int]]:
    """Line index -> `[first, last)` positions in `flat.targets` spanning that line's CHARACTER targets.

    The run a skip arc bypasses (`viterbi.line_skips`). A line that emitted no character is absent, and the
    run is contiguous because a separator and a star are both emitted BEFORE a line's first character, never
    between two of them.
    """
    out: dict[int, tuple[int, int]] = {}
    for (line_index, _word), position in zip(flat.owners, flat.char_positions, strict=True):
        low, high = out.get(line_index, (position, position))
        out[line_index] = (min(low, position), max(high, position + 1))
    return out


def _lead_starts(spans: list[tuple[float, float, float]], lead: float) -> list[tuple[float, float, float]]:
    """Each span's start pulled back by `lead`, never past the previous span's end. Clamped against the
    ORIGINAL previous end, so chars stay non-overlapping and syllables and words do too (XA-09)."""
    out: list[tuple[float, float, float]] = []
    previous_end = 0.0
    for start, end, score in spans:
        pulled = min(max(start - lead, previous_end, 0.0), start)
        out.append((pulled, end, score))
        previous_end = end
    return out


def generate(
    line_texts: Sequence[str],
    emissions: Any,
    *,
    language: str = "en",
    decoder: Decoder,
    syllabifier: Callable[[str, str], list[str]] | None = None,
    separate_lines: bool = False,
    stars: bool = False,
    units: Rules | None = None,
) -> Generated:
    """Align `line_texts` over the whole recording and return nested line/word/syllable timings.

    `emissions` is `adapters.ml.Emissions` (duck-typed), computed once per song and shared by every candidate
    text. Non-character ids are never targets (XA-10); both default-off target-adding arms are counted in the
    span check and relabelled to blank before grouping (XA-11, XA-12). `units` is the script's own word and
    syllable rule and an explicit `syllabifier` overrides its syllable half, which is how the bench switches
    syllabification off. docs/arch/04-alignment.md §2, §9.1, §14.1 and §12 (XA-09).
    """
    blank = blank_of(emissions)
    separator = separator_of(emissions) if separate_lines else None
    star = star_of(emissions) if stars else None
    decode = decoder
    split = syllabifier or (units or plain()).syllables

    # ── flatten to char targets, remembering every char's owner (`char_targets`, shared with `margin`) ──
    flat = char_targets(line_texts, emissions, separate_lines=separate_lines, stars=stars, units=units)
    targets, owners, char_of = flat.targets, flat.owners, flat.char_of
    words_by_line, separators = flat.words_by_line, flat.separators

    if not targets or emissions.frames == 0:
        return Generated(lines=(), language=language)

    frame_labels, frame_scores = decode(emissions.log_probs, targets, blank)
    if separators or flat.stars:
        # THE SEPARATOR'S AND THE STAR'S FRAMES BECOME BLANK (XA-11), each being a target the path had to
        # visit rather than a token with a span, and BEFORE `_lead_starts` too
        # (docs/arch/04-alignment.md §14.1).
        voided = {token for token in (separator, star) if token is not None}
        frame_labels = [blank if label in voided else label for label in frame_labels]
    spans = _lead_starts(_char_spans(frame_labels, frame_scores, emissions.frame_sec, blank), ONSET_LEAD_SEC)
    # One span per target when the kernel succeeds, MINUS the separators and the stars, whose frames were
    # just relabelled away: anything else is a defect rather than a degradable condition (XA-11).
    if len(spans) != len(targets) - separators - flat.stars:
        # The star clause only where there ARE stars, so the default's and `linesep`'s message is the one
        # every reader of this suite already knows (`tests/test_linesep.py` pins it).
        raise ValueError(
            f"decode produced {len(spans)} token spans for "
            f"{len(targets) - separators - flat.stars} character targets "
            f"(of {len(targets)}, {separators} of them line separators"
            f"{f' and {flat.stars} stars' if flat.stars else ''}); "
            "the emission matrix and the target encoding disagree"
        )

    # ── regroup: chars -> words -> syllables -> lines ──
    per_word: dict[tuple[int, int], list[tuple[int, tuple[float, float, float]]]] = {}
    for owner, char_index, span in zip(owners, char_of, spans, strict=True):
        per_word.setdefault(owner, []).append((char_index, span))

    lines: list[Line] = []
    for line_index, text in enumerate(line_texts):
        words: list[Word] = []
        pending_oov: list[int] = []
        for word_index, word_text in enumerate(words_by_line[line_index]):
            chars = per_word.get((line_index, word_index))
            if not chars:
                pending_oov.append(word_index)
                words.append(Word(word=word_text, start=0.0, end=0.0, score=0.0, provenance=OOV_CONFIDENCE))
                continue
            starts = [s for _c, (s, _e, _sc) in chars]
            ends = [e for _c, (_s, e, _sc) in chars]
            scores = [sc for _c, (_s, _e, sc) in chars]
            # A `WHOLE_WORD` target names no grapheme, so the word is timed but publishes no syllables
            # rather than one real span and the rest zero-width at its end (XA-20).
            attributable = all(char_index != WHOLE_WORD for char_index, _span in chars)
            fragments = split(word_text, language) if attributable else []
            syls: list[Syllable] = []
            cursor = 0
            for fragment in fragments:
                lo, hi = cursor, cursor + len(fragment)
                cursor = hi
                inside = [span for c, span in chars if lo <= c < hi]
                if inside:
                    syls.append(Syllable(text=fragment, start=inside[0][0], end=inside[-1][1]))
                elif syls:
                    # A fragment whose chars were all OOV (an apostrophe, a digit) has no span of its own;
                    # zero-width at the previous fragment's end keeps the nesting invariant.
                    syls.append(Syllable(text=fragment, start=syls[-1].end, end=syls[-1].end))
            words.append(
                Word(
                    word=word_text,
                    start=min(starts),
                    end=max(ends),
                    score=sum(scores) / len(scores),
                    syllables=tuple(syls) if len(syls) > 1 else (),
                )
            )

        # OOV words: interpolate between aligned neighbours, flagged rather than silent.
        aligned_positions = [i for i, w in enumerate(words) if w.provenance == "aligned"]
        for position in pending_oov:
            before = max((i for i in aligned_positions if i < position), default=None)
            after = min((i for i in aligned_positions if i > position), default=None)
            if before is not None:
                start = words[before].end
            elif after is not None:
                start = words[after].start
            else:
                start = 0.0
            end = words[after].start if after is not None else start
            words[position] = Word(
                word=words[position].word,
                start=start,
                end=max(end, start),
                score=0.0,
                provenance=OOV_CONFIDENCE,
            )

        aligned_words = [w for w in words if w.provenance == "aligned"]
        if not aligned_words:
            continue  # a line with no alignable chars produces nothing rather than an invented span
        lines.append(
            Line(
                text=text,
                start=min(w.start for w in aligned_words),
                end=max(w.end for w in aligned_words),
                words=tuple(words),
                score=sum(w.score for w in aligned_words) / len(aligned_words),
                index=line_index,
            )
        )
    return Generated(lines=tuple(lines), language=language)
