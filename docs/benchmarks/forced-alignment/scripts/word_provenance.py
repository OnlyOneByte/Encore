"""Price every word two bench runs disagree about: did its PUBLISHED start move toward truth or away?

    .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/word_provenance.py \
        $ENCORE_BENCH_ROOT/_runs/w8a-def-ra $ENCORE_BENCH_ROOT/_runs/w8ar2-arms-ra --modes truth,jit

Moving words between the aligned and the interpolated column raises every ALIGNED-only accuracy metric by
dropping words out of its denominator, so telling bookkeeping from a regression means reading the words. Two
recorded run directories (`rows.jsonl` + `media/` + `run.json`) are all this needs, so it costs no model
time. Exits 1 when a published start moved further from truth (`--allow-worse` budgets some), 2 when a pair
cannot be read — including two runs whose own `run.json` says they measured different jobs.
LOG.md, "W8b: re-judging `word-aligned-not-down`".
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import e2e_gates as gates  # noqa: E402
import e2e_lib as lib  # noqa: E402

#: A published start this close to the other run's is the same number, not a move (the documents carry ms).
SAME_START_SEC = 1e-6


class UnreadablePair(ValueError):
    """Two runs whose rows cannot be compared word by word. Reported, never guessed around."""


@dataclass(frozen=True, slots=True)
class WordChange:
    """One word two runs publish differently, with both published starts priced against truth."""

    mode: str
    song: str
    variant: int
    position: int
    index: int
    text: str
    base_start: float
    arms_start: float
    truth_start: float
    base_aligned: bool
    arms_aligned: bool

    @property
    def base_error(self) -> float:
        return self.base_start - self.truth_start

    @property
    def arms_error(self) -> float:
        return self.arms_start - self.truth_start

    @property
    def reprovenanced(self) -> bool:
        return self.base_aligned != self.arms_aligned

    @property
    def verdict(self) -> str:
        gap = abs(self.arms_error) - abs(self.base_error)
        return "worse" if gap > SAME_START_SEC else "better" if gap < -SAME_START_SEC else "equal"


def truth_positions(
    row: Mapping[str, Any], lines: Sequence[Mapping[str, Any]], song: lib.Song
) -> dict[int, int]:
    """Published line position -> truth index, recovered from the row's own `line_errors`.

    The harness pairs lines by identity through a capture it does not record, but it DOES record each paired
    line's truth index and signed start error, in published order — which pins the position exactly.
    """
    out: dict[int, int] = {}
    position = 0
    for entry in row["line_errors"]:
        truth_index, error = int(entry[0]), float(entry[1])
        want = song.truth[truth_index].start + error
        while position < len(lines):
            if abs(float(lines[position]["start"]) - want) < SAME_START_SEC:
                out[position] = truth_index
                position += 1
                break
            position += 1
        else:
            raise UnreadablePair(f"{row['song']}/{row['mode']}: line_errors entry {truth_index} has no line")
    return out


def _normalized(text: str) -> str:
    return "".join(c for c in text.lower() if c.isalnum())


def word_offsets(song: lib.Song) -> list[int]:
    """Where each truth line's words start in `Song.words`."""
    offsets = [0]
    for line in song.truth:
        offsets.append(offsets[-1] + len(line.text.split()))
    return offsets


def _lead(published: Sequence[Mapping[str, Any]], tokens: Sequence[str], where: str) -> int:
    """How many leading published words are NOT truth words (a header label), or raise.

    `score_words` learns this from the claim; here it is read off the text, which also proves the pairing:
    the truth tokens must be the line's LAST `len(tokens)` published words.
    """
    lead = len(published) - len(tokens)
    if lead < 0:
        raise UnreadablePair(f"{where}: {len(published)} published words for {len(tokens)} truth words")
    said = [_normalized(str(w.get("word") or "")) for w in published[lead:]]
    if said != [_normalized(t) for t in tokens]:
        raise UnreadablePair(f"{where}: published words {said} are not the truth line's {list(tokens)}")
    return lead


