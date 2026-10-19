"""Ad-libs and echo tails: the words the LEAD voice is not singing. DEFAULT-OFF (the `adlibs` arm).

A backing vocal is not in order with the lead, so the one monotone CTC path must spend frames on its
characters somewhere, and the damage lands on everything AFTER it. Two anchored rules hold those words out
of the lead's target sequence and time them inside their host line afterwards, as labelled interpolations.

Both rules, the measured refusal behind the echo rule's "alone" clause, the interpolation policy and why
there is no second decode inside the gap: `docs/arch/04-alignment.md` §8, §12 (XA-08) and §13. README,
"W5: ad-libs (§3.13) — BUILT, MEASURED ON THE CORPUS, AND IT DOES NOT GENERALISE", holds the reach and the
A/B that failed the arm's bar.
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
from encore_worker.domain.lyrics.units import Rules

#: The most of its host's words an echo tail may repeat before it reads as a lyric line of its own. Measured
#: on the corpus's own echoes, 1-3 words against hosts of 4-9: all 23 are caught and a near-complete repeat
#: is still refused, being a REPEATED LYRIC and the ladder's business (docs/arch/04-alignment.md §8).
MAX_ECHO_SHARE = 0.5

_LETTER = re.compile(r"[^\W\d_]", re.UNICODE)


@dataclass(frozen=True, slots=True)
class Host:
    """One line as the LEAD decode sees it, and as it will be PUBLISHED.

    `words` is the publication word list and `aside` is parallel to it, so `lead.split()` and the False
    positions of `aside` are the same list by construction — which is what makes `restored`'s pairing exact.
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
    """The split that takes NOTHING out: what the default path uses, so the arm is one expression in
    `align_steps` rather than a branch around every decode."""
    return Split(lead_texts=tuple(line_texts), hosts={})


def split(line_texts: Sequence[str], *, emissions: Any | None = None, units: Rules | None = None) -> Split:
    """Take the ad-libs out of `line_texts` (R1, R2) without changing one published word.

    The returned `lead_texts` is PARALLEL to the input, every consumer pairing on position. `emissions` IS THE
    MATRIX THE LEAD DECODE WILL RUN ON, and R1 reads its DICTIONARY: as a LETTER test "something is left to
    align" let the ARM LOSE A LINE the default path publishes. `units` IS THE ATTEMPT'S OWN UNIT RULE, so the
    words this pairs on and the targets it counts are the decode's (docs/arch/04-alignment.md §9.1).
    """
    alignable = _alignable_with(emissions, units)
    words = [tuple(units.words(text)) if units is not None else tuple(text.split()) for text in line_texts]
    aside = [_aside_flags(line, alignable) for line in words]
    #: A line nothing was taken out of keeps its text BYTE-IDENTICALLY, never the re-joined tokens: re-joining
    #: silently rewrote the whitespace of 7 published lines on one measured song.
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

    The HOST CHAIN is computed before any refusal, so the rule is a function of the text rather than of the
    order the refusals happened in.
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

    `generated` must be the decode of `split_of.lead_texts`, and this returns it UNCHANGED when nothing was
    taken out. `until` is the recording's end, the only bound a trailing aside on the LAST line has.
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
            # AN ECHO WHOSE HOST WAS NOT PUBLISHED GOES WITH IT, its host's measurement being the only thing
            # that places it. Restoring it anyway parked a published line at the document FLOOR spanning the
            # whole lead-in, with a score of 0.0 — impossibly GOOD on a log-probability scale, and it entered
            # the never-sung rule's median as one. No measurement, no line.
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
            # ITS HOST'S SCORE, because its host's measurement is what placed it. Not 0.0, which is
            # impossibly GOOD against the song's median and would exempt every echo from two rules.
            line = _line_of(host, words, score=anchor.score)
        out.append(line)
        emitted[index] = line
    return Generated(lines=tuple(out), language=generated.language)


def unmeasured_lines(generated: Generated) -> frozenset[int]:
    """Indexes of lines NO word of which the decode placed: every R2 echo, AND every claim-ADOPTED line.

    THE SECOND HALF IS NOT THIS MODULE'S AND IS NOT ARM-ONLY — a line nothing measured is a line nothing
    measured, whichever rule invented its words — and it costs no behaviour, the one reader grading an
    adopted line `low` regardless. Read off the document, so a line the ladder re-decoded is not reported.
    """
    return frozenset(
        line.index
        for line in generated.lines
        if line.words and not any(word.provenance == "aligned" for word in line.words)
    )


def _alignable_with(emissions: Any | None, units: Rules | None = None) -> Callable[[str], bool]:
    """ "Can the lead decode align anything in this text?" — read off the MATRIX when there is one, through
    the attempt's own unit rule, so the question R1 asks is exactly the question `generate` will answer; else
    the letter test."""
    if emissions is None:
        return lambda text: bool(_LETTER.search(text))
    return lambda text: alignable_chars(text, emissions, units) > 0


def _aside_flags(words: Sequence[str], alignable: Callable[[str], bool]) -> tuple[bool, ...]:
    """R1, on TOKENS: True for every word a mid-line or trailing parenthetical owns.

    Token-anchored on purpose, a group starting inside a token making the published word list and the lead
    decode's disagree about what a word IS; such a line is left whole (0 in the bench corpus). An UNBALANCED
    line marks nothing, the group never closing.
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

    THE LAST CONDITION WAS MEASURED, not foreseen: a token count read `♪ ♪` as a lead line and dropped six
    published lines of one song. A decoration is not a lead, and neither is a word the DICTIONARY lacks.
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
    """R2: is `lead` a short echo of the TAIL of `host_lead`? Compared on `policy.normalised_words`, the form
    this package already compares two texts in, so the rule gains no fourth definition of "the same word"."""
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

    Consumed IN ORDER against the False positions of `host.aside`; a mismatch means `generated` is the decode
    of some other text, which is a caller bug rather than an input.
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
    """`words` apportioned across `[low, high]` by CHARACTER COUNT, zero-width when there is no room — not
    evenly, or a two-word aside and a ten-word one would get the same span (docs/arch/04-alignment.md §8)."""
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
