"""The code points at `docs/` instead of carrying it, so the pointers are checked.

A cited path is load-bearing since the 2026-10-01 directive: a reader who follows it and finds nothing has
lost the measurement or the failure account that used to be inline, and nothing at runtime can notice. Nine
rules — the paths resolve, a cited SECTION NUMBER names a heading that exists, a cited SECTION TITLE names a
heading or a bold lead-in, every `§N` in prose is ANCHORED to a committed document rather than to the
gitignored review, a cited "`module`'s NAME section" is text that module carries, no citation leads to a
GITIGNORED working document, the design documents are not stubs, and both indexes link them.

The rules read `CODE_ROOTS`: the package, both bench harnesses and the tests; the anchor rule reads fewer and
says which and why (`ANCHOR_ROOTS`). A path failure FAILS rather than skips — a skip reads as satisfied.
"""

from __future__ import annotations

import ast
import io
import re
import shutil
import subprocess
import tokenize
from collections.abc import Callable, Mapping
from pathlib import Path

import pytest

#: A `docs/...`-rooted path as the prose writes one: in backticks, in a link, or bare in a sentence.
#: Trailing sentence punctuation is trimmed by the caller, not by the pattern, so a path ending in `)`
#: inside a Markdown-style link is still matched.
DOCS_PATH = re.compile(r"docs/[A-Za-z0-9_./*-]+")

#: Pointers that name a GLOB or a family rather than one file; checked as "the directory exists".
GLOB_CHARS = "*?["

#: GITIGNORED by design, so a fresh clone does not have them: citing one from shipped code points a reader
#: at nothing. Named rather than detected, because `.gitignore` parsing is its own defect surface.
WORKING_DOCUMENTS = frozenset(
    {
        "docs/PLAN-alignment-v2.md",
        "docs/PLAN-alignment-v3.md",
        "docs/REVIEW-alignment-v2.md",
        "docs/UI-REVIEW.md",
    }
)

#: EMPTY, and that is the finished state: the one entry this held (`docs/PLAN-alignment-v2.md`, cited by
#: `generate.py` for the inversion) was re-pointed at `docs/arch/04-alignment.md` §1 in W7c. An entry nobody
#: cites any more is a stale exemption and fails below, so this set can only shrink.
EXEMPT_CITATIONS: frozenset[str] = frozenset()

ALIGNMENT_DOC = "docs/arch/04-alignment.md"
WORKER_DOC = "docs/arch/05-worker.md"

#: Every root whose prose carries pointers: the package, BOTH committed bench harnesses, and the worker's own
#: tests — which W7c swept into `docs/` and whose pointers no rule read until this wave, the population being
#: `MIN_TEST_POINTERS` below (W7c review r1-correctness-5, r2-correctness-5).
CODE_ROOTS = (
    "worker/encore_worker",
    "docs/benchmarks/forced-alignment/scripts",
    "docs/benchmarks/stem-separation/scripts",
    "worker/tests",
)

#: What `worker/tests` cites of its own, read off the shipped tree as the rules read it — OCCURRENCES, which
#: is the denominator that was never stated: 72 `docs/` paths over 19 distinct, 26 `path §N`, 8 README titles.
#: A floor, so widening the roots cannot be undone quietly (docs/arch/05-worker.md §12).
MIN_TEST_POINTERS = {"paths": 72, "distinct_paths": 19, "sections": 26, "titles": 8}

#: The ANCHOR rule's roots, which are NOT all of them — named here because an unstated exclusion is the defect
#: this wave's review found: `worker/tests` still carries bare `review §N` marks, held down by
#: `UNANCHORED_IN_TESTS` until a wave re-points them.
ANCHOR_ROOTS = tuple(root for root in CODE_ROOTS if root != "worker/tests")

#: The file that DECLARES the gitignored working documents, and so names them without pointing at them.
DECLARING_MODULE = "worker/tests/test_docs_pointers.py"