def _doc_lines(run: Path, ref: str) -> list[dict[str, Any]]:
    loaded = json.loads((run / "media" / ref).read_text(encoding="utf-8"))
    return [line for line in loaded["lines"] if isinstance(line, dict)]


def _aligned(word: Mapping[str, Any]) -> bool:
    """A published word's provenance, from the document alone — `e2e.py`'s `_scored`."""
    return float(word.get("score") or 0.0) != 0.0


def _rows(run: Path) -> dict[tuple[str, str, int], dict[str, Any]]:
    return {(str(r["song"]), str(r["mode"]), int(r["variant"])): r for r in lib.read_rows(run / "rows.jsonl")}


def _same_setup(base_run: Path, arms_run: Path) -> None:
    """Both runs measured the same JOB, or raise: `e2e_gates.SETUP_META` over their own `run.json`.

    An arm is a difference in `align_config` and in the tree (`COMPARED_META`); a difference in level, seed,
    wrong_k, audio or sync mode is a different measurement, and pairing two of those reports "no word moved"
    on rows that were never comparable. `e2e_gates.py`'s rule for it: an ERROR, not a warning.
    """
    meta: list[Mapping[str, Any]] = []
    for run in (base_run, arms_run):
        config = run / "run.json"
        if not config.is_file():
            raise UnreadablePair(f"{run.name} has no run.json, so nothing says what setup it measured")
        loaded = json.loads(config.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise UnreadablePair(f"{run.name}/run.json is not a run record")
        meta.append(loaded)
    if differs := gates.setup_mismatch(meta[1], meta[0]):
        raise UnreadablePair(f"{arms_run.name} against {base_run.name}: {'; '.join(differs)}")


def _require_same_rows(
    base_run: Path,
    base_rows: Mapping[tuple[str, str, int], Any],
    arms_run: Path,
    arms_rows: Mapping[tuple[str, str, int], Any],
    modes: Sequence[str] | None,
) -> None:
    """Both runs measured the same (song, mode, variant) rows, or raise.

    A row one run never produced used to be skipped exactly like a filtered mode, so a run killed partway
    through compared its finished modes and reported "no word moved further from truth" for the rest.
    """
    wanted = None if modes is None else set(modes)
    base_keys = {key for key in base_rows if wanted is None or key[1] in wanted}
    arms_keys = {key for key in arms_rows if wanted is None or key[1] in wanted}
    for side, lost in ((arms_run, base_keys - arms_keys), (base_run, arms_keys - base_keys)):
        if lost:
            named = ", ".join(f"{song}/{mode}/{variant}" for song, mode, variant in sorted(lost)[:5])
            raise UnreadablePair(f"{side.name} is missing {len(lost)} compared row(s): {named}")


def changes(
    base_run: Path,
    arms_run: Path,
    songs: Mapping[str, lib.Song],
    *,
    modes: Sequence[str] | None = None,
) -> list[WordChange]:
    """Every word the two runs publish at a different start or with a different provenance."""
    base_rows, arms_rows = _rows(base_run), _rows(arms_run)
    for run, rows in ((base_run, base_rows), (arms_run, arms_rows)):
        if modes is not None and (absent := set(modes) - {key[1] for key in rows}):
            raise UnreadablePair(f"{run.name} measured no such mode: {', '.join(sorted(absent))}")
    _require_same_rows(base_run, base_rows, arms_run, arms_rows, modes)
    out: list[WordChange] = []
    for key, base in sorted(base_rows.items()):
        song_slug, mode, variant = key
        if modes is not None and mode not in modes:
            continue
        arms = arms_rows[key]
        if base["doc_sha256"] == arms["doc_sha256"] or not base.get("words"):
            continue
        if (song := songs.get(song_slug)) is None:
            raise UnreadablePair(f"{song_slug}: not in the corpus this is being read against")
        if song.words is None:
            continue
        base_doc, arms_doc = _doc_lines(base_run, base["ref"]), _doc_lines(arms_run, arms["ref"])
        if [line["text"] for line in base_doc] != [line["text"] for line in arms_doc]:
            raise UnreadablePair(f"{song_slug}/{mode}: the two runs published different text")
        offsets = word_offsets(song)
        paired = truth_positions(base, base_doc, song)
        for position, (base_line, arms_line) in enumerate(zip(base_doc, arms_doc, strict=True)):
            truth_index = paired.get(position)
            base_words = base_line.get("words") or []
            arms_words = arms_line.get("words") or []
            if truth_index is None:
                continue
            where = f"{song_slug}/{mode} line {position}"
            if len(base_words) != len(arms_words):
                raise UnreadablePair(f"{where}: {len(base_words)} words against {len(arms_words)}")
            tokens = song.truth[truth_index].text.split()
            lead = _lead(base_words, tokens, where)
            if _lead(arms_words, tokens, where) != lead:
                raise UnreadablePair(f"{where}: the two runs published the truth words at different offsets")
            for index in range(len(tokens)):
                base_word, arms_word = base_words[lead + index], arms_words[lead + index]
                moved = abs(float(base_word["start"]) - float(arms_word["start"])) > SAME_START_SEC
                if not moved and _aligned(base_word) == _aligned(arms_word):
                    continue
                out.append(
                    WordChange(
                        mode=mode,
                        song=song_slug,
                        variant=variant,
                        position=position,
                        index=index,
                        text=str(base_word.get("word") or ""),
                        base_start=float(base_word["start"]),
                        arms_start=float(arms_word["start"]),
                        truth_start=song.words[offsets[truth_index] + index].start,
                        base_aligned=_aligned(base_word),
                        arms_aligned=_aligned(arms_word),
                    )
                )
    return out


def report(found: Sequence[WordChange]) -> str:
    """The per-word table, then a tally per mode x verdict and the provenance split."""
    rows = [
        f"{c.mode:<11} {c.song[:26]:<26} L{c.position:>3} W{c.index:>2} {c.text!r:>14}"
        f" {c.base_start:8.3f}->{c.arms_start:8.3f}"
        f" |err| {abs(c.base_error) * 1000:7.1f}->{abs(c.arms_error) * 1000:7.1f} ms"
        f" {'reprovenanced' if c.reprovenanced else 'retimed':<13} {c.verdict}"
        for c in found
    ]
    tally = Counter((c.mode, c.verdict) for c in found)
    rows += ["", "tally"]
    rows += [f"  {mode:<11} {verdict:<7} {n}" for (mode, verdict), n in sorted(tally.items())]
    totals = Counter(c.verdict for c in found)
    reprovenanced = Counter(c.verdict for c in found if c.reprovenanced)
    rows += [
        f"  {'TOTAL':<11} " + "  ".join(f"{v} {totals[v]}" for v in ("better", "equal", "worse")),
        f"  {'of them reprovenanced':<11} "
        + "  ".join(f"{v} {reprovenanced[v]}" for v in ("better", "equal", "worse")),
    ]
    return "\n".join(rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("base", type=Path, help="the run directory published without the change")
    parser.add_argument("arms", type=Path, help="the run directory published with it")
    parser.add_argument("--modes", help="comma-separated claim modes (default: every mode both runs carry)")
    parser.add_argument("--allow-worse", type=int, default=0, help="words that may move further from truth")
    args = parser.parse_args(argv)
    songs = {song.slug: song for song in lib.discover(lib.bench_root())}
    try:
        _same_setup(args.base, args.arms)
        found = changes(args.base, args.arms, songs, modes=args.modes.split(",") if args.modes else None)
    except UnreadablePair as error:
        print(f"UNREADABLE: {error}")
        return 2
    print(report(found))
    worse = sum(1 for c in found if c.verdict == "worse")
    if worse > args.allow_worse:
        print(f"\nFAIL: {worse} word(s) moved further from truth, budget {args.allow_worse}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
