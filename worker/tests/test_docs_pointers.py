"""The code points at `docs/` instead of carrying it, so the pointers are checked.

A cited path is load-bearing since the 2026-10-01 directive: a reader who follows it and finds nothing has
lost the measurement or the failure account that used to be inline, and nothing at runtime can notice. Nine
rules — the paths resolve, a cited SECTION NUMBER names a heading that exists, a cited SECTION TITLE names a
heading or a bold lead-in, every `§N` in prose is ANCHORED to a committed document rather than to the
gitignored review, a cited "`module`'s NAME section" is text that module still carries, no citation leads to
a GITIGNORED working document, the two design documents are not stubs, and both indexes link them.

Path failures FAIL rather than skip (`test_artifact_keys.py`'s rule): a skipped check reads as satisfied.
"""

from __future__ import annotations

import ast
import io
import re
import tokenize
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

#: Both roots of shipped-ish Python: the package, and the committed bench harness that cites the same docs.
CODE_ROOTS = ("worker/encore_worker", "docs/benchmarks/forced-alignment/scripts")


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
MIN_SECTION_CITATIONS = 80


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


#: `README, "The claim clock's own exhibits"` — the other half of the pointer idiom, and the commoner half,
#: since a measurement README is organised by TITLE rather than by number. The quoted run must be a heading or
#: a bold lead-in somewhere in `TITLE_DOCS`; a typo'd or renamed title matches nothing and fails.
TITLE_CITATION = re.compile(r'README(?:\.md)?`?[^"\n]{0,12}?"([^"]{8,120})"')

#: Where a cited title may live. `README` alone is ambiguous between the measurement README and the worker's,
#: so all of them are searched: what this rule is for is a title that exists NOWHERE.
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


def _doc_titles(repo: Path) -> list[str]:
    """Every heading and every bold lead-in of `TITLE_DOCS`, lowercased."""
    titles: list[str] = []
    for doc in TITLE_DOCS:
        text = (repo / doc).read_text(encoding="utf-8")
        titles += [match.group(1).strip().lower() for match in re.finditer(r"^#{2,4}\s+(.*)$", text, re.M)]
        titles += [match.group(1).strip().lower() for match in re.finditer(r"\*\*([^*\n]{8,160})\*\*", text)]
    return titles


def test_every_cited_section_title_names_a_heading_or_a_lead_in(repo: Path) -> None:
    titles = _doc_titles(repo)
    assert len(titles) > 200, f"only {len(titles)} titles found across TITLE_DOCS — the scan has broken"
    cited: dict[str, list[str]] = {}
    for root in CODE_ROOTS:
        for source in sorted((repo / root).rglob("*.py")):
            for match in TITLE_CITATION.finditer(_prose_of(source.read_text(encoding="utf-8"))):
                cited.setdefault(match.group(1).strip(), []).append(str(source.relative_to(repo)))
    assert len(cited) > 20, f"only {len(cited)} README section titles are cited — the pointer idiom has gone"
    missing = {
        title: sorted(set(citers))
        for title, citers in cited.items()
        if not any(title.lower() in known for known in titles)
    }
    assert not missing, "the worker cites README sections that do not exist: " + "; ".join(
        f'"{title}" (from {", ".join(citers)})' for title, citers in sorted(missing.items())
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
    five silence sentences of `align_steps._margin_why` shipped `review §3.7` on the job's audit trail with
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
    unanchored: dict[str, list[str]] = {}
    for root in CODE_ROOTS:
        for source in sorted((repo / root).rglob("*.py")):
            text = _every_line_of(source.read_text(encoding="utf-8"))
            for mark in re.finditer("§", text):
                before = text[max(0, mark.start() - ANCHOR_LOOKBACK) : mark.start()]
                if not SECTION_ANCHOR.search(before):
                    quoted = text[max(0, mark.start() - 60) : mark.start() + 20]
                    unanchored.setdefault(str(source.relative_to(repo)), []).append(quoted)
    assert not unanchored, "these `§N` pointers name no committed document: " + "; ".join(
        f"{path} (…{', …'.join(quotes)})" for path, quotes in sorted(unanchored.items())
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
    """`(citing file, cited module, cited NAME)` for every citation of the form above."""
    found: list[tuple[str, str, str]] = []
    for root in CODE_ROOTS:
        for source in sorted((repo / root).rglob("*.py")):
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


def test_the_measurement_readme_is_still_cited(repo: Path) -> None:
    """The one pointer that proves the numbers went somewhere rather than away."""
    assert "docs/benchmarks/forced-alignment/README.md" in _cited_paths(repo), (
        "nothing in the worker points at the measurement README any more — the prose either kept its "
        "numbers or lost them"
    )


def test_no_citation_leads_to_a_gitignored_working_document(repo: Path) -> None:
    """A fresh clone has no `PLAN-*`, so such a pointer is a dead end, exempt by name or a failure."""
    cited = _cited_paths(repo)
    unexpected = {
        path: sorted(set(citers))
        for path, citers in cited.items()
        if path in WORKING_DOCUMENTS - EXEMPT_CITATIONS
    }
    assert not unexpected, "shipped prose points at a gitignored working document: " + "; ".join(
        f"{path} (from {', '.join(citers)})" for path, citers in sorted(unexpected.items())
    )
    stale = sorted(EXEMPT_CITATIONS - set(cited))
    assert not stale, (
        f"these exemptions are no longer cited and must be deleted from EXEMPT_CITATIONS: {stale}. "
        "An exemption nobody uses reads as a defect that is still open."
    )


def _resolves(candidate: Path) -> bool:
    if any(ch in candidate.name for ch in GLOB_CHARS):
        return candidate.parent.is_dir()
    return candidate.exists()


#: `XA-07`, `XW-12` — the invariant id, which this wave made the primary code→doc pointer for the rules a
#: later wave must not break. `XA-*` rows live in `ALIGNMENT_DOC` and `XW-*` in `WORKER_DOC`.
INVARIANT_CITATION = re.compile(r"\bX([AW])-([0-9]{2})\b")

#: The floor on the id rule, same reason as `MIN_SECTION_CITATIONS`: 64 citations over 15 ids were counted
#: when it was written, so a pattern that stops matching cannot hide behind "no failures".
MIN_INVARIANT_CITATIONS = 50

#: Where a cited id must be DECLARED: the invariant table's own row, which is how the table reads.
INVARIANT_ROW = re.compile(r"^\|\s*\*\*X([AW])-([0-9]{2})\*\*\s*\|", re.MULTILINE)

#: Rule 1's roots plus the worker's tests, which cite ids as densely as the package does.
CITATION_ROOTS = (*CODE_ROOTS, "worker/tests")


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