def _repo_root() -> Path:
    """Walked up to rather than counted down from, so this survives the worker moving."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "worker" / "encore_worker").is_dir() and (parent / "docs").is_dir():
            return parent
    raise AssertionError(
        f"could not find the repo root above {here}: no parent holds both worker/encore_worker and docs/. "
        "This is a PATH failure, not a satisfied invariant. Do not convert it into a skip."
    )


@pytest.fixture(scope="module")
def repo() -> Path:
    return _repo_root()


def _cited_paths(repo: Path) -> dict[str, list[str]]:
    """`{cited docs/ path: the files citing it}` over the package and the bench harness."""
    found: dict[str, list[str]] = {}
    for root in CODE_ROOTS:
        for source in sorted((repo / root).rglob("*.py")):
            text = source.read_text(encoding="utf-8")
            for raw in DOCS_PATH.findall(text):
                cited = raw.rstrip(".,;:)`'\"")
                found.setdefault(cited, []).append(str(source.relative_to(repo)))
    return found


def test_every_docs_path_the_code_cites_resolves(repo: Path) -> None:
    cited = _cited_paths(repo)
    assert cited, "no docs/ path is cited anywhere in the worker — the pointer idiom has been lost"
    missing = {
        path: sorted(set(citers))
        for path, citers in cited.items()
        if path not in WORKING_DOCUMENTS and not _resolves(repo / path)
    }
    assert not missing, "the worker cites docs/ paths that do not exist: " + "; ".join(
        f"{path} (from {', '.join(citers)})" for path, citers in sorted(missing.items())
    )


#: `docs/arch/04-alignment.md §5.3` — a path, then a section number the cited document must hold a heading
#: for. Section numbers rather than GitHub anchors, whose rules mangle the em-dashes these headings carry. The
#: separator allows a wrapped line and a comment marker; `MIN_SECTION_CITATIONS` keeps that relaxation honest.
SECTION_CITATION = re.compile(
    r"(docs/[A-Za-z0-9_./-]+\.md)`?[ \t]*(?:\n[ \t]*#*:?[ \t]*)?§([0-9]+(?:\.[0-9]+)?)"
)
#: 328 `path §N` citations matched when the roots widened to the tests and the second harness, so the floor
#: moved with the population: a floor far under it would let the pattern stop reading most of the tree.
MIN_SECTION_CITATIONS = 250


def _section_citations(repo: Path) -> dict[tuple[str, str], list[str]]:
    """`{(cited doc, section number): the files citing it}` over the package and the bench harness."""
    found: dict[tuple[str, str], list[str]] = {}
    for root in CODE_ROOTS:
        for source in sorted((repo / root).rglob("*.py")):
            for doc, section in SECTION_CITATION.findall(source.read_text(encoding="utf-8")):
                found.setdefault((doc, section), []).append(str(source.relative_to(repo)))
    return found


def test_the_section_citation_pattern_still_matches_the_tree(repo: Path) -> None:
    """A relaxed pattern that matched LESS would turn every section pointer into an unchecked one."""
    total = sum(len(citers) for citers in _section_citations(repo).values())
    assert total >= MIN_SECTION_CITATIONS, (
        f"only {total} `path §N` citations matched, under the {MIN_SECTION_CITATIONS} floor. Either the "
        "pointer idiom is being dropped or SECTION_CITATION has stopped reading it."
    )


def _section_numbers(text: str) -> set[str]:
    """Every section number a Markdown document's headings declare, e.g. `## 5.` and `### 5.3`."""
    return {
        match.group(1)
        for match in re.finditer(r"^#{2,4} ([0-9]+(?:\.[0-9]+)?)[.) ]", text, flags=re.MULTILINE)
    }


def test_every_cited_section_number_names_a_heading_that_exists(repo: Path) -> None:
    cited = _section_citations(repo)
    assert cited, "nothing cites a docs/ section any more — the `path §N` pointer idiom has been lost"
    missing: dict[tuple[str, str], list[str]] = {}
    for (doc, section), citers in cited.items():
        path = repo / doc
        if not path.is_file() or section not in _section_numbers(path.read_text(encoding="utf-8")):
            missing[(doc, section)] = sorted(set(citers))
    assert not missing, "the worker cites docs/ sections that do not exist: " + "; ".join(
        f"{doc} §{section} (from {', '.join(citers)})" for (doc, section), citers in sorted(missing.items())
    )


