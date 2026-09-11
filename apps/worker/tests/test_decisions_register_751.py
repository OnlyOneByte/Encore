"""#751 — a comment asserted the ruling was recorded in the ratified-decisions register, and it
was not.

THE DEFECT. `roformer.py`'s `ROFORMER_MODELS` block told the reader that the engine-package ruling
from #483 — adopt `python-audio-separator` ALONGSIDE `bs-roformer-infer`, both engines, owner ruling
Q1(b) — "is recorded in docs/DECISIONS.md". Measured on `c23ba69`, that register held ZERO matches for
`bs-roformer-infer`, `both engines`, `alongside`, `483`, `Q1` or `owner ruling`; the ruling existed only
as a comment in `requirements.txt`. Worse, the register read the other way: `python-audio-separator`
under "**Adopt as a dependency**", headed "Why the separator **swap** is the highest-value change" —
and the plain reading of *swap* is replacement. So following the pointer landed a reader on text that
contradicted the ruling it was sent to confirm. The pointer was true before `a7b9f9c`, which
enriched the parenthetical to assert the alongside/both-engines/Q1(b) ruling while touching only
`roformer.py` and `requirements.txt` — a regression, not a long-standing wart.

WHY IT MATTERS, and it is not tidiness. The review lane's own rules refuse to file "anything already
deliberately decided — check the ratified decisions first" and never to re-open a ratified decision as
a bug. Because the ruling was absent from the register, that protection did not cover it: a future pass
could legitimately file "two dependencies doing one job — drop one", with nothing in the register to
refute it, and burn a dispatch re-deriving a ruling the owner already gave.

WHY A SOURCE SCAN. The defect is a property of the text, so it is decidable without running anything:
there is no runtime path here to red. This guard is the biting proof. It reads the REAL production
files (never a fixture) and holds three arms, one per production site of the fix.

WHY THE POINTER IS RESOLVED RATHER THAN MATCHED. Arm 3 does not assert that the comment says the right
words — that would be satisfied by the very text that shipped the defect. It extracts every file the
comment NAMES as recording the ruling and requires each named file to actually contain it, so a
pointer at a register that does not hold the claim reds no matter how it is worded. Comment stripping
is INVERTED on purpose (the source side is read as comment text, never stripped) because the defect
lives IN a comment; precedent is `packages/shared/src/doc-pointer-accuracy.test.ts` and
`apps/core/src/routes/api/leave/doc-accuracy.test.ts`.

Every arm carries a non-vacuity sentinel anchored on text that IS in the register, so an emptied,
moved or renamed file reds loudly instead of passing on nothing.

FOUR ARMS, one per production site plus the class guard:
  1. the register records the ruling;
  2. the register does not frame the adoption as a replacement (two whole framings, not a bare
     substring);
  3. every file the roformer.py comment cites actually records the ruling;
  4. the register does not claim an engine the code does not have — bidirectional against
     requirements.txt and engines.py, because the first revision of this very fix reintroduced the
     defect class it was closing.
"""

import re
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1]  # apps/worker
REPO = WORKER.parents[1]  # apps/worker -> apps -> repo root

DECISIONS = REPO / "docs" / "DECISIONS.md"
ROFORMER = WORKER / "src" / "separation" / "roformer.py"

#: The #483 ruling's identifying terms. ALL must be present for a file to count as recording it —
#: any single one alone is ambient (docs/ARCHITECTURE.md contains "alongside" and nothing else of
#: this ruling, which is what the discrimination sentinel in arm 3 exploits).
RULING_MARKERS = (
    "python-audio-separator",
    "bs-roformer-infer",
    "alongside",
    "both engines",
    # `#483` was a sixth marker here. It went when issue references were cleared from source and
    # docs: the five remaining markers name the ruling by its CONTENT — both engine names, the
    # word "alongside", the phrase "both engines" and the question id — which is a stronger
    # identification than the number ever was.
    "Q1(b)",
)

#: Anchors that exist in the register independently of this fix. If one of these goes missing the
#: file has been emptied, moved or restructured, and the arms below must red rather than silently
#: pass on a file that is no longer the register.
REGISTER_ANCHORS = (
    "Adopt as a dependency",
    "Deferred — do NOT pick these up",
)

#: The two files the ruling comment is required to name. One pointer orphans the claim as soon as
#: either file is reorganised — which is exactly how #751 happened.
REQUIRED_CITATIONS = ("docs/DECISIONS.md", "apps/worker/requirements.txt")

