"""AD-LIBS AND ECHO TAILS: the words the LEAD voice is not singing (review §3.13, PLAN W5).

WHAT GOES WRONG WITHOUT THIS. The global decode is ONE monotone CTC path over the whole recording
(`generate`), and every character in the target sequence must be consumed in order. A backing vocal is not
in order with the lead: Hello's caption track writes `♪ So hello from the other side ♪` and then
`♪ Other side ♪` — a second voice echoing the tail WHILE the lead has moved on — and Shape of You writes
`♪ Come on, be my baby - (I'm in love with your body) ♪`, where the parenthetical is a different singer
over the same bar. The path has to spend frames on those characters somewhere, and the only frames it can
spend are the ones the NEXT lead lines were sung in. So the damage is not on the ad-lib: it is on
everything after it, which is why the review measured it on the LEAD lines.

WHAT THIS DOES. Two ANCHORED rules take those words out of the decode's target sequence and time them
afterwards inside their host line, so the lead's path is the lead's alone:

  R1  A MID-LINE OR TRAILING PARENTHETICAL with letters in it (review §3.13's "lexical parenthetical").
      `with me (e-e-ee)`, `shoes (Caught in the undertow, just caught in the undertow)`, `lookin' boy
      (Ha!)`. The group must begin and end at WORD boundaries, so no token is cut in half, and the line
      must keep at least one lead word.
      NOT A LEADING ONE, which is the spec's own word and a measured reason: a leading aside is where the
      host line STARTS, and every metric in this repo scores a line by its start, so excluding it would
      move the one number the decode is judged on. tfr-flyaway's `(ca-ca) Come and fly away` is the
      corpus's only shape of that kind (2 lines) and is left in the decode.
      NOT A WHOLE-LINE ONE either: that is `nonlyric.py`'s question (is this a cue or a backing line?) and
      `clean.py` measured what reading it as a cue costs — `♪ (Oh-I-oh-I-oh-I-oh-I) ♪` is sung.

  R2  AN ECHO-TAIL LINE: a whole line whose normalised words are a strict SUFFIX of the line before it,
      at most `MAX_ECHO_SHARE` of that line's length, AND ALONE — the line after it must not echo the same
      host again. `Other side` after `So hello from the other side`, `Thousand times` after `I must've
      called a thousand times`, `I've tried` after `At least I can say that I've tried`. It is still
      PUBLISHED as its own line — the TV shows it — and it is timed in the gap the lead decode leaves
      between its host and the next lead line, which is exactly where the second voice sang it.

      THE "ALONE" CLAUSE IS A MEASURED REFUSAL, not tidiness, and `never-be-alone` is what measured it.
      That song's text writes its hook as `You'll never be alone` / `be alone...` / `be alone` — ELEVEN
      such triples, 21 of its 22 candidate echoes — and the truth timings say those are SEQUENTIAL lead
      phrases, not a simultaneous second voice: 155.30-157.92, then 157.92-158.80, then 158.80-159.78,
      three consecutive spans with no gap anywhere. Taking them out of the lead decode would leave 21
      lines of 47 with no room to be timed in and interpolate them onto their host's end, which is a
      document half-destroyed in exchange for nothing. A tail sung TWICE over is a repetition the singer
      performed; one sung once beside a long lead line is the ad-lib this rule is about. The residue is
      named rather than fitted away: never-be-alone keeps ONE candidate (`be alone` at index 30, whose
      pair-mate the text happens not to write), and no second threshold is added to catch it.

THE REACH IS MEASURED AND IT IS SMALL (32-song bench corpus, the texts as `clean_segments` serves them,
`_runs/w5-adlibs/scan.py`): **12 parenthetical hosts in 4 songs** (tfr-flyaway 4 `with me (e-e-ee)`, numb 4
`(Caught in the undertow…)`, shape-of-you 3 `(I'm in love with your body)`, rap-god 1 `(Ha!)`) and **15 echo
tails in 6 songs** (hello 8, never-be-alone 2, Ridgway 2, LUNABLIND 1, bad-guy 1, bohemian-rhapsody 1), out
of 1712 served lines; 10 of the 32 songs are touched at all. On the other 22 this module is IDENTITY —
`lead_texts == line_texts`, `hosts` empty, `restored` returns the same object — so a run on them is
byte-identical by construction and not merely by measurement. THE ONE SONG THE REVIEW MEASURED IS THE ONE IT
REACHES MOST, which is the critics' objection repeated as arithmetic: 8 of the 15 echo tails are Hello's.
(On a text that has NOT been cleaned — the bench's `--level time_text` serves the caption lines raw — the
parenthetical count is 16 in 6 songs, the three extra being hello's `(wind buffeting) (phone clacking)`-shaped
CUE lines, which the shipped path drops at clean time and this module never sees in production.)

AND THE ARM FAILS ITS BAR, WHICH IS WHY IT SHIPS OFF (`host.config.ALIGN_EXPERIMENTS`, `adlibs`, where the
A/B lives). The short version: on the tree that ships, the ONE echo tail whose timing moved got WORSE (hello
`♪ Other side ♪` +1.84 -> +2.08 s), numb gained a gross line after two aside hosts, never-be-alone lost a
published line to the never-sung rule's moved median, and pooled blind gross was 14 against 14. The review's
21 -> 11 does not reproduce because its population is gone: hello's blind decode has six gross lines in
total now, where it had 21 before W6's clamp fix and the HuBERT-L flip.

WHAT A RESTORED TIMING IS AND IS NOT. An aside's words are apportioned across the room their host leaves
them BY CHARACTER COUNT (`presplit.presplit_text`'s rule, and for its reason: an even split gives a
one-syllable ad-lib the same span as a six-word one). That is an INTERPOLATION, not a measurement, and it
is labelled as one — every restored word carries `generate.OOV_CONFIDENCE`, exactly as a word whose
characters the dictionary lacks already does, so nothing downstream has to learn a new provenance. A line
with NO measured word of its own (every R2 echo) is what `unmeasured_lines` reports, and
`align_steps.line_confidence` grades it `low`: its onset is derived from its host's end rather than heard,
and W6's TV consumer then renders it line-level with no word wipe. That demotion can only take a line
DOWN, so §3.7's `high_gross` cannot rise.

THE ORDER INVARIANT IS KEPT BY CONSTRUCTION, because breaking it is expensive: two words out of order read
as incoherent word timing and `policy.decide` degrades the whole document to line sync (`measure`
`out_of_order`, and the live incident in `generate.remapped`'s docstring). `restored` carries a FLOOR —
the end of the last word it emitted — and no interpolated word starts before it, so the published word
sequence is monotone whatever the gaps turn out to be. Where there is no room at all the words are
zero-width at that floor: on screen a flash, in the metrics a start that is its host's end, and never a
word that walks backwards.

WHAT THIS IS NOT, deliberately. It is not a SECOND DECODE of the aside inside the gap. That is the obvious
next step — the gap is evidence-derived, which is precisely what `generate.regenerate` takes — and it is
not taken here because it adds a repair site with its own window guard and its own failure mode for 50
lines of the corpus, and because in a CLAIM mode the ladder already re-decodes a repaired line from its
FULL text (`regenerate` reads `Line.text`), so the asides of a repaired line come back MEASURED without
this module doing anything. The arm's own value is therefore concentrated exactly where the review
measured it: a blind decode.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from encore_worker.domain.lyrics.generate import (
    OOV_CONFIDENCE,
    Generated,
    Line,
    Word,
    alignable_chars,
)
from encore_worker.domain.lyrics.policy import normalised_words

#: The most of its host's words an echo tail may repeat before it reads as a lyric line of its own rather
#: than a backing voice. Measured on the corpus's own echoes, which are 1-3 words against hosts of 4-9
#: (`Other side` 2/6, `Thousand times` 2/7, `Outside` 1/4, `I've tried` 3/9): at 0.5 all 23 are caught and
#: the rule still refuses a near-complete repeat, which is a REPEATED LYRIC and the ladder's business
#: (`margin.fuzzy_repeats`, R3's anchoring) rather than an ad-lib's.
MAX_ECHO_SHARE = 0.5

#: One balanced parenthetical group, no nesting. Nesting is not a shape caption tracks or lyric sheets
#: write, and the pattern refusing it is what keeps `(a (b) c)` out of R1 rather than splitting it wrong.
_GROUP = re.compile(r"^\([^()]*\)$")

_LETTER = re.compile(r"[^\W\d_]", re.UNICODE)


@dataclass(frozen=True, slots=True)
class Host:
    """One line as the LEAD decode sees it, and as it will be PUBLISHED.

    `words` is the publication word list — the input line's own `split()`, every token of it — and `aside`
    is parallel to it: True where the lead decode was never given that word. `lead` is the space-join of
    the rest, so `lead.split()` and the False positions of `aside` are the same list by construction,
    which is what makes `restored`'s pairing exact rather than a re-parse.
    """

    index: int
    #: The input line, unchanged. What the published document says.
    text: str
    #: What the decode is given. `""` for an echo-tail line, whose every word is its host's.
    lead: str
    words: tuple[str, ...]
    aside: tuple[bool, ...]
    #: For an R2 echo tail, the index of the line it echoes. None for an R1 parenthetical host.
    echo_of: int | None = None


@dataclass(frozen=True, slots=True)
class Split:
    """`line_texts` as two things: what the lead decode is given, and how to put the rest back."""

    #: Parallel to the input texts, same length, same indexes — `generate` is given THIS.
    lead_texts: tuple[str, ...]
    #: Only the lines something was taken out of. Empty on a text with no ad-libs, and then this whole
    #: module is identity.
    hosts: Mapping[int, Host]

    @property
    def reaches(self) -> bool:
        """Did either rule fire? False means `generate(lead_texts)` IS `generate(line_texts)`."""
        return bool(self.hosts)

    def why(self) -> str:
        """The trail sentence. Silent-by-default is what made the first live mis-read possible, so this
        says NOTHING FIRED rather than printing nothing (every other `_*_why` in `align_steps` does)."""
        if not self.hosts:
            return "ad-libs: no mid-line parenthetical and no echo tail in this text"
        echoes = sorted(index for index, host in self.hosts.items() if host.echo_of is not None)
        asides = sorted(index for index, host in self.hosts.items() if host.echo_of is None)
        parts = []
        if asides:
            groups = sum(_runs(self.hosts[index].aside) for index in asides)
            parts.append(f"{groups} parenthetical(s) in lines {_listed(asides)}")
        if echoes:
            parts.append(f"{len(echoes)} echo-tail line(s) {_listed(echoes)}")
        return f"ad-libs: {' and '.join(parts)} held out of the lead decode and timed inside their host"


def untouched(line_texts: Sequence[str]) -> Split:
    """The split that takes NOTHING out: what the default path uses.

    So the arm is one expression in `align_steps` and not a branch around every decode — `lead_texts` is
    the served text, `hosts` is empty, and `restored` is the identity on any document.
    """
    return Split(lead_texts=tuple(line_texts), hosts={})


def split(line_texts: Sequence[str], *, emissions: Any | None = None) -> Split:
    """Take the ad-libs out of `line_texts` (R1, R2) without changing one published word.

    The returned `lead_texts` is PARALLEL to the input — same length, same indexes — because every
    consumer of a text's lines in this repo enumerates one sequence and pairs on position
    (`generate.Line.index`, `clean_segments`' DROPPING RENUMBERS NOTHING). An echo tail's entry is `""`,
    which is the same thing the never-sung rule writes for a line it drops, so the decode already knows
    how to contribute no targets for an index.

    `emissions` IS THE MATRIX THE LEAD DECODE WILL RUN ON, and R1 reads its DICTIONARY (W5 review
    r1-tests-20). "Something is left for the decode to align" was a LETTER test, and a letter the
    dictionary lacks is dropped by `generate` exactly as a `♪` is: a line whose lead words are all
    out-of-vocabulary and whose parenthetical is in-vocabulary passed the test, `generate` then emitted
    nothing for it, and `restored` published nothing — so the ARM LOST A LINE the default path publishes,
    aside words included. With the matrix in hand the test is `generate.alignable_chars`, the same function
    the decode and every repair window measure a line with. None keeps the letter test, which is all a
    caller without a matrix can do (and what `tests/test_parts.py` reads the rules through).
    """
    alignable = _alignable_with(emissions)
    words = [tuple(text.split()) for text in line_texts]
    aside = [_aside_flags(line, alignable) for line in words]
    #: A line nothing was taken out of keeps its text BYTE-IDENTICALLY, never the re-joined tokens: the
    #: decode's `Line.text` becomes the published one, and re-joining silently rewrote every line's
    #: whitespace (measured on numb, whose caption lines read `CHORUS:  Become so tired` with two spaces —
    #: 7 published lines changed under the arm with no timing having moved).
    leads = [
        text
        if not any(flags)
        else " ".join(word for word, is_aside in zip(line, flags, strict=True) if not is_aside)
        for text, line, flags in zip(line_texts, words, aside, strict=True)
    ]
    echoes = _echo_tails(leads)
    hosts: dict[int, Host] = {}
    lead_texts: list[str] = []
    for index, text in enumerate(line_texts):
        if index in echoes:
            hosts[index] = Host(
                index=index,
                text=text,
                lead="",
                words=words[index],
                aside=(True,) * len(words[index]),
                echo_of=echoes[index],
            )
            lead_texts.append("")
            continue
        if any(aside[index]):
            hosts[index] = Host(
                index=index, text=text, lead=leads[index], words=words[index], aside=aside[index]
            )
        lead_texts.append(leads[index])
    return Split(lead_texts=tuple(lead_texts), hosts=hosts)


def _echo_tails(leads: Sequence[str]) -> dict[int, int]:
    """R2: `{echo line index: its host's index}`, after the ALONE clause has refused the sequences.

    Two passes, and the first one's HOST CHAIN is computed before any refusal so that the rule is a
    function of the text and not of the order the refusals happened in: a candidate's host is the last
    line that is not itself a candidate, and a candidate the second pass refuses does not become a host
    retroactively.
    """
    candidates: dict[int, int] = {}
    previous: int | None = None
    for index, lead in enumerate(leads):
        if previous is not None and _echoes(leads[previous], lead):
            candidates[index] = previous
            continue
        if lead:
            previous = index
    # THE ALONE CLAUSE (see the module docstring, and never-be-alone's eleven triples).
    return {
        index: host
        for index, host in candidates.items()
        if index - 1 not in candidates and index + 1 not in candidates
    }


def restored(generated: Generated, split_of: Split, *, until: float | None = None) -> Generated:
    """Put every ad-lib word back in its published place, timed inside the room its host leaves it.

    `generated` must be the decode of `split_of.lead_texts` (`Line.index` is the input index either way).
    Returns `generated` UNCHANGED — the same object — when nothing was taken out, so a text with no
    ad-libs cannot be perturbed by this module even in principle.

    `until` is the recording's end, the only bound a trailing aside on the LAST line has. None leaves such
    a run zero-width at its host's end rather than inventing a span past the audio.
    """
    if not split_of.reaches:
        return generated
    decoded = {line.index: line for line in generated.lines}
    ahead = _next_starts(len(split_of.lead_texts), decoded, until=until)

    out: list[Line] = []
    emitted: dict[int, Line] = {}
    floor = 0.0
    for index in range(len(split_of.lead_texts)):
        host = split_of.hosts.get(index)
        if host is not None and host.echo_of is not None and host.echo_of not in emitted:
            # AN ECHO WHOSE HOST WAS NOT PUBLISHED GOES WITH IT (W5 review r1-correctness-5). Its host's
            # measurement is the only thing that places it — `_echo_tails` guarantees the host is an EARLIER
            # index, so an absent one means `generate` dropped that line for carrying no alignable character,
            # and the echo's words are a suffix of its host's, so the default path has nothing to align there
            # either. Restoring it anyway parked a published line at the document FLOOR (0.0 when no line had
            # been emitted yet) spanning the whole lead-in, with `score=0.0` — a zero on a log-probability
            # scale is an impossibly GOOD score, and it entered the never-sung rule's median as one. Same
            # treatment the R1 host below gets, for the same reason: no measurement, no line.
            continue
        if host is None or (host.echo_of is None and index not in decoded):
            # Not ours, or a host whose lead text carried no alignable character at all: `generate` drops
            # such a line and so do we, exactly as it does today.
            line = decoded.get(index)
            if line is not None:
                out.append(line)
                emitted[index] = line
                floor = max(floor, line.end)
            continue
        if host.echo_of is None:
            words, floor = _woven(host, decoded[index], floor=floor, limit=ahead[index])
            line = _line_of(host, words, score=decoded[index].score)
        else:
            # Present by the guard at the top of the loop: an echo with no emitted host is dropped there.
            anchor = emitted[host.echo_of]
            words = _spread(host.words, max(floor, anchor.end), ahead[index])
            floor = max(floor, words[-1].end)
            # ITS HOST'S SCORE, because its host's measurement is what placed it. Not 0.0: the never-sung
            # rule and the confidence rule both read `Line.score` against the song's MEDIAN, and a zero
            # on a log-probability scale is an impossibly GOOD score, which would quietly exempt every
            # echo from both.
            line = _line_of(host, words, score=anchor.score)
        out.append(line)
        emitted[index] = line
    return Generated(lines=tuple(out), language=generated.language)


def unmeasured_lines(generated: Generated) -> frozenset[int]:
    """Indexes of lines NO word of which the decode placed: every R2 echo, AND every claim-ADOPTED line.

    THE SECOND HALF IS NOT THIS MODULE'S AND IS NOT ARM-ONLY (W5 review r2-spec-13, which found this
    docstring claiming "nothing else today"). `generate.adopted_line` builds a line whose every word carries
    `OOV_CONFIDENCE` provenance — the claim span was copied, not heard — so it matches this predicate exactly
    as an echo does, with no experiment set. That is the truth about the predicate rather than a defect in
    it: a line nothing measured is a line nothing measured, whichever rule invented its words. It costs no
    behaviour either, because the one reader grades an adopted line `low` on the next branch regardless
    (`align_steps`' `line_confidence`), and the only way to tell the two apart would be to read provenance
    the caller already has.

    Read off the document rather than kept as a set beside it, so a line the ladder later re-decoded from
    its full text (`regenerate` reads `Line.text`) is no longer reported: the repair measured it, and a
    grade that still said "interpolated" would be describing the timing before the repair.
    """
    return frozenset(
        line.index
        for line in generated.lines
        if line.words and not any(word.provenance == "aligned" for word in line.words)
    )


def _alignable_with(emissions: Any | None) -> Callable[[str], bool]:
    """ "Can the lead decode align anything in this text?" — read off the MATRIX when there is one.

    `alignable_chars` is `generate`'s own target filter (dictionary membership, non-character columns
    excluded), so with a matrix in hand the question R1 asks is exactly the question `generate` will answer.
    Without one it is the letter test, which is what `_mark`'s docstring measured on shape-of-you.
    """
    if emissions is None:
        return lambda text: bool(_LETTER.search(text))
    return lambda text: alignable_chars(text, emissions) > 0


def _aside_flags(words: Sequence[str], alignable: Callable[[str], bool]) -> tuple[bool, ...]:
    """R1, on TOKENS: True for every word a mid-line or trailing parenthetical owns.

    Token-anchored on purpose. A group that starts or ends inside a token (`la(ha)la`) would make the
    published word list and the lead decode's disagree about what a word IS, and the pairing in `restored`
    rests on them agreeing; such a line is left whole instead (0 lines in the bench corpus).

    An UNBALANCED line — one `(` and no `)`, which a truncated caption cue writes — marks nothing: the
    group never closes, so there is no span to take out and the line goes to the decode whole.
    """
    flags = [False] * len(words)
    depth = 0
    start = 0
    for position, word in enumerate(words):
        if depth == 0:
            if not word.startswith("("):
                continue
            start = position
        depth += word.count("(") - word.count(")")
        if depth > 0:
            continue
        if depth == 0 and word.endswith(")"):
            _mark(flags, words, start, position, alignable)
        depth = 0
    return tuple(flags)


def _mark(
    flags: list[bool], words: Sequence[str], start: int, stop: int, alignable: Callable[[str], bool]
) -> None:
    """Flag `words[start..stop]` as an aside, IF it is one: never leading, lexical, and never the whole
    line's WORDS (what is left must still be something the lead decode can align).

    THE LAST CONDITION WAS MEASURED, not foreseen. `♪ (Oh-I-oh-I-oh-I-oh-I) ♪` is shape-of-you's backing
    line, and in a text that reaches this module BEFORE `clean_line` (the bench's `--level time_text` serves
    the caption lines raw) its parenthetical is not leading — a `♪` is in front of it — so a "something is
    left" test that counted TOKENS read `♪ ♪` as a lead line, handed the decode a line with no alignable
    character, and dropped six published lines of that song. A decoration is not a lead.
    AND NEITHER IS A WORD THE DICTIONARY LACKS (W5 review r1-tests-20): `alignable` is the matrix's own
    membership test where `split` was given a matrix, because a letter the decode cannot consume leaves
    just as little to align as a `♪` does — see `split`'s docstring for the line the arm lost that way.
    """
    if start == 0:  # NEVER LEADING (see the module docstring)
        return
    if not _LETTER.search(" ".join(words[start : stop + 1])):
        return  # `(...)`, `(!)`: punctuation, which `clean_line` has already had its say about
    kept = [word for index, word in enumerate(words) if not (start <= index <= stop) and not flags[index]]
    if not alignable(" ".join(kept)):
        return  # a whole-line parenthetical, decorated: there would be no lead left to align
    for index in range(start, stop + 1):
        flags[index] = True


def _echoes(host_lead: str, lead: str) -> bool:
    """R2: is `lead` a short echo of the TAIL of `host_lead`?

    Compared on `policy.normalised_words` — lowercased, punctuation dropped — which is the form this
    package already compares two texts in, so `Other side` echoes `...the other side ♪` and the rule does
    not acquire a fourth definition of "the same word".
    """
    here = normalised_words([lead]).split()
    host = normalised_words([host_lead]).split()
    if not here or not host or len(here) >= len(host):
        return False
    if len(here) > max(1, int(MAX_ECHO_SHARE * len(host))):
        return False
    return host[-len(here) :] == here


def _next_starts(lines: int, decoded: Mapping[int, Line], *, until: float | None) -> dict[int, float | None]:
    """Per index, the start of the next DECODED line after it — the bound a trailing run may not cross."""
    out: dict[int, float | None] = {}
    nxt = until
    for index in range(lines - 1, -1, -1):
        out[index] = nxt
        line = decoded.get(index)
        if line is not None:
            nxt = line.start
    return out


def _woven(host: Host, decoded: Line, *, floor: float, limit: float | None) -> tuple[tuple[Word, ...], float]:
    """`host`'s publication words: the decoded lead words where they are, the asides apportioned between.

    The decoded words are consumed IN ORDER against the False positions of `host.aside` — the two lists
    are the same length by `split`'s construction, and a mismatch means `generated` is the decode of some
    other text, which is a caller bug rather than an input.
    """
    lead = list(decoded.words)
    if len(lead) != sum(1 for flag in host.aside if not flag):  # pragma: no cover - a caller bug
        raise ValueError(f"line {host.index}: {len(lead)} decoded words for lead text {host.lead!r}")
    out: list[Word] = []
    at = 0
    runs = _grouped(host.aside)
    for is_aside, start, stop in runs:
        if not is_aside:
            for word in lead[at : at + (stop - start)]:
                out.append(word)
            at += stop - start
            floor = max(floor, out[-1].end)
            continue
        low = max(floor, out[-1].end if out else floor)
        high = lead[at].start if at < len(lead) else limit
        spread = _spread(host.words[start:stop], low, high)
        out.extend(spread)
        floor = max(floor, spread[-1].end)
    return tuple(out), floor


def _spread(words: Sequence[str], low: float, high: float | None) -> tuple[Word, ...]:
    """`words` apportioned across `[low, high]` by CHARACTER COUNT, zero-width when there is no room.

    By character count and not evenly, for `presplit.presplit_text`'s measured reason: `(e-e-ee)` beside
    `(Caught in the undertow, just caught in the undertow)` would otherwise get the same span.
    """
    room = max(0.0, (high if high is not None else low) - low)
    total = sum(len(word) for word in words) or 1
    out: list[Word] = []
    at = low
    for position, word in enumerate(words):
        end = low + room if position == len(words) - 1 else at + room * (len(word) / total)
        out.append(Word(word=word, start=at, end=max(at, end), score=0.0, provenance=OOV_CONFIDENCE))
        at = max(at, end)
    return tuple(out)


def _line_of(host: Host, words: Sequence[Word], *, score: float) -> Line:
    """The published line: the INPUT text (never the lead text), spanning every word it now carries."""
    return Line(
        text=host.text,
        start=min(word.start for word in words),
        end=max(word.end for word in words),
        words=tuple(words),
        score=score,
        index=host.index,
    )


def _grouped(flags: Sequence[bool]) -> list[tuple[bool, int, int]]:
    """`flags` as maximal runs: `(value, start, stop)`, `stop` exclusive."""
    out: list[tuple[bool, int, int]] = []
    for position, flag in enumerate(flags):
        if out and out[-1][0] == flag:
            value, start, _stop = out[-1]
            out[-1] = (value, start, position + 1)
        else:
            out.append((flag, position, position + 1))
    return out


def _runs(flags: Sequence[bool]) -> int:
    """How many separate aside GROUPS a line has (two trailing words of one group are one group)."""
    return sum(1 for value, _start, _stop in _grouped(flags) if value)


def _listed(indexes: Sequence[int]) -> str:
    return ", ".join(str(index) for index in indexes)