#: `LOG.md, "The claim clock's own exhibits"` — the other half of the pointer idiom, and the commoner half,
#: since a measurement log is organised by TITLE rather than by number. The quoted run must be a heading or
#: a bold lead-in of the document the citation NAMES; a typo'd, renamed or moved title matches nothing.
TITLE_CITATION = re.compile(r'(?P<doc>README(?:\.md)?|LOG\.md)`?[^"\n]{0,12}?"(?P<title>[^"]{8,120})"')

#: The forced-alignment measurement log. A `LOG.md, "..."` citation is looked up in it alone, and a
#: `README, "..."` one never is: a title that moved into the log with its pointer still saying README fails.
LOG_DOC = "docs/benchmarks/forced-alignment/LOG.md"

#: Where a `README` title may live. `README` alone is ambiguous between the measurement README and the
#: worker's, so all of them are searched: what this rule is for is a title that exists NOWHERE in them.
TITLE_DOCS = (
    "docs/benchmarks/forced-alignment/README.md",
    "docs/benchmarks/stem-separation/README.md",
    "docs/arch/04-alignment.md",
    "docs/arch/05-worker.md",
    "worker/README.md",
)


def _prose_of(source: str) -> str:
    """Every docstring and comment of a module, whitespace collapsed — a title may span a wrapped line.

    Comment markers are stripped first, or a `#: ` in the middle of a wrapped title would be read as part of
    it and no title cited from an attribute comment could ever resolve.
    """
    parts: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
            if isinstance(node.value.value, str):
                parts.append(node.value.value)
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT:
            parts.append(re.sub(r"^#:?\s?", "", token.string))
    return re.sub(r"\s+", " ", " ".join(parts))


def _doc_titles(repo: Path, docs: tuple[str, ...]) -> list[str]:
    """Every heading and every bold lead-in of `docs`, lowercased."""
    titles: list[str] = []
    for doc in docs:
        text = (repo / doc).read_text(encoding="utf-8")
        titles += [match.group(1).strip().lower() for match in re.finditer(r"^#{2,4}\s+(.*)$", text, re.M)]
        titles += [match.group(1).strip().lower() for match in re.finditer(r"\*\*([^*\n]{8,160})\*\*", text)]
    return titles


#: The non-Python files that carry title pointers: the design documents and the gate files beside the log.
TITLE_POINTER_DOCS = ("docs/arch/*.md", "docs/benchmarks/forced-alignment/gates/*.yaml")


def _doc_prose(text: str) -> str:
    """A Markdown or YAML file as one line: `#` comment and `>` quote markers stripped, so a wrapped title
    still reads whole."""
    return re.sub(r"\s+", " ", re.sub(r"(?m)^\s*(?:#+|>)[ \t]?", "", text))


def _title_citations(repo: Path) -> dict[tuple[str, str], list[str]]:
    """`{(cited doc, title): the files citing it}` over the code roots and `TITLE_POINTER_DOCS`."""
    sources: list[tuple[Path, Callable[[str], str]]] = [
        (path, _prose_of) for root in CODE_ROOTS for path in sorted((repo / root).rglob("*.py"))
    ]
    sources += [(path, _doc_prose) for pattern in TITLE_POINTER_DOCS for path in sorted(repo.glob(pattern))]
    cited: dict[tuple[str, str], list[str]] = {}
    for path, prose in sources:
        for match in TITLE_CITATION.finditer(prose(path.read_text(encoding="utf-8"))):
            doc = "LOG.md" if match.group("doc") == "LOG.md" else "README"
            cited.setdefault((doc, match.group("title").strip()), []).append(str(path.relative_to(repo)))
    return cited