#: The two discredited framings, banned as WHOLE phrases rather than as the bare substring
#: `"the swap"`. The bare form was wider than the defect: an unrelated later sentence ("following the
#: swap") would have redded the guard on prose that says nothing about replacement. Each entry here is
#: a framing that actually shipped and actually misleads.
BANNED_FRAMINGS = (
    "separator swap",
    "The swap improves",
)

#: The register must not assert the second engine is present while it is not. `python-audio-separator`
#: is LANDED iff it is pinned in requirements.txt or imported by the engine module — anything else is
#: a document claiming a state the code does not hold, which is the defect class this file guards.
NOT_LANDED_MARKER = "NOT YET LANDED"
PRESENT_TENSE_CLAIMS = (
    "is added, it does not replace",
    "the two coexist",
)


def _comment_lines(src: str) -> list[str]:
    """Comment lines only. NOT stripped: the defect lives in the comment, so blanking comments would
    blind the guard to its whole subject."""
    return [line for line in src.splitlines() if line.lstrip().startswith("#")]


def _records_ruling(text: str) -> bool:
    low = text.lower()
    return all(m.lower() in low for m in RULING_MARKERS)


def _ruling_window(lines: list[str]) -> str:
    """The comment PARAGRAPH that makes the ruling claim, located by CONTENT at both ends (line
    numbers rot here).

    Anchored on the claim itself and terminated by the paragraph break — a bare `#:` / `#` line —
    rather than by a fixed character budget. The earlier 900-char slice answered pr-bot's advisory on
    b2687cac only by failing closed: a reflowed comment that pushed a citation past the budget redded
    the non-vacuity assertion instead of reporting the real condition. Walking to the paragraph end
    removes the budget, so a reflow inside the paragraph cannot move a citation out of scope."""
    idx = next(
        (i for i, line in enumerate(lines) if "engine-package decision" in line.lower()),
        None,
    )
    assert idx is not None, "roformer.py no longer carries the engine-package decision comment at all"

    out = []
    for line in lines[idx:]:
        if line.strip() in ("#", "#:"):  # paragraph break
            break
        out.append(line)
    return "\n".join(out)


def _cited_paths(window: str) -> list[str]:
    """Repo-relative paths the window names as holding the ruling."""
    found = re.findall(r"[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:md|txt)", window)
    return sorted(dict.fromkeys(found))


def test_the_decisions_register_records_the_483_both_engines_ruling():
    """RED ON BASE: measured zero matches for the ruling terms in docs/DECISIONS.md at c23ba69."""
    text = DECISIONS.read_text(encoding="utf-8")

    # non-vacuity: this is still the register, not an emptied or moved file.
    for anchor in REGISTER_ANCHORS:
        assert anchor in text, f"docs/DECISIONS.md no longer contains {anchor!r} — still the register?"

    missing = [m for m in RULING_MARKERS if m.lower() not in text.lower()]
    assert not missing, (
        "docs/DECISIONS.md does not record the both-engines ruling; missing "
        f"{missing}. The ruling is settled — quote it, do not re-derive it "
        "(apps/worker/requirements.txt carries it verbatim)."
    )


def test_the_register_does_not_frame_the_adoption_as_a_replacement():
    """RED ON BASE: the register was headed "Why the separator swap is the highest-value change" and
    said "The swap improves the lyrics chain" — and *swap* reads as replacement, the opposite of the
    ruling.

    Bans those two WHOLE framings, not the bare substring "the swap" (pr-bot advisory on
    b2687cac): the bare form would have redded on an unrelated later sentence such as "following the
    swap", which says nothing about replacement. "gapless swap" elsewhere in the file is likewise
    unrelated and stays legal."""
    text = DECISIONS.read_text(encoding="utf-8")

    # non-vacuity: the section that carried the framing still exists, so deleting it is not a pass.
    assert "is the highest-value change" in text, (
        "the highest-value-change section is gone from docs/DECISIONS.md — this guard would pass "
        "vacuously on its absence"
    )
    assert "python-audio-separator" in text

    for banned in BANNED_FRAMINGS:
        assert banned.lower() not in text.lower(), (
            f"docs/DECISIONS.md describes the adoption as {banned!r}, which reads as replacing "
            "bs-roformer-infer — #483 ruling Q1(b) is both engines"
        )


