# Encore — UX requirements

> **Purpose.** The design rules as requirements a person can disagree with and a machine can
> often check. Ratified decisions and their reasoning are in [`../DECISIONS.md`](../DECISIONS.md);
> how the system works now is [`../ARCHITECTURE.md`](../ARCHITECTURE.md); how to operate it safely
> is [`../HANDOFF.md`](../HANDOFF.md). Open work is tracked in **GitHub issues**.

Written 2026-09-09 for the UI redesign, extended since. **127 requirements** across seven sections.
Subsystem contracts — media, the HTTP surface, background jobs — are a sibling tree at
[`../arch/`](../arch/README.md), because this document is about the design rules and those are not.

| Section | Rows | Covers |
|---|---|---|
| [`01-tv.md`](01-tv.md) | 20 | Type floor, safe areas, every TV state, the attract phrase system |
| [`02-phone.md`](02-phone.md) | 22 | Queue-as-home, bottom search, the drag mode, join, live singing controls |
| [`03-colour-tokens.md`](03-colour-tokens.md) | 24 | The 48-stop palette, four per-stop contrast roles, token-layer consequences |
| [`04-verification.md`](04-verification.md) | 22 | How the rules are *checked* — the two rungs, anti-vacuity, migration safety |
| [`05-concurrency.md`](05-concurrency.md) | 17 | Authority, cross-surface consistency, the social cost of a visible failure |
| [`06-components.md`](06-components.md) | 12 | The component contract: variant discipline, who owns a decision, accessible names |
| [`07-tv-module.md`](07-tv-module.md) | 10 | The TV's module layer beneath the visuals: player lifecycle, media failure, what it must not depend on |

## How to read a row

Every requirement carries eight fields. Three of them do the real work:

- **Surfaces** — which surfaces it applies to. A px threshold copied across surfaces is the most
  common error in a document like this, because the TV and the phone are at different distances.
- **Source** — a citation, or `DERIVED` **with its model stated**, or `UNSOURCED`. A plausible
  number with no marker is the worst outcome: it is indistinguishable from a sourced one and will
  be defended by someone who assumes it was checked. `UNSOURCED` is a legitimate output.
- **Acceptance** — Given/When/Then, written so a reader can name the observation that falsifies it.

`Check` is the mechanism, or `EXEMPT` with the judgment deferred. A row whose `Check` is `EXEMPT`
is honest, not incomplete.

## Three things these sections found that contradicted their own brief

Recorded here because each was verified against `main`, and a reader who trusts the older
documents will otherwise write the wrong requirement.

**1. Six palette stops fail AA against the surfaces the app actually paints.** The generator
measured against `bg #060a18 / card #131a2e`; `app.css` paints `--bg: #0b0b12 / --card: #1a1a28`.
Re-measured on the real tokens, **Cobalt 4.473, Denim 4.477, Rose 4.477, Orchid 4.481, Magenta
4.483 and Fuchsia 4.490** miss the 4.5 floor as accent-as-ink. The reported worst case was 4.50 —
a margin of ~0.00, so any surface drift at all was going to cross it. This is the *same defect
class* the handoff names as "do this first": **a contrast measurement bound to a duplicated
surface value rather than to the token the app paints.** See `XR-COL-04`.

**2. Aliasing `$app`/`$env` does not make measurement checkable — that needs a second rung.**
happy-dom 20.14.0's `getBoundingClientRect()` is a stub (`Element.js:795`, `// TODO: Not full
implementation`, `return new DOMRect()` — all zeros). It has **no layout engine**, so under the
preload there is no box geometry, no clipping, no `env()` resolution, no `dvh`/`vh` resolution and
no painted contrast. The prerequisite is therefore **two rungs**: **rung M** (mount — cascade,
computed declared values, effects) and **rung L** (layout — real headless Chromium, already
in-repo at `tests/e2e/cdp.mjs`). The four measurement claims land on **rung L**. A plan that
stops at rung M has made none of them checkable. See `XR-VER-01`.

**3. Four concurrency premises were stale.** A host **mechanism** already exists and is
centralised (`lib/server/auth/capabilities.ts`, `can(actor, cap)`), carrying the owner's dated ruling
that "today every joined singer is a host". A **cross-singer host reorder already ships**
(a direct rewrite of the stored ordered list — no durable pin; pinning was deleted step 3
— still gated on `queue:reorder-any`, with the arrow/drag "move to index" wiring landing
step 4) — so the within-singer rule holds for the `move` op but not for the product. **One rate limit exists**
(`MAX_CONCURRENT_PROCESSES_PER_SINGER = 3`, answered HTTP 429); the uncapped axis is queue depth. And
a **lost optimistic race is already disclosed** (`hub.ts` → `op:reject` → rollback → `role="alert"`
toast). What is open in all four cases is **policy content, not mechanism** — which is much
cheaper than the older documents assume.

## What is deliberately not here

Each section ends with the requirements it chose **not** to write and why — usually because the
rule was already both stated and enforced, or because the answer is a judgment nobody has made.
That list is what stops the next person re-deriving the same gaps.

`05-concurrency.md` additionally ends with **open questions for the owner**, each with options
enumerated so they can be settled without discussion.

## The mockups these were written from

Self-contained HTML using the real tokens, in the **workspace, not the repo** —
`encore-mockups/`. They are hand-authored, so they deliberately do not live in
[`../mocks/`](../mocks/README.md), which is a slot-based set of frames generated by
`tests/e2e/capture.mjs` and documents that nothing else belongs there.

Two of those files are now **exceptions**: the 48-stop player palette's generator and its registry
moved into the repo as `src/lib/contract/scripts/_player_palette.py` and
`src/lib/contract/presentation/player-palette-48.json`, because `XR-COL-01`/`XR-COL-02` require the
registry to be tracked and its regeneration to be checkable. The HTML mockups stay in the workspace.

`tv-chosen.html` is the decided TV design (split-panel attract, full roster lobby, full-screen
takeovers). Its six frames were verified numerically in-browser — every element's rect against its
frame bounds, plus `scrollWidth` vs `clientWidth` for clipped text — rather than by eye, which is
the mechanism `XR-TV-19` generalises.