def test_every_cited_section_title_names_a_heading_or_a_lead_in(repo: Path) -> None:
    titles = {"README": _doc_titles(repo, TITLE_DOCS), "LOG.md": _doc_titles(repo, (LOG_DOC,))}
    assert len(titles["LOG.md"]) > 200, f"only {len(titles['LOG.md'])} titles found in {LOG_DOC}"
    cited = _title_citations(repo)
    assert len(cited) > 20, f"only {len(cited)} section titles are cited — the pointer idiom has gone"
    assert any(citer.endswith(".yaml") for citers in cited.values() for citer in citers), (
        "no gate file's title pointer was read — TITLE_POINTER_DOCS has stopped matching"
    )
    missing = {
        (doc, title): sorted(set(citers))
        for (doc, title), citers in cited.items()
        if not any(title.lower() in known for known in titles[doc])
    }
    assert not missing, "these cite a section the named document does not hold: " + "; ".join(
        f'{doc}, "{title}" (from {", ".join(citers)})' for (doc, title), citers in sorted(missing.items())
    )


#: How far back a `§N` may look for the committed document it belongs to. Prose wraps and a citation often
#: reads "docs/arch/04-alignment.md — §3 the engines, §4 repair, §5 the gates", so the anchor is per SENTENCE
#: rather than per section mark.
ANCHOR_LOOKBACK = 200

#: What anchors a `§N`: a committed Markdown path, or a `README` whose own titles rule 3 already checks.
SECTION_ANCHOR = re.compile(r"docs/[A-Za-z0-9_./-]+\.md|README")


def _every_line_of(source: str) -> str:
    """The WHOLE module, comment markers stripped and whitespace collapsed — prose and code alike.

    `_prose_of` is the wrong input for the anchor rule: a `§` inside a runtime STRING is CODE to `ast`, so the
    five silence sentences of `align_notes._margin_why` shipped `review §3.7` on the job's audit trail with
    this invariant green (W7b review r2-correctness-3). The trail is read by an operator who has no document
    to resolve a citation against, which makes it the worst place of all for a bare section mark.
    """
    return re.sub(r"\s+", " ", re.sub(r"(?m)^(\s*)#:?[ \t]?", r"\1", source))


def test_every_section_mark_is_anchored_to_a_committed_document(repo: Path) -> None:
    """A bare `§N` means the GITIGNORED review to whoever wrote it and nothing at all to a fresh clone.

    This is the half `test_no_citation_leads_to_a_gitignored_working_document` cannot see: a pointer naming
    no path at all. `review §3.4` and `§3.10's star` both point at `docs/REVIEW-alignment-v2.md`, which is
    not in the repository — so the number, the reject-if or the technique behind the sentence is unreachable.
    """
    unanchored = _unanchored_marks(repo, ANCHOR_ROOTS)
    assert not unanchored, "these `§N` pointers name no committed document: " + "; ".join(
        f"{path} (…{', …'.join(quotes)})" for path, quotes in sorted(unanchored.items())
    )


def _unanchored_marks(repo: Path, roots: tuple[str, ...]) -> dict[str, list[str]]:
    """`{file: the quoted neighbourhood of each `§` that names no committed document}`.

    `DECLARING_MODULE` is skipped for the reason the working-document rule skips it: the § marks in this file
    are the patterns and the prose ABOUT the form, not pointers written in it.
    """
    unanchored: dict[str, list[str]] = {}
    for root in roots:
        for source in sorted((repo / root).rglob("*.py")):
            if str(source.relative_to(repo)) == DECLARING_MODULE:
                continue
            text = _every_line_of(source.read_text(encoding="utf-8"))
            for mark in re.finditer("§", text):
                before = text[max(0, mark.start() - ANCHOR_LOOKBACK) : mark.start()]
                if not SECTION_ANCHOR.search(before):
                    quoted = text[max(0, mark.start() - 60) : mark.start() + 20]
                    unanchored.setdefault(str(source.relative_to(repo)), []).append(quoted)
    return unanchored


#: Bare `§N` marks left in `worker/tests` (W7c re-pointed 7 of 36 at the committed section they meant; each
#: of the 29 left names an item of the gitignored review — docs/arch/05-worker.md §12's open item). A RATCHET:
#: the count may only fall, and at zero the exclusion and its test go.
UNANCHORED_IN_TESTS = 29