def test_the_register_does_not_claim_an_engine_the_code_does_not_have():
    """The register must not assert a state the code does not hold — the very defect class this PR
    exists to close, which the FIRST revision of this fix reintroduced into the same file (pr-bot
    blocking finding on b2687cac: "python-audio-separator is added" and "the two coexist behind one
    seam" were both false, since the package has no pin and engine_for resolves only demucs and
    roformer).

    Decidable from the code rather than from prose: the dependency is LANDED iff it is pinned in
    requirements.txt or imported by the engine module. BIDIRECTIONAL on purpose — when it does land,
    the not-yet-landed wording must GO, or the register is stale in the other direction and the next
    reader is misled again."""
    text = DECISIONS.read_text(encoding="utf-8")
    reqs = (WORKER / "requirements.txt").read_text(encoding="utf-8")
    engines_src = (WORKER / "src" / "separation" / "engines.py").read_text(encoding="utf-8")

    # non-vacuity: still the file that would carry the pin, and still the module that resolves engines.
    assert "bs-roformer-infer==" in reqs, "apps/worker/requirements.txt no longer pins bs-roformer-infer"
    assert "def engine_for" in engines_src, "engines.py no longer defines engine_for"

    pinned = re.search(r"(?mi)^\s*python[-_]audio[-_]separator\s*[=<>~!\[]", reqs) is not None
    # TARGET side is comment-stripped: a comment mentioning the package is not the package being wired.
    engines_code = re.sub(r"#[^\n]*", "", engines_src)
    wired = re.search(r"audio[-_]separator", engines_code, re.I) is not None
    landed = pinned or wired

    if landed:
        assert NOT_LANDED_MARKER.lower() not in text.lower(), (
            f"python-audio-separator has landed (pinned={pinned}, wired={wired}) but "
            f"docs/DECISIONS.md still says {NOT_LANDED_MARKER!r} — drop that wording"
        )
    else:
        assert NOT_LANDED_MARKER.lower() in text.lower(), (
            "python-audio-separator is neither pinned in apps/worker/requirements.txt nor imported by "
            "separation/engines.py, so docs/DECISIONS.md must say the adoption is "
            f"{NOT_LANDED_MARKER!r} rather than describing a second engine the code does not have"
        )
        for claim in PRESENT_TENSE_CLAIMS:
            assert claim.lower() not in text.lower(), (
                f"docs/DECISIONS.md asserts {claim!r} while python-audio-separator is absent from "
                "requirements.txt and engines.py — a register claiming a state the code does not hold "
                "is the defect #751 was filed about"
            )


def test_every_file_the_roformer_ruling_comment_cites_actually_records_the_ruling():
    """RED ON BASE: the comment cited docs/DECISIONS.md, which did not hold the ruling — and cited
    only that one file, so a doc reorganisation would orphan the claim again."""
    comments = _comment_lines(ROFORMER.read_text(encoding="utf-8"))
    window = _ruling_window(comments)
    cited = _cited_paths(window)

    # non-vacuity (0): the window actually bounded the paragraph rather than swallowing the file.
    assert "engine-package decision" in window.lower()
    assert len(window) < len("\n".join(comments)), "the ruling window is the whole comment block"

    # non-vacuity (1): extraction actually found the pointers rather than resolving nothing.
    assert len(cited) >= 2, f"extracted too few cited paths from the ruling comment: {cited}"

    # non-vacuity (2): the marker test DISCRIMINATES — a real doc that is not the ruling's record
    # must not satisfy it. docs/ARCHITECTURE.md contains "alongside" and none of the rest.
    arch = (REPO / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")
    assert "alongside" in arch.lower(), "sentinel premise changed: ARCHITECTURE.md no longer says 'alongside'"
    assert not _records_ruling(arch), "the ruling-marker test is too weak — it accepts docs/ARCHITECTURE.md"

    # the durability half: both anchors named, so neither file alone can orphan the claim.
    for required in REQUIRED_CITATIONS:
        assert required in cited, (
            f"the ruling comment in roformer.py does not cite {required}; cited {cited}. Name both the "
            "register and the dependency pin — a single pointer rots the moment either is moved."
        )

    # the guard itself: every cited file must exist and must actually hold the ruling.
    offenders = []
    for rel in cited:
        target = REPO / rel
        if not target.is_file():
            offenders.append(f"{rel} (cited but does not exist)")
            continue
        if not _records_ruling(target.read_text(encoding="utf-8")):
            offenders.append(f"{rel} (cited but does not record the ruling)")
    assert not offenders, "roformer.py's ruling comment points at " + "; ".join(offenders)