def test_the_anchor_rules_one_exclusion_is_named_and_can_only_shrink(repo: Path) -> None:
    """An unstated exclusion is how a rule comes to claim coverage it has not got (W7c r1-correctness-5).

    So the one root the anchor rule skips is named, counted, and held to a bound that cannot grow: a NEW bare
    `review §N` in a test arrives as a failure, and the day the last one is re-pointed this test says so.
    """
    assert set(ANCHOR_ROOTS) == set(CODE_ROOTS) - {"worker/tests"}
    left = _unanchored_marks(repo, ("worker/tests",))
    total = sum(len(quotes) for quotes in left.values())
    assert total <= UNANCHORED_IN_TESTS, (
        f"worker/tests has gained a bare `§N`: {total} marks against the {UNANCHORED_IN_TESTS} this "
        f"exclusion was measured at. Point it at a committed document instead. Files: {sorted(left)[:3]}"
    )
    assert total, (
        "every `§N` in worker/tests is anchored now: delete UNANCHORED_IN_TESTS and this test, and let "
        "ANCHOR_ROOTS be CODE_ROOTS — an exclusion nobody needs reads as a defect that is still open."
    )


def test_the_anchor_rule_reads_a_section_mark_that_is_code_rather_than_prose(repo: Path) -> None:
    """The non-vacuity floor for the rule above, written as the bug it missed.

    `_prose_of` could not see this module and neither could the rule; a scan that silently stopped covering
    runtime strings would look exactly like a tree with none in it.
    """
    source = 'NOTE = {"why": "grading is as it was before review §3.7"}\n'
    assert "§" in _every_line_of(source), "a section mark inside a CODE string must still be scanned"
    assert "§" not in _prose_of(source), "the regression this guards: `ast` reads that string as code"


#: ``the populations are in `lexical`'s MIX section`` — the pointer form that broke in W7b, when the cleanup
#: deleted the very section two comments cited. A module is not a document and has no stable section names, so
#: the rule is the weakest one that catches it: the NAME must still appear in that module's own prose.
MODULE_SECTION = re.compile(r"`([a-z_][a-z_0-9.]*)`'s ([A-Z][A-Z_ ]{2,}) section")


def _module_section_citations(repo: Path) -> list[tuple[str, str, str]]:
    """`(citing file, cited module, cited NAME)` for every citation of the form above.

    `DECLARING_MODULE` is skipped: it writes the form twice on purpose — in the rule's own description and in
    the probe below that proves the pattern still reads it.
    """
    found: list[tuple[str, str, str]] = []
    for root in CODE_ROOTS:
        for source in sorted((repo / root).rglob("*.py")):
            if str(source.relative_to(repo)) == DECLARING_MODULE:
                continue
            prose = _prose_of(source.read_text(encoding="utf-8"))
            for module, name in MODULE_SECTION.findall(prose):
                found.append((str(source.relative_to(repo)), module, name.strip()))
    return found


def test_every_cited_module_section_is_text_that_module_still_carries(repo: Path) -> None:
    missing: dict[str, list[str]] = {}
    for where, module, name in _module_section_citations(repo):
        targets = _modules_named(repo, module)
        if not targets:
            missing.setdefault(where, []).append(f"{module} (no such module)")
        elif len(targets) > 1:
            named = ", ".join(str(path.relative_to(repo)) for path in targets)
            missing.setdefault(where, []).append(f"{module} is ambiguous between {named} — write it dotted")
        elif name not in _prose_of(targets[0].read_text(encoding="utf-8")):
            missing.setdefault(where, []).append(f"{module}'s {name}")
    assert not missing, (
        "these cite a section of another MODULE that is no longer there — point at a docs/ path instead: "
        + "; ".join(f"{path} ({', '.join(names)})" for path, names in sorted(missing.items()))
    )


def test_the_module_section_rule_would_still_catch_one(repo: Path) -> None:
    """The form is EXTINCT in this tree — zero citations — so the rule above asserts over an empty loop.

    Every other rule here carries a non-vacuity floor (`MIN_SECTION_CITATIONS`, `len(cited) > 20`,
    `len(titles) > 200`) for the stated reason that a pattern which stops matching must not hide behind "no
    failures". A floor is impossible at zero, so the pattern and the resolver are exercised directly instead,
    and the count is pinned so a NEW citation of this shape arrives as a failing test rather than as an
    unchecked pointer (W7b review r2-correctness-4).
    """
    assert _module_section_citations(repo) == [], (
        "someone has written a `module`'s NAME section pointer again. Either point at a docs/ path instead, "
        "or delete this assertion and let the rule above carry it."
    )
    probe = "#: the populations are in `lexical`'s MIX section, and more\n"
    assert MODULE_SECTION.findall(_prose_of(probe)) == [("lexical", "MIX")], (
        "MODULE_SECTION no longer reads the form it exists for"
    )
    assert _modules_named(repo, "lexical") == [repo / "worker/encore_worker/domain/lyrics/lexical.py"]
    assert _modules_named(repo, "no_such_module_anywhere") == []
    #: `ports` is the live ambiguity: `artifacts/ports.py` and `adapters/ports.py` are different protocols.
    assert len(_modules_named(repo, "ports")) == 2, "the bare-stem ambiguity this resolver must not hide"
    assert _modules_named(repo, "artifacts.ports") == [repo / "worker/encore_worker/artifacts/ports.py"]


def _modules_named(repo: Path, dotted: str) -> list[Path]:
    """EVERY module a prose citation could mean, matched as a dotted PATH SUFFIX over `CODE_ROOTS`.

    All of them rather than the first, because a bare stem can be ambiguous — `ports` is both
    `artifacts/ports.py` and `adapters/ports.py`, two unrelated protocols — and silently resolving to
    whichever sorts first would check the wrong file's prose and pass.
    """
    parts = [part for part in dotted.rstrip(".").split(".") if part]
    if not parts:
        return []
    suffix = "/".join(parts) + ".py"
    found: list[Path] = []
    for root in CODE_ROOTS:
        for candidate in sorted((repo / root).rglob(f"{parts[-1]}.py")):
            if candidate.as_posix().endswith("/" + suffix):
                found.append(candidate)
    return found


def test_the_measurement_log_is_still_cited(repo: Path) -> None:
    """The one pointer that proves the numbers went somewhere rather than away."""
    assert "docs/benchmarks/forced-alignment/LOG.md" in _cited_paths(repo), (
        "nothing in the worker points at the measurement log any more — the prose either kept its "
        "numbers or lost them"
    )


def test_no_citation_leads_to_a_gitignored_working_document(repo: Path) -> None:
    """A fresh clone has no `PLAN-*`, so such a pointer is a dead end, exempt by name or a failure.

    `DECLARING_MODULE` is not a citer: this file names those documents in order to forbid them, which is the
    rule itself rather than a pointer at one (the distinction appeared when the roots widened to the tests).
    """
    cited = _cited_paths(repo)
    unexpected: dict[str, list[str]] = {}
    for path, citers in cited.items():
        if path not in WORKING_DOCUMENTS - EXEMPT_CITATIONS:
            continue
        others = sorted(set(citers) - {DECLARING_MODULE})
        if others:
            unexpected[path] = others
    assert not unexpected, "shipped prose points at a gitignored working document: " + "; ".join(
        f"{path} (from {', '.join(citers)})" for path, citers in sorted(unexpected.items())
    )
    stale = sorted(EXEMPT_CITATIONS - set(cited))
    assert not stale, (
        f"these exemptions are no longer cited and must be deleted from EXEMPT_CITATIONS: {stale}. "
        "An exemption nobody uses reads as a defect that is still open."
    )


@pytest.mark.skipif(shutil.which("git") is None, reason="needs git; the worker image ships none (#1303)")
def test_the_working_documents_are_not_committed(repo: Path) -> None:
    """`WORKING_DOCUMENTS` says a fresh clone has none of them, which holds only while git tracks none.

    Asked of git rather than of the disk: a working copy may hold one on purpose, ignored but not committed.
    """
    tracked = subprocess.run(
        ["git", "ls-files", "--", *sorted(WORKING_DOCUMENTS)],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    assert not tracked, f"these gitignored working documents are committed anyway: {tracked}. `git rm` them."


def _resolves(candidate: Path) -> bool:
    if any(ch in candidate.name for ch in GLOB_CHARS):
        return candidate.parent.is_dir()
    return candidate.exists()


#: `XA-07`, `XW-12` — the invariant id, which this wave made the primary code→doc pointer for the rules a
#: later wave must not break. `XA-*` rows live in `ALIGNMENT_DOC` and `XW-*` in `WORKER_DOC`.
INVARIANT_CITATION = re.compile(r"\bX([AW])-([0-9]{2})\b")

#: The floor on the id rule, re-floored with its population as `MIN_SECTION_CITATIONS` was: the shipped tree
#: carries 143 citations over all 31 declared ids, so a pattern that stops reading most of them cannot hide
#: behind "no failures". It was left at 50 while W7c tripled the population (review r2-correctness-4).
MIN_INVARIANT_CITATIONS = 110

#: Where a cited id must be DECLARED: the invariant table's own row, which is how the table reads.
INVARIANT_ROW = re.compile(r"^\|\s*\*\*X([AW])-([0-9]{2})\*\*\s*\|", re.MULTILINE)

#: Every root, the tests citing ids as densely as the package does. Kept as its own name because this rule
#: widened a wave before the others did, and the floor below is read against this population.
CITATION_ROOTS = CODE_ROOTS

#: Invariant rows no module may cite, so `test_every_invariant_the_table_declares_is_cited` cannot ask them
#: to. EMPTY, and that is the finished state: every row names a module or a test, and W7c put the id there.
#: An entry a module does cite is a stale exemption and fails below, so this mapping can only shrink.
UNCITED_INVARIANTS: Mapping[str, str] = {}


def _declared_invariants(repo: Path) -> dict[str, set[str]]:
    """`{"A": {"01", ...}, "W": {...}}` — the ids each design document's table actually declares."""
    declared: dict[str, set[str]] = {"A": set(), "W": set()}
    for doc in (ALIGNMENT_DOC, WORKER_DOC):
        for kind, number in INVARIANT_ROW.findall((repo / doc).read_text(encoding="utf-8")):
            declared[kind].add(number)
    return declared


def _cited_invariants(repo: Path) -> dict[tuple[str, str], list[str]]:
    """`{(kind, number): the files citing it}` over the package, the harness and the tests."""
    found: dict[tuple[str, str], list[str]] = {}
    for root in CITATION_ROOTS:
        for source in sorted((repo / root).rglob("*.py")):
            for kind, number in INVARIANT_CITATION.findall(source.read_text(encoding="utf-8")):
                found.setdefault((kind, number), []).append(str(source.relative_to(repo)))
    return found


def test_every_cited_invariant_id_is_a_row_of_the_table(repo: Path) -> None:
    """Deleting or renumbering an invariant must break the suite, not just the pointers (W7b r2-tests-11).

    `test_the_design_documents_exist_and_carry_their_invariants` only asks that the WORD "Invariant" appears,
    so dropping a whole `| **XA-07** |` row left every pointer at it dangling and the suite green.
    """
    cited = _cited_invariants(repo)
    total = sum(len(citers) for citers in cited.values())
    assert total >= MIN_INVARIANT_CITATIONS, (
        f"only {total} invariant-id citations matched, under the {MIN_INVARIANT_CITATIONS} floor: either the "
        "idiom is being dropped or INVARIANT_CITATION has stopped reading it."
    )
    declared = _declared_invariants(repo)
    dangling = {
        f"X{kind}-{number}": sorted(set(citers))
        for (kind, number), citers in cited.items()
        if number not in declared[kind]
    }
    assert not dangling, (
        "these cite an invariant the design document does not declare — a deleted or renumbered row: "
        + "; ".join(f"{name} (from {', '.join(citers)})" for name, citers in sorted(dangling.items()))
    )


def test_the_tests_own_pointer_population_is_what_the_roots_comment_says(repo: Path) -> None:
    """`CODE_ROOTS`' comment justified widening to `worker/tests` with counts that reproduced on no tree and
    under no reading — 57 paths and 11 sections against 66 and 22 — so the figure arguing for the rule's
    scope was unchecked by the rule (W7c review r2-correctness-5). A FLOOR, since a pointer may be added."""
    paths: list[str] = []
    sections = titles = 0
    for source in sorted((repo / "worker/tests").rglob("*.py")):
        text = source.read_text(encoding="utf-8")
        paths += [raw.rstrip(".,;:)`'\"") for raw in DOCS_PATH.findall(text)]
        sections += len(SECTION_CITATION.findall(text))
        titles += len(TITLE_CITATION.findall(_prose_of(text)))
    read = {
        "paths": len(paths),
        "distinct_paths": len(set(paths)),
        "sections": sections,
        "titles": titles,
    }
    under = {
        name: (count, MIN_TEST_POINTERS[name])
        for name, count in read.items()
        if count < MIN_TEST_POINTERS[name]
    }
    assert not under, (
        f"worker/tests cites fewer pointers than MIN_TEST_POINTERS claims: {under} (read, floor). Either a "
        "rule has stopped reading this root or the quoted population is stale — re-measure both together."
    )


def test_every_invariant_the_table_declares_is_cited(repo: Path) -> None:
    """The OTHER direction, which nothing read: 9 of the 14 `XW` rows were cited nowhere, so deleting the
    atomicity row or the fail-closed-ledger row broke no test and left no dangling pointer to find.

    A citation from THIS module is not one: its own `#:` example cites `XW-12`, which is how that id read as
    held while `steps/records.py`, the module the row names, never named it (W7c review r2-tests-15).
    """
    cited = {
        f"X{kind}-{number}"
        for (kind, number), citers in _cited_invariants(repo).items()
        if any(citer != DECLARING_MODULE for citer in citers)
    }
    declared = _declared_invariants(repo)
    uncited = sorted(f"X{kind}-{number}" for kind, numbers in declared.items() for number in numbers)
    uncited = [name for name in uncited if name not in cited]
    assert uncited == sorted(UNCITED_INVARIANTS), (
        f"these invariants are declared and cited by no module: {uncited}. Put the id at the site the row's "
        "'Where held' column names, or name it in UNCITED_INVARIANTS with the reason it cannot be."
    )
    for name, reason in UNCITED_INVARIANTS.items():
        assert len(reason) > 20, f"{name}'s exemption gives no reason: {reason!r}"


@pytest.mark.parametrize(("doc", "kind"), [(ALIGNMENT_DOC, "A"), (WORKER_DOC, "W")])
def test_the_invariant_ids_are_contiguous_from_one(repo: Path, doc: str, kind: str) -> None:
    """A renumbering is then a test failure rather than a silent re-point of every citation at the table.

    Contiguity also makes the floor above meaningful: with a gap, a citation of the missing number would read
    as a typo rather than as the deletion it is.
    """
    numbers = sorted(
        int(n) for k, n in INVARIANT_ROW.findall((repo / doc).read_text(encoding="utf-8")) if k == kind
    )
    assert numbers, f"{doc} declares no X{kind}-NN invariant rows"
    assert numbers == list(range(1, len(numbers) + 1)), (
        f"{doc}'s X{kind} ids are {numbers}, not 1..{len(numbers)}. Renumbering silently re-points every "
        "citation in the worker; append instead, and retire a row in place."
    )


@pytest.mark.parametrize("doc", [ALIGNMENT_DOC, WORKER_DOC])
def test_the_design_documents_exist_and_carry_their_invariants(repo: Path, doc: str) -> None:
    path = repo / doc
    assert path.is_file(), f"{doc} is missing: the worker's prose points at it"
    text = path.read_text(encoding="utf-8")
    # A stub would satisfy "exists" and lose everything the code gave up to it.
    assert len(text.splitlines()) > 100, f"{doc} is a stub ({len(text.splitlines())} lines)"
    assert "Invariant" in text, f"{doc} carries no invariants table"
    assert "benchmarks/" in text, f"{doc} does not point at where its measurements live"


@pytest.mark.parametrize(
    ("index", "target"),
    [
        ("worker/README.md", ALIGNMENT_DOC),
        ("worker/README.md", WORKER_DOC),
        ("docs/arch/README.md", "04-alignment.md"),
        ("docs/arch/README.md", "05-worker.md"),
    ],
)
def test_the_design_documents_are_linked_from_the_indexes(repo: Path, index: str, target: str) -> None:
    text = (repo / index).read_text(encoding="utf-8")
    assert target in text, f"{index} does not link {target}, so the document is undiscoverable from it"
