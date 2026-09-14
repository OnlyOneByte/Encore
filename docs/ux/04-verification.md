# 04 — Verification, guards and migration safety

How the design rules are **checked**. Nothing here restates a rule; every row is about the
mechanism that could catch its violation.

---

## Enumeration — what is actually in the tree

Re-derived on `main` at `3f6ee2f`. The brief carried **242 / 38 design-enforcing
files / 128 survive / 68 retarget / 27 retire / 19 at risk** as bare numbers with no unit named,
and two of them do not survive a recount: the population is counted here **twice, once in files and
once in cases, each labelled**, and the earlier "242 == 242 coincidence" is resolved below rather
than flagged.

### The design-enforcing population — the written rule

Prior passes counted this population two incompatible ways and neither wrote down what it was
counting, which is how a file count and a case count came to sit under one number. The rule this
doc now counts by, stated so a later recount lands on the same set:

> **A test file is *design-enforcing* iff it (a) reads `.svelte` or `.css` source text (via a shared
> scan helper or its own `readFileSync`/`readdirSync`), AND (b) asserts a *rendered or structural
> design claim* — contrast, geometry, a tap target, a token, motion, layout, focus, a breakpoint, a
> type ladder — AND (c) does not live under a `server/` path.** Clause (c) excludes the
> behavioural/wiring guards that `readFileSync` a component only to assert a data-flow or event
> contract, not a design one.

The two prior counts are the **bounds** of this rule, not rival answers to it:

- **Lower bound — scan-helper consumers: 14 files / 141 cases.** Files that import a shared scan
  helper (`svelteFiles`, `styleFiles`, `classPresent`, `markupControls`; `allSvelte` is deleted).
  This understates the population because most per-component design pins inline their own reader
  instead of importing a helper. The 14:

  `tests/guards/hygiene/contract.test.ts` · `tests/guards/design-system/colour-tokens.test.ts` ·
  `tests/guards/design-system/shadcn-ink-ban-913.test.ts` ·
  `tests/guards/motion/motion.test.ts` · `tests/guards/a11y/contrast.test.ts` ·
  `tests/guards/design-system/design-system.test.ts` · `tests/guards/hygiene/icon-centring.test.ts` ·
  `tests/guards/hygiene/settings-scopes.test.ts` · `tests/guards/design-system/singer-color.test.ts` ·
  `tests/guards/design-system/tailwind-toolchain.test.ts` · `tests/guards/meta/test-helpers.test.ts` ·
  `tests/guards/a11y/touch-targets.test.ts` · `tests/guards/layout/stage-scale.test.ts` ·
  `tests/guards/hygiene/icons.test.ts`

- **Upper bound — any `.svelte`/`.css` reader: 87 files / 766 cases.** Every test that
  `readFileSync`/`readdirSync`-reads component or stylesheet source, including the per-component
  pins the lower bound misses AND the 11 `server/`-path wiring guards that read a component only
  incidentally (115 of those 766 cases). This overstates the population by exactly those wiring
  guards plus six `tv/`-tree tests that read a component but assert an audio-graph, seek/resume,
  socket-lifecycle, prose-accuracy or data-flow contract rather than a design one.

- **The rule's own count — design-enforcing: 70 files / 624 cases.** The upper bound minus the 11
  `server/` wiring guards (clause c) and the 6 clause-(b) `tv/` readers that read `.svelte`/`.css`
  but assert no rendered/structural design claim: `tv/guide-gain-after-transpose.test.ts` and
  `tv/master-level-normalization.test.ts` (audio GainNode wiring), `tv/tv-reload-resume.test.ts`
  (seek/resume timing), `tv/pitch-shift-doc-accuracy.test.ts` (a docstring-vs-class prose guard),
  `tv/ws-through-wsclient.test.ts` (socket lifecycle), and `routes/tv/lyrics-clamp.test.ts`
  (which argument reaches the clamp — data-flow, not the clamp's rendered result). This is the
  population every requirement below is anchored to.

Case counts for the three sub-populations (140 / 624 / 766) are `test(…)`/`it(…)` invocation counts
harvested by grep, so they are floors relative to `bun test`'s own case count (which also counts
cases generated inside `describe`/loops); the file counts are exact. The *ratio* (~8.9 cases/file
across the 70-file rule population) is what the split-unit argument below rests on, and it holds
regardless of the harvesting method since every sub-population was counted the same way.

**The brief's 38 was neither of these** — it sits between the 14 lower bound and the 70 rule count,
and no recount reproduces it, so it is treated as a stale figure from an earlier tree, superseded
by 70 files / 624 cases.

**Repo-wide `*.test.ts` file count is 287, and the whole suite is 2652 cases** (files counted
across `apps/*` + `packages/*` excluding `node_modules`; the case total is `bun test`'s own
authoritative `Ran N tests` count). The brief's "242" matched **neither** unit on
this base: it is neither the 265 repo-wide files nor the 2566 repo-wide cases, and it is not the 70
design-enforcing files or their 624 cases. The old note that "the repo-wide `*.test.ts` file count
is also 242" was a coincidence of a **prior** tree that has since grown; it does not hold at
`3f6ee2f` and is not evidence of anything now. See "Restating the retirement split" below for what
the 242/128/68/27/19 numbers most likely were.

### Restating the retirement split (128 / 68 / 27 / 19) — the unit is FILES, and 19 is a file bucket

The brief presented `242 → 128 survive / 68 retarget / 27 retire / 19 at risk` with no unit. Two
facts settle the unit:

1. `128 + 68 + 27 + 19 = 242`, so the four buckets partition the **242** total exactly. Whatever
   242 counted, the split counts the same thing.
2. On this base the design-enforcing population is **70 files / 624 cases** — an order of magnitude
   apart. A 242-item total is far closer to a *file*-scale count of an earlier, larger design set
   than to any case count of it, and a 19-item "at risk" bucket is a plausible *file* bucket but an
   implausibly small *case* bucket (the QueueSheet sheet-cap concern alone spans several cases).

**Conclusion: the 242/128/68/27/19 split is a split of FILES, not cases** — an earlier tree's
design-enforcing *file* set, bucketed by retirement fate. That makes "19 at risk" a count of
at-risk **files**, and the at-risk **case** population is materially larger, because each at-risk
file carries several cases (the 70-file / 624-case ratio is ~8.9 cases per file). The buckets are
not re-derived here — the earlier tree they were measured on no longer exists — but their unit is
now named, which is what the unit question asked for. The concrete downstream consequence is the
at-risk coverage scope, adjusted here.

**At-risk scope adjustment.** The "at risk" work was sized against the brief's `19`, read as a
count of cases needing migration coverage. That number is a **file** bucket (above), so the real
work it and its successors must cover is the **cases** those at-risk files carry, not 19 items.
At the 70-file / 624-case ratio (~8.9 cases/file) a 19-*file* at-risk bucket is on the order of
**~170 at-risk cases**, an order of magnitude above the figure the scope was sized against. The
motion utility-class arm (XR-VER-15) is already landed and unaffected — it added its
own floors rather than enumerating the at-risk set — but any remaining "cover the at-risk
population" scoping that inherited the `19` must be re-sized off cases. The register (XR-VER-13) is
what makes the true case population enumerable; until it lands, treat "19 at risk" as a file count
and expect the case count to be materially larger.

**Helper definition sites — all five now share one home** (`XR-VER-14`). Every one is
defined in `tests/support/src/scan.ts` and imported; `allSvelte` is gone, having been a
verbatim copy of `svelteFiles` under another name.

| Helper | Defined at | Shared? |
|---|---|---|
| `svelteFiles` | `tests/support/src/scan.ts` | exported, shared |
| `styleFiles` | `tests/support/src/scan.ts` | exported, shared — `svelteFiles` deliberately widened to `.css` so `app.css` is in scope |
| `markupControls` | `tests/support/src/scan.ts` | exported, shared |
| `classPresent` | `tests/support/src/scan.ts` | exported, shared |
| ~~`allSvelte`~~ | — | deleted; `e2e/contract.test.ts` imports `svelteFiles` |

All five walk through **one** recursive `walk()` with a single `SKIP_DIRS` set
(`node_modules`, `build`, `.svelte-kit`, `dist`, `.git`) and **no** directory allowlist, so
`src/lib/components/ui/` is in scope by construction rather than by someone remembering to add it.
`tests/guards/meta/test-helpers.test.ts` reds if a consumer declares or calls **one of these five names**
without importing it, or if the shared walk gains a second `readdirSync` or an allowlist. Its scan is
**name-keyed, and that is its limit**: a rival walker reintroduced under a *different* name leaves the
suite green. Measured, not assumed — three consumers carry exactly such a walker today (`tsSources` in
`components/motion.test.ts`, `tsFiles` in `ui/icons.test.ts`, `allDrivers` in `e2e/contract.test.ts`)
and the suite is green with all three present. Closing that needs a ban on any second recursive
directory walk in a consumer, which cannot land until those three are consolidated or carried on an
annotated baseline — the follow-up issue below. Six more walkers with
their own globs remain out of this set and out of scope here — `e2eDrivers`, `allDrivers`,
`productionFiles`, `productionSources`, `tsFiles`, `routePages` — worth their own issue.

**The state this replaced — four of five were per-file copies:**

| Helper | Defined at | Shared? |
|---|---|---|
| `svelteFiles` | `tests/support/src/scan.ts:13` | exported, shared |
| `styleFiles` | `tests/guards/motion/motion.test.ts:30` | local copy |
| `markupControls` | `tests/guards/a11y/touch-targets.test.ts:47` | local copy |
| `allSvelte` | `tests/guards/hygiene/contract.test.ts:147` | local copy |
| `classPresent` | `tests/guards/hygiene/contract.test.ts:172` | local copy |

**Non-vacuity floors — 18 assertions across 10 files**, more than the decision record's 7:

**Non-vacuity floors — the decision record said 7; the live guard now enumerates 40 floor
assertions across 14 files.** The "7" was already known low when the record was written; on
`3f6ee2f` the authoritative count is not a prose figure at all but the machine-checked snapshot in
`tests/guards/meta/non-vacuity-floors.test.ts`, whose own accounting asserts
`located >= 39` and `Object.keys(FLOORS).length >= 12` (those are floors, not exact counts; the map
lists 14 files today and its `count` fields sum to 40). Count the unit carefully: **40 is the sum
of every floor entry's `count`** (three entries require more than one assertion — `motion`
`files.length` needs 3, `task-number-hygiene` `files.length` needs 2, `phone-inventory`
`filesScanned` needs 2), across **36 distinct floor entries** in **14 files**. The 14 files:

`tailwind-toolchain` (`FILES.length`) · `task-number-hygiene` (`files.length >50`, ×2) ·
`icon-centring` (`FILES.length >7`) · `contrast` (`rootsScanned >=3`) ·
`singer-color` (`FILES.length >15`) ·
`touch-targets` (`controlRulesSeen >=10`, `FILES.length >=12`, `boxRulesSeen >=10`) ·
`motion` (`files.length >=24` ×3, `svelte.length >=20`, `netFiles.length >=40`) ·
`design-system` (fourteen floors: `FILES.length`, `seen`, `checked`, `scanned`, `bridgeRefsScanned`,
`forwardsChecked`, `spacingDeclsSeen`, `fontDeclsSeen`, `leadingDeclsSeen`, `motionDeclsSeen`,
`zDeclsSeen`, `TV.length`, `rungsChecked`, `literalsFound`) ·
`tv/stage-scale` (`heroBadgesSeen >=2`) · `ui/icons` (`FILES.length >15`, `tsFiles(...).length >10`) ·
`e2e/contract` (`DRIVERS.length >20`, `lits.length >=19`, `sources.length >20`) ·
`e2e/lib/chromium` (`out.length >20`) · `ui/page-header` (`out.length >7`) ·
`phone-inventory` (`PHONE_ROUTES.length >=4`, `filesScanned >=10` ×2, `declarationsSeen >=10`).

The record's earlier "18 across 10 files" and the interim "22 across 12 files" are both stale
snapshots superseded by that guard. The design-system dimension-duplication and `@theme`
bridge scans (plus the ladder-ordering and phone-ladder-on-TV floors), the two enumerating
walks that carried none — `e2e/lib/chromium.test.ts` and `ui/page-header.test.ts` — plus the motion
utility-class arm, `boxRulesSeen`, `sources.length` and `touch-targets` `FILES.length`, and
`literalsFound` and the tailwind-toolchain floor each raised it; the guard's own `located >=
39` floor tracks the running total (the true sum is now 40). Do not trust any prose figure here
over the guard: it reds on any decrease or deletion and carries its own floor on the count it
located, so it is the single source of truth. XR-VER-06's Check is implemented, not merely
specified.

**Breakpoints, both lists located.** Documented: `.kiro/autoloop/REVIEW.md:206` — 390 / 820 /
1440 px (**not** repo-root `REVIEW.md`, which does not exist). Implemented `@media` widths across
`apps` + `packages` source: **380 / 520 / 768 / 1200**. Confirmed zero overlap.

**`transition-all` appears nowhere in the tree today.** The Tailwind invisibility trap is
prospective, not a live violation — which is exactly why it must be closed *before* utilities
enter, not after.

**⚠ SUBJECT RETIRED — read this block as history.** The drawer surface these numbers described
(`QueueSheet.svelte`, `QueueSheetDrawer.svelte`, `--peek-h` and the sheet CSS) was DELETED: the
ratified phone design has no drawer, the inline-rows/hero/docked-band home was built instead, and
neither component rendered anywhere a guest could reach. The file:line citations below are therefore
left unrepaired ON PURPOSE — the files are gone, so there is nothing to re-point them at. What survived
is the *contract*, not the sheet: `--dock-h` (published from `routes/+page.svelte` by `.cta-dock` on
home and `.search-dock` on browse) carries the identical invariant — the token equals the band's REAL
rendered height, and the safe-area inset lives on the band alone so nothing above it adds a second
`env()`. XR-VER-11 below is now measured against that band; `SHEET_CAP_FRACTION` was retired from the
measured-design register in the same change, because nothing docked caps itself in a viewport fraction
any more.

**Incumbent values the replacement must match, not merely "cap in `dvh`":** `QueueSheet`'s sheet
was `max-height: 82dvh`; `.peek` and `.body` both carried
`calc(… + env(safe-area-inset-bottom, 0px))`; `--peek-h: 132px` in `app.css` with a
`@media (max-height: 480px)` override to `84px` on `:root` in `routes/+page.svelte` that
the sheet's inline write on `documentElement` **outranked**. AT RISK 5 was therefore a
*do-not-regress*, with a number.

**⚠ Two of those numbers do not reach the render, measured.** Corrected against
`bun run gate:measured` on HeadlessChrome/151, 390×844: the inline write publishes the
peek's REAL measured `clientHeight`, so neither the `132px` base nor the `84px` short-viewport
override is ever the resolved value while the sheet is mounted, and at a 480px-tall viewport the media
query MATCHES yet `--peek-h` still reads the measured height. The load-bearing invariant is therefore
*`--peek-h` equals the peek's rendered height*, not any literal; a replacement drawer that publishes a
constant satisfies every source scan and breaks every docked control that offsets from it.
The cap measures `692.08px` of an 844px viewport and `393.6px` of a 480px one — 82.00% both times.
(Earlier revisions of this row cited `QueueSheet.svelte:53`, which was `COMMIT_PX = 48` rather than the
inline write, and
`(height <= 480px)`, which is range syntax the tree does not use; a probe grepping either finds
nothing. Both files are now deleted, so no corrected line number is offered.)

**Which is why the number itself must not be written down here.** `--peek-h` is content-measured, so
it differs per surface and per queue depth: the shipped gate reads **91px** on `/` with an empty queue,
and a later spike read **164px** at 844 and **151px** at 480 on a populated three-row sheet.
Both are correct and neither contradicts the other, because the invariant is an equality against the
rendered peek rather than a constant — a guard pinned to either literal would have failed on the other
measurement. That spike also established that the `84px` override is **route-scoped**: it lives in
`routes/+page.svelte`'s `<style>`, so `/join` at 480 tall stays on the `132px` base, and it is a
pre-measurement value rather than a steady state.

---

## ⚠ Correction to the handoff's prerequisite claim — verified, load-bearing

§4 item 5 and §5 both state that aliasing `$app`/`$env` "converts measured tap geometry, real
clipping, computed contrast and actual safe-area violation from honour-system to **checkable**."

**Half of that is false, and the false half is the measurement half.** happy-dom 20.14.0:

```js
// node_modules/happy-dom/lib/nodes/element/Element.js:795-798
getBoundingClientRect() {
    // TODO: Not full implementation
    return new DOMRect();
}
```

`new DOMRect()` is all zeros. happy-dom has **no layout engine**, so under the preload rung there
is no box geometry, no clipping or overflow, no `env()` resolution, no `dvh`/`vh` resolution and
no painted contrast. Aliasing the virtual modules unlocks **mounting, the cascade, computed
declared values, and effect behaviour** — a real and necessary gain — but not measurement.

So the prerequisite is **two rungs, not one**:

- **Rung M (mount)** — `bunfig.toml` → `tests/setup/svelte-dom-preload.ts` + aliased `$app`/`$env`.
  Cascade, computed declared values, effects, event handling. One consumer today
  (`playback-common-actions.test.ts`); blocker documented at `wake-lock.test.ts:18-27`.
- **Rung L (layout)** — real headless Chromium, already in-repo and already used by the review
  passes: `tests/e2e/driver.mjs` + `capture.mjs` (see `tests/e2e/HARNESS.md`). The **only**
  place geometry, clipping, `env()`, `dvh`, and contrast-as-painted are decidable.

The four measurement claims land on **rung L**. Rung M is still a prerequisite — it is what makes
a component's cascade inspectable at all — but a plan that stops at rung M has not made a single
one of the four claims checkable. Rows below are written against the correct rung.

---

# A. The rendered rungs as prerequisites

### XR-VER-01 — Both verification rungs exist, and their capability boundary is written down

| | |
|---|---|
| **Statement** | The product's test harness provides a mount rung and a layout rung, and a written record states which classes of claim each rung can decide. |
| **Surfaces** | Phone remote, TV, operator dashboards (harness-level; surface-agnostic) |
| **Rationale** | An honour-system invariant and a checked one are indistinguishable to a reviewer unless the harness's reach is stated. |
| **Source** | `bunfig.toml`; `tests/setup/svelte-dom-preload.ts`; `tests/guards/subsystem-tv/wake-lock.test.ts:18-27`; `tests/e2e/driver.mjs`, `tests/e2e/HARNESS.md`; happy-dom limit at `node_modules/happy-dom/lib/nodes/element/Element.js:795-798`. **DERIVED** for the two-rung split — model: a claim is decidable on a rung iff the rung implements the API the claim reads; happy-dom returns a zero `DOMRect`, therefore geometry is not decidable on rung M. |
| **Acceptance** | **Given** the preload aliases `$app` and `$env`, **When** a test imports and mounts `src/routes/tv/+page.svelte`, `SongRow.svelte`, `QueueRow.svelte` and `ColourPicker.svelte`, **Then** every mount returns without throwing and `flushSync()` runs their effects. **And** a checked-in document names, per rung, at least: box geometry, clipping/overflow, `env()`, `dvh`/`vh`, computed colour, computed `font-size`, and states which rung decides each. |
| **Check** | The five mounts are themselves tests. The capability document is enforced by XR-VER-02, which cites it. |
| **Priority** | **BLOCKER** — migration cannot begin without it; four at-risk concerns are undecidable until it lands. |

### XR-VER-02 — A measurement claim is verified by measurement, never by a source scan

| | |
|---|---|
| **Statement** | Every design invariant whose statement contains a measured quantity — a rendered size, a resolved length, a computed colour pair, an overflow, an intersection — is checked on the layout rung against a real render. |
| **Surfaces** | Phone remote, TV (the two rendered surfaces) |
| **Rationale** | A source scan proves a declaration is present, not that the rendered result satisfies it; the migration removes the declarations a scan would read. |
| **Source** | **DERIVED** — model: the handoff's own 4-of-9 measurement classification, plus the repo's three recorded cases where a green source scan coexisted with the defect (`routes/page.test.ts:26` passing while the Undo button was 25–41 px occluded; `touch-targets.test.ts` green over a 28 px slider; `motion.test.ts` green over five injected layout animations). |
| **Acceptance** | **Given** the register from XR-VER-13, **When** each entry's statement is classified as *declaration* or *measurement* against the XR-VER-01 capability document, **Then** no entry classified *measurement* is implemented only as a `readFileSync` + regex over `.svelte`/`.css`. |
| **Check** | A meta-test over the register: for each measurement-classified entry, assert its implementing file imports the layout-rung driver. |
| **Priority** | **MUST** |

### XR-VER-03 — A geometry API that cannot measure fails loudly rather than reporting zero

| | |
|---|---|
| **Statement** | No guard treats a zero or absent measurement as a satisfied one; a measurement API that returns an unimplemented value causes the guard to fail with a message naming the harness limitation. |
| **Surfaces** | Phone remote, TV |
| **Rationale** | happy-dom returns an all-zero `DOMRect`, so the natural shape `if (h > 0) expect(h).toBeGreaterThanOrEqual(44)` is silently vacuous for the entire suite. |
| **Source** | `node_modules/happy-dom/lib/nodes/element/Element.js:795-798` (`// TODO: Not full implementation`, `return new DOMRect()`) — read directly. |
| **Acceptance** | **Given** any guard reading `getBoundingClientRect`, `getClientRects`, `offsetHeight`, `offsetWidth`, `scrollWidth` or `clientWidth`, **When** that guard runs on the mount rung, **Then** it fails with a message naming the rung, and does not report pass. **And** no guard in the register skips or short-circuits an assertion on a zero or `undefined` measurement. |
| **Check** | Grep the register's implementing files for those six APIs; assert each occurrence is either inside a layout-rung driver or preceded by an explicit rung assertion. Mutation-prove by running one geometry guard on the mount rung and confirming it reds. |
| **Priority** | **MUST** — this is the highest-probability silent-green in the whole migration, because the fix for the blocked rung is what introduces it. |

---

# B. Anti-vacuity — every guard must be able to fail

**A worked consequence.** Bringing shadcn's `Slider` in showed what this invariant costs and why
the cost is worth paying. Bits UI's slider needs a layout engine twice over: it reads `offsetWidth`,
which this invariant replaces with a throw, and it observes its track with `ResizeObserver`, which the
mount rung does not install and has its own arm asserting is absent. So four `hero-live-controls-835`
arms — the two XR-PH-15 states, XR-PH-03's containment claim, and the summary-vs-body placement — could
no longer be decided on the mount rung once GuidingTrack used that component.

They moved to `e2e/probes/p16-hero-live-controls.mjs` rather than being kept alive with a faked width
and a faked observer, which is the choice this invariant exists to force: two fictions stacked to keep a
test mounted would have produced exactly the silent green it forbids. Reaching the degraded state on a
real render needed a fixture capability that did not exist — `FAKE_NO_VOCALS=1` on the fake stems
worker, because `hasGuidingTrack()` is `isPlayable(m) && !!m.vocalsRef` — and the probe bails rather
than reports when either fixture is not in the state its arm needs.

What was given up is stated on the record: those four assertions no longer run where there is no
Chromium. That is the trade this invariant asks for, not a defect in it.

### XR-VER-04 — Every design guard has a recorded mutation that makes it fail

| | |
|---|---|
| **Statement** | Each entry in the design-enforcing register carries a recorded, reproducible mutation of **production** source that turns it red, and the record names the failing assertion and its observed message. |
| **Surfaces** | All (harness-level) |
| **Rationale** | A guard's name and its assertions routinely disagree; only a biting mutation distinguishes a working guard from a decorative one. |
| **Source** | `docs/archive/milestones-m0-m8.md:128-130` called `motion.test.ts` "non-vacuous (injecting `transition:width` fails it)" — true of exactly the one shape it caught, and five other injected layout animations survived (`.kiro/autoloop/REVIEW-LOG.md`). **DERIVED** from that: a single demonstrated mutation certifies one shape, not the guard. |
| **Acceptance** | **Given** a design guard, **When** its recorded mutation is applied to production source and the suite is run, **Then** that guard reds and names the mutated site; **and When** the mutation is reverted, **Then** the tree is byte-identical and the guard is green. |
| **Check** | A per-guard mutation record checked in beside the register. Guards whose mutation record is absent or stale are listed by a meta-test. |
| **Priority** | **MUST** for the 19 at-risk plus the 68 retarget entries (**files** — see "Restating the retirement split"; the case counts they carry are larger); **SHOULD** for the 128 survivors. |

### XR-VER-05 — Every enumerating guard carries a non-vacuity floor

| | |
|---|---|
| **Statement** | Any guard that derives its own scope by walking a tree or filtering a file list asserts a minimum on the size of what it actually examined. |
| **Surfaces** | All (harness-level) |
| **Rationale** | A scope regression — a moved directory, a renamed extension, a copy-in path outside the walk — otherwise turns the guard green rather than red. |
| **Source** | The 40 floor assertions across 14 files enumerated above and snapshotted in `tests/guards/meta/non-vacuity-floors.test.ts`, e.g. `design-system.test.ts` (`FILES.length`), `motion.test.ts` (`files.length >=24`, ×3), `contract.test.ts` (`DRIVERS.length`, `lits.length`, `sources.length`). **DERIVED**: the same class already caught `/metrics` and `lib/charts` (Trend) escaping hand-listed `FILES` arrays. |
| **Acceptance** | **Given** a guard that computes its file or rule set at run time, **When** the computed set is emptied by pointing the walk at a non-existent directory, **Then** the guard fails on its floor rather than passing with zero items examined. |
| **Check** | For each register entry marked *enumerating*, assert a floor assertion exists in the file and mutation-prove it by redirecting the walk root. |
| **Priority** | **MUST** |

### XR-VER-06 — A firing non-vacuity floor is a finding, never a number to adjust

| | |
|---|---|
| **Statement** | A change that lowers, removes, or conditionally bypasses a non-vacuity floor is not accepted unless it carries a written statement of which invariant is thereby unenforced and what replaces it. |
| **Surfaces** | All (process-level, enforced in the repo) |
| **Rationale** | The migration's expected signal *is* these floors firing, and the intuitive reading of a firing floor — "the guard is broken, lower the number" — converts a detected loss of enforcement into a silent one. |
| **Source** | `encore-redesign-decision.md` §0 finding 3 and §5; `encore-design-handoff.md` §5 ("Treat a non-vacuity floor firing as a finding, never as a number to adjust"). |
| **Acceptance** | **Given** a diff that decreases any numeric literal inside a floor assertion, or deletes one, **When** it is proposed, **Then** it fails a check unless the same diff adds a record naming (a) the invariant whose scope shrank, (b) the sites that left scope, and (c) the guard that now covers them or an explicit statement that none does. |
| **Check** | A guard over the register's own source: extract each floor's literal, compare against a checked-in snapshot, and fail on any decrease without a matching record entry. This is machine-checkable precisely because the floors are literals. |
| **Priority** | **MUST** — without it, the one mechanism the repo planted to detect the migration's real hazard is defeated by the reviewer's own reflex. |

### XR-VER-07 — A retired guard is deleted with a recorded reason, never left passing

| | |
|---|---|
| **Statement** | When an invariant stops applying, its guard is removed in the same change that removes the invariant, and the removal records why; no guard remains in the suite whose assertions can no longer fail on any reachable input. |
| **Surfaces** | All (process-level) |
| **Rationale** | A rule that has stopped biting is indistinguishable from a rule that is working, and the redesign dissolves at least one by construction. |
| **Source** | `encore-design-handoff.md` §3 — the `--accent`-as-text ban dissolves because every Chromatic stop clears AA as ink (worst 4.50:1), so its guard "will now pass **vacuously**". Also the 27 RETIRE cases in `encore-redesign-decision.md` §2. **⚠ That specific claim is BACKWARDS, verified** — see the correction below the table. |
| **Acceptance** | **Given** the 27 RETIRE entries plus any guard whose premise a change invalidates, **When** the change lands, **Then** each is either deleted with a one-line reason in the retirement record, or re-anchored to a still-falsifiable claim with a fresh XR-VER-04 mutation record. **Then** no entry remains that is neither deleted nor re-anchored. |
| **Check** | Diff the retirement record against the register; a RETIRE entry still present in the suite with an unchanged premise is reported. **Implemented in part** by `tests/guards/meta/non-vacuity-floors.test.ts`: its `RETIRED` map requires a substantive reason and asserts the retired assertion is genuinely absent, and its `PENDING_RULING` map holds a decided retire-or-re-anchor call whose anchor text must still be present in the guard it describes. |
| **Priority** | **MUST** |

**⚠ Correction to this row's Source — the `--accent` guard does NOT go vacuous, it REDS.**

The handoff predicted `contrast.test.ts`'s accent-as-ink ban would "pass vacuously" once the palette
clears AA as ink. Verified against the guard: its first arm is
`expect(ratio(token(t), token('card'))).toBeLessThan(AA_TEXT)` — an assertion that the pairs **fail** AA.
So a stop that clears AA as ink makes that line **red**, before the offenders scan below it is reached.
The guard self-reports the dissolution of its own premise; there is no vacuous window.

That inverts the fix direction. The hazard is not that nobody notices — it is the reviewer who meets an
unexpected red, reads it as a broken guard, and deletes the assertion, taking the **usage** scan with it.
That scan is not dissolving: "accent tokens are backgrounds, not ink" survives as a design rule after it
stops being a contrast fact, and it is what caught the `/metrics` links. So the work this row actually
demands is to **decide the retire-or-re-anchor question before the palette lands** and record it next to
the guard, which is done: the ruling is at `contrast.test.ts` ("RECORDED RULING FOR THE PALETTE
MIGRATION") and is held to the guard by `non-vacuity-floors.test.ts`'s `PENDING_RULING` check.


---

# C. No test duplicates a value it could read

### XR-VER-08 — A test reads every value it asserts about from that value's single source of truth

| | |
|---|---|
| **Statement** | No test hard-codes a copy of a value that is declared elsewhere in the product — a token, a palette hex, a breakpoint, a threshold constant — where that declaration is readable from the test. |
| **Surfaces** | All (harness-level) |
| **Rationale** | A duplicated value decouples the test from the thing it tests, so the test keeps passing while measuring something the product no longer does. |
| **Source** | `tests/guards/design-system/colors.test.ts:29-30` — `const BG = '#0b0b12'; // --bg` and `const CARD = '#1a1a28'; // --card`, verified in place, against the live `:root` declarations; three contrast tests consume them. Counter-example of the correct shape: `tests/guards/a11y/trend-tap-target.test.ts:32` bridges `--tap` from the token rather than copying `44`. |
| **Acceptance** | **Given** `--bg` or `--card` is changed in `app.css` and nothing else, **When** the suite runs, **Then** at least one test fails. **And Given** any test file in the register, **When** its literals are compared against the token block, the 48-stop palette JSON, and the breakpoint list, **Then** no literal equals a declared value it does not read. |
| **Check** | Two parts: (1) the falsification above, run as a mutation; (2) a guard extracting literals from register files and diffing them against the declared sets. A trailing comment naming the token is **not** a link and does not exempt. |
| **Priority** | **BLOCKER** — the handoff sequences this first (§7 step 1, §3 "Do this first"), and every palette-contrast claim depends on it. |

---

# D. The four measurement claims, converted from honour-system to checked

All four are **rung L** (see the correction above). Each row's acceptance names what mounts and
what is measured.

### XR-VER-09 — Every interactive control's rendered height is measured against the 44 px floor

| | |
|---|---|
| **Statement** | Every control in a named control register renders at least 44 px of hit extent on the phone remote, measured on a real render. |
| **Surfaces** | Phone remote (the only input surface); operator dashboards where they carry controls. Not TV — no input device. |
| **Rationale** | The floor is Encore's own, stricter than WCAG's, and the guard that nominally enforces it has been structurally blind three times. |
| **Source** | WCAG 2.2 SC 2.5.8 Target Size (Minimum) — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html (24 px; Encore's 44 px is stricter, ratified at `docs/ROADMAP.md:276`). Blindness evidence: `touch-targets.test.ts:47`'s `CONTROL` regex carries no range-input token (28 px `.hue`); its `FILES` array excludes `routes/metrics/*` (32 px) and `lib/charts` (~11.4 px day columns). |
| **Acceptance** | **Given** the app driven at 390×844, 360×740 and 430×932 with touch emulation, **When** every element in the control register is scrolled to centre and its vertical hit extent probed at thumb, mid and far-edge x positions, **Then** every reading is ≥ 44 px, and the register includes at minimum: `button`, `a` acting as a control, every `input[type="range"]`, `select`, checkbox and radio labels, tab stops, chips, icon buttons, and the day columns in `lib/charts/Trend.svelte`. |
| **Check** | Rung L, driven through `tests/e2e/driver.mjs`. Register membership is itself enumerated by XR-VER-13's exemption discipline — a control absent from the register is a register defect, not an exempt control. |
| **Priority** | **MUST** |

### XR-VER-10 — Every text-entry field's computed font size is measured at ≥ 16 px

| | |
|---|---|
| **Statement** | Every text-entry field on the phone remote computes to a font size of at least 16 px. |
| **Surfaces** | Phone remote |
| **Rationale** | Below 16 px, iOS Safari zooms the viewport on focus, which relocates the layout under the user's thumb mid-entry. |
| **Source** | **UNSOURCED** for the 16 px number as a *standard* — it is a WebKit behaviour, not a published success criterion, and I found no citable specification of the threshold. Related but not the same claim: WCAG 2.2 SC 1.4.4 Resize Text — https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html. The number is renegotiable only on evidence about WebKit, not about accessibility. |
| **Acceptance** | **Given** the app driven at 390×844, **When** `getComputedStyle(el).fontSize` is read for every `input` accepting text, every `textarea`, and the room-code segment boxes, **Then** every value is ≥ 16 px. **And** the measurement is taken on a real render, so a `rem`-relative or `@theme`-derived declaration resolves. |
| **Check** | Rung L. Rung M can read the declaration but cannot resolve a `rem` against a `vh`-derived root, which is exactly the TV type-floor construction. |
| **Priority** | **MUST** |

### XR-VER-11 — The bottom sheet's height cap and bottom clearance are measured, not declared

| | |
|---|---|
| **Statement** | The bottom-docked band's published height equals its real rendered height, and its screen-edge padding includes the bottom safe-area inset, measured on a real render. |
| **Surfaces** | Phone remote |
| **Rationale** | A cap in `vh` overshoots by the browser-chrome height, and a dropped inset breaks clearance app-wide, because the published band token is the contract every docked control offsets from. |
| **Source** | **RE-POINTED WHEN THE DRAWER WAS DELETED.** This rule was written against the queue sheet, whose incumbent values were `max-height: 82dvh`, `.peek` and `.body` both `calc(… + env(safe-area-inset-bottom, 0px))`, and `--peek-h: 132px` written inline on `documentElement`, outranking a `:root` override to `84px`. That surface was deleted (no drawer in the ratified design; nothing a guest could reach), so the sheet-cap half is retired — `SHEET_CAP_FRACTION` left the measured-design register with it, because nothing docked caps itself in a viewport fraction now. What remains, and what the gate measures, is the band contract on `.cta-dock` / `.search-dock`: `--dock-h` equals the band's real rendered `clientHeight`, and the band alone carries `env(safe-area-inset-bottom)`, which reaches the toasts THROUGH that token. |
| **Acceptance** | **Given** the phone home on a real render at 390×844, **When** `--dock-h` is read from `documentElement` and compared against the band's rendered height, **Then** they are equal and every docked control's offset resolves from that same value rather than a literal. **And When** the band's bottom padding is read, **Then** it exceeds its non-inset component by the inset value under a simulated non-zero `env(safe-area-inset-bottom)`. |
| **Check** | Rung L only — `dvh`, `env()` and the inline-vs-stylesheet cascade are all unresolvable on rung M. A future docked band is measured against these numbers, not merely inspected for the word `dvh`. |
| **Priority** | **MUST** — the band is what every other docked control (undo toast, error toast) positions against, so a broken publish silently mis-docks all of them. |

### XR-VER-12 — The focus indicator's form is verified as an outline in the focus token, on every surface it can appear on

| | |
|---|---|
| **Statement** | Every focusable element draws its focus indicator as an `outline` whose colour resolves to the focus token, and the indicator is distinguishable against each surface it can appear on. |
| **Surfaces** | Phone remote, operator dashboards, TV (TV focus is remote-driven and the indicator is the only position cue) |
| **Rationale** | A `box-shadow` ring satisfies the naive regex while violating the rule, and a ring in a library's own primary colour is a different failure that also passes a presence check. |
| **Source** | WCAG 2.2 SC 2.4.13 Focus Appearance — https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html ; SC 2.4.7 Focus Visible — https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html ; SC 1.4.11 Non-text Contrast — https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html. Incumbent: the global `:focus-visible` rule is `outline: 2px solid var(--focus)` with `outline-offset: 2px`; `QueueSheet`'s `.peek:focus-visible` uses `outline-offset: -2px`. |
| **Acceptance** | **Given** each element in the control register focused on a real render, **When** its computed `outline-style`, `outline-width` and `outline-color` are read, **Then** style is not `none`, width ≥ 2 px, and colour equals the resolved focus token. **And Then** no focused element's indicator is drawn by `box-shadow` alone. **And Then** the focus colour clears 3:1 against each of `--bg`, `--card`, `--card2` and `--accent`, measured from the token values rather than from copies. |
| **Check** | Rung L for the computed form; the contrast arm is arithmetic over tokens read live (XR-VER-08 applies). |
| **Priority** | **MUST** |

---

# E. Inventory over the design-enforcing files

### XR-VER-13 — A register enumerates every design-enforcing test, with a named exemption list

| | |
|---|---|
| **Statement** | A checked-in register lists every design-enforcing test file with its invariant, its rung, its classification (declaration or measurement), its retirement bucket, and its mutation record; every design-relevant source file is covered by at least one register entry or appears on a named, reasoned exemption list. |
| **Surfaces** | All (harness-level) |
| **Rationale** | Every recorded escape in this repo was a file outside a hand-listed scope, and an inventory with an unbounded escape hatch enforces nothing. |
| **Source** | `.kiro/autoloop/REVIEW-LOG.md` records `src/lib/charts` and `src/lib/metrics-format.ts` as **orphan paths appearing in no charter's rotation** — "Nothing will ever review those files directly". Enumeration above (re-derived at `3f6ee2f`): 14 scan-helper consumers (lower bound) vs 87 `.svelte`/`.css` readers (upper bound) vs the design-enforcing rule's 70 files / 624 cases vs the brief's stale 38 — populations the register now reconciles by the written rule rather than leaving as three unlabelled numbers. |
| **Acceptance** | **Given** the register, **When** the source tree is walked for `.svelte` and `.css` under `apps/*/src` and `packages/*/src`, **Then** every file is named by a register entry or by the exemption list; **and Then** the exemption list contains no wildcard, glob or open-ended category — each entry is a path with a one-line reason. **And When** a new `.svelte` or `.css` file is added, **Then** the walk fails until it is registered or exempted. |
| **Check** | A guard over the register, carrying its own non-vacuity floor on the walked-file count (per XR-VER-05). The copy-in directory `src/lib/components/ui/` is inside the walk by construction — which is the whole verification argument for the DECIDED library. |
| **Priority** | **MUST** |

### XR-VER-14 — Each scan helper has exactly one definition

| | |
|---|---|
| **Statement** | The helpers that determine a design guard's scope are defined once and imported, not copied per test file. |
| **Surfaces** | All (harness-level) |
| **Rationale** | Four of the five helpers are per-file copies, so a scope fix lands in one guard and silently leaves the others narrow — and a register that cannot point at one definition cannot verify scope centrally. |
| **Source** | Definition sites enumerated above: all five are now defined once in `tests/support/src/scan.ts` and imported; `allSvelte` was a verbatim copy of `svelteFiles` and is deleted. **DERIVED**: `motion.test.ts` needed its scope widened in isolation precisely because its `styleFiles` was private. |
| **Acceptance** | **Given** the register's implementing files, **When** each is parsed for local function declarations named in the helper set, **Then** none declares one; every use resolves to an import from the shared helper module. **And** the shared module's walk excludes `node_modules`, `build`, `.svelte-kit`, `dist`, `.git` and includes `src/lib/components/ui/`. |
| **Check** | A source guard over the register's files. **Implemented** by `tests/guards/meta/test-helpers.test.ts`: a comment-stripped scan of the ten consumers for a local declaration of any helper name and for a call without a matching import, plus arms asserting the exported `SKIP_DIRS` set, that the module contains exactly one `readdirSync` and no directory allowlist (so `src/lib/components/ui/` is in scope by construction), and that the walk behaviourally skips `node_modules`. Note `.svelte-kit/` currently contains built copies of every component's CSS — a walk that fails to exclude it will read stale duplicates and report on colours the app no longer paints, which is XR-VER-08's failure mode arriving through the scope door. |
| **Priority** | **SHOULD** — shipping with copies is survivable; shipping without knowing which copies exist is not, and XR-VER-13 covers that. |

---

# F. The invisibility traps

### XR-VER-15 — The utility-class surface is in scope of the motion prohibition

| | |
|---|---|
| **Statement** | The prohibition on non-composited and framework-driven animation is enforced over utility class names in markup as well as over CSS declarations and Svelte directives. |
| **Surfaces** | Phone remote, TV, operator dashboards |
| **Rationale** | `class="transition-all"` expresses the banned rule with no CSS declaration anywhere in source, so the existing guard's regex cannot see it and the ban stops being enforced without failing. |
| **Source** | `encore-design-handoff.md` §1 and `encore-redesign-decision.md` §2 AT RISK 2. WCAG 2.2 SC 2.3.3 Animation from Interactions — https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html. Verified: `transition-all` occurs **zero** times in the tree today, so this is prospective. |
| **Acceptance** | **Given** the source tree, **When** markup is scanned for class names, **Then** none matches `transition-all`, `transition-{width,height,spacing,inset,margin,padding,gap,flex}`, `animate-*` for a keyframe touching a layout property, or a duration/easing utility applied to one; **and Then** the scan reads `class:` directives, `class={…}` expressions and composed strings, and fails on a class expression it cannot resolve rather than skipping it. **And** the guard reds when `class="transition-all"` is injected into any component. |
| **Check** | Extend the register's motion entry to a class-name arm with its own mutation record. The unresolvable-expression clause matters: a blocklist that silently skips what it cannot parse is vacuous exactly where Tailwind is most idiomatic. **Implemented** as two arms at the foot of `tests/guards/motion/motion.test.ts`: an extractor that reads all four class spellings (quoted attribute, `class={…}` expression, `class:` directive, interpolation) and resolves each `transition-*` utility through the file's own `COMPOSITED_PROPS` allowlist — an unknown utility key and an unresolvable `class={…}` are OFFENDERS, not skips — plus a whole-source name net over `.svelte` **and** `.ts` that catches a utility composed anywhere the extractor cannot see. |
| **Priority** | **MUST**, and **before** utilities enter the tree — after they enter, the guard's first run has violations to triage and the temptation is to weaken it. |

### XR-VER-16 — The copied drawer's animation mechanism is established from its source, not inferred from its styling hooks

**⚠ MOOT — no drawer will be adopted.** This rule and XR-VER-17 below were gates *on
adoption* of a `vaul-svelte`/shadcn drawer. The drawer surface was deleted outright, removing
`vaul-svelte`, `bits-ui` and `@internationalized/date`, so there is no copied source to grep and no
adoption to gate. Both are kept as the record of what adoption WOULD have had to prove, and neither is
an open action. `src/lib/components/ui/` remains deliberately empty.

| | |
|---|---|
| **Statement** | Before the drawer is adopted, a written finding records — from the copied source — whether it animates via CSS on data attributes or via Svelte's transition directives, and names the file and line the finding rests on. |
| **Surfaces** | Phone remote |
| **Rationale** | `data-vaul-drawer-direction` *suggests* CSS-driven animation and therefore compliance; a suggestion is not a finding, and this is the one collision copy-in does not fix. |
| **Source** | `encore-design-handoff.md` §1 ("grep the copied source to confirm"); `encore-redesign-decision.md` §2 AT RISK 1, which also names `el.style.animation =` and `setProperty('transition', …)` as forms a directive grep misses. |
| **Acceptance** | **Given** the drawer's files copied into `src/lib/components/ui/`, **When** they are grepped for `transition:`, `in:`, `out:`, `animate:`, `style.animation`, `style.transition` and `setProperty('transition'` / `setProperty('animation'`, **Then** a finding records every hit with file and line, or records zero hits over a named file list. **And Then** every animation the drawer performs is reachable from a `@media (prefers-reduced-motion: reduce)` rule in a stylesheet inside `src/`. |
| **Check** | The grep is a register entry once the files exist. Until then this is a **gate on adoption**, not a test. |
| **Priority** | **MUST** before adoption |

### XR-VER-17 — Whether the drawer exposes snap points is determined and recorded before adoption

| | |
|---|---|
| **Statement** | A written determination records whether the chosen drawer exposes snap points, and if it does not, which mechanism carries the peek state that `--peek-h` implemented. (Moot — see XR-VER-16.) |
| **Surfaces** | Phone remote |
| **Rationale** | `--peek-h` is exactly a snap point and it is the contract every other docked control offsets from, so a drawer without snap points is not a drop-in for the one component the library actually replaces. |
| **Source** | `encore-design-handoff.md` §1 ("Check whether snap points are exposed; Encore's `--peek-h` is exactly a snap point") — shadcn-svelte's drawer page does **not** document them, per `encore-redesign-decision.md` §1's table. Incumbent value was `--peek-h: 132px`, written inline on `documentElement` by the queue sheet (since deleted). |
| **Acceptance** | **Given** the drawer's copied source and its published API, **When** a determination is written, **Then** it states either (a) the snap-point API's name and that a two-state peek/expanded configuration reproduces the measured 132 px peek, or (b) that no snap-point API exists, plus the named mechanism that replaces `--peek-h` and the list of docked controls re-pointed at it. |
| **Check** | `EXEMPT` from automated checking — the judgment is whether a given API reproduces the peek contract, which no test can decide. The **existence** of the determination is checkable and is what XR-VER-13's register records. |
| **Priority** | **MUST** before adoption |

---

# G. Testing under the real physical condition

### XR-VER-18 — Captured frames are sized so the reviewing tooling can read them

| | |
|---|---|
| **Statement** | Every frame captured as design evidence is under 2000 px on both axes, and every TV frame is exactly 1920×1080. |
| **Surfaces** | TV (the 1920×1080 constraint), all surfaces (the 2000 px constraint) |
| **Rationale** | An oversized frame is silently unreadable to the reviewing tooling — it costs the review rather than erroring — and the TV type scale is `vh`-relative, so a frame at another height measures a different design. |
| **Source** | `encore-design-handoff.md` / shared brief, *Verification posture*. **DERIVED** for the TV constraint's mechanism: `--tv-lyric` through `--tv-hero` are all `clamp(px, vh, px)` and the type floor is `max(2.7vh, 20px)`, so the resolved ladder is a function of viewport height alone. |
| **Acceptance** | **Given** any frame submitted as evidence, **When** its pixel dimensions are read, **Then** both axes are < 2000 and, if it is a TV frame, dimensions are exactly 1920×1080. **And Given** `deviceScaleFactor` > 1, **When** a clip region is captured, **Then** the stated dimensions are the *image's*, not the CSS region's. |
| **Check** | A dimension assertion in the capture path (`tests/e2e/capture.mjs`), so an unreadable frame fails at capture rather than at review. |
| **Priority** | **MUST** — cheap, and it is a failure that consumes the review silently. |

### XR-VER-19 — Both viewport cases are exercised: the full-panel case and the windowed case

| | |
|---|---|
| **Statement** | Every TV type and spacing claim is verified at a full-panel viewport and at a windowed viewport shorter than the panel case, because the product cannot detect which case it is in. |
| **Surfaces** | TV |
| **Rationale** | The type floor is a `max()` of a `vh` term and a `px` term precisely because the case is unobservable; testing one term leaves the other unverified. |
| **Source** | `encore-design-handoff.md` §1 TV type floor — `max(var(--tv-type-floor), var(--win-type-floor)) * var(--ui-scale)`, with the recorded model that a TV browser presents a fixed 1920×1080 (or 1280×720) CSS viewport whatever the panel resolution, and that on a 900 px-tall laptop "every physical assumption collapses". |
| **Acceptance** | **Given** the TV route rendered at 1920×1080, **When** the resolved root font size is read, **Then** it equals the `vh` term (2.7vh = 29.16 px at `--ui-scale: 1`) and every ladder token resolves at or above its floor. **And Given** the route at 1280×700, **Then** the root equals the `px` term (20 px), because 2.7vh = 18.9 px there. **And Given** `--ui-scale` at each of 0.8 and 1.6, **Then** the resolved root scales proportionally and no token resolves below its `clamp()` minimum. |
| **Check** | Rung L at four viewport sizes × three `--ui-scale` values. **The crossover is at 740.7 px of viewport height** (`2.7vh = 20px`) — **DERIVED**, model: `20 / 0.027`. Two consequences the handoff's wording obscures: 1280×720 (the FHD model-group viewport, a *real TV*) sits **below** the crossover, so a TV can legitimately land on the `px` term; and a 900 px-tall dev laptop sits **above** it, resolving to 24.3 px — so the windowed failure mode is not "the `px` term takes over", it is "the `vh` term keeps winning at a physically wrong distance". Both cases must be in the matrix. |
| **Priority** | **MUST** — and it can land before any migration, since the type floor is one `:root` declaration. |

### XR-VER-20 — The TV's physical viewing geometry and pixel ratio are stated assumptions, not measured facts

| | |
|---|---|
| **Statement** | The product has a **stated** assumption about TV viewing geometry and device pixel ratio, documented in one location, and every TV sizing derivation cites it rather than restating a number. |
| **Surfaces** | TV |
| **Rationale** | Nothing physical is observable from a browser, so the geometry can only be an assumption — and an assumption that is not labelled as one gets defended as a measurement. |
| **Source** | `encore-design-handoff.md` §4 item 2: "Everything assumes **8–12 ft on a 43–65″ panel**, recorded as an assumption, never measured. `devicePixelRatio` on the real panel is also unknown." Underlying model recorded in §1: absolute units pinned at 1in = 96px, `devicePixelRatio` is CSS-px-to-device-px not physical DPI, `ScreenDetailed` carries no physical dimensions, panel APIs are packaged-app-only, viewing distance unobservable by any API. |
| **Acceptance** | **Given** the assumption record, **When** it is read, **Then** it states the distance range, the panel-size range, the ~0.70′ per-CSS-px subtended angle, the ~1.8× under-anchoring factor, and explicitly that `devicePixelRatio` on a real panel is unmeasured. **And Then** every TV token derivation references it by name. **And Then** no TV requirement anywhere states a physical distance or panel size without that reference. |
| **Check** | A prose-accuracy guard of the kind the repo already runs (`pitch-shift-doc-accuracy.test.ts`, `doc-pointer-accuracy.test.ts`): assert the numbers in the assumption record match the token declarations that derive from them. The **content** of the assumption is `EXEMPT` — validating it needs a tape measure and a real panel, which no one has done. |
| **Priority** | **MUST** — this is the highest-leverage cheap row, because four separate TV numbers currently rest on an unlabelled assumption. |

---

# H. Every implemented breakpoint is a declared member

### XR-VER-21 — One breakpoint list exists, and something enforces it

| | |
|---|---|
| **Statement** | The product has a single declared list of responsive breakpoints; the widths reviewers are told to check, the widths tokens switch at, and the widths `@media` queries use are the same list, and a guard fails when they diverge. |
| **Surfaces** | Phone remote, operator dashboards. TV is excluded — it is a fixed-viewport surface, not a responsive one. |
| **Rationale** | Reviewers are currently directed at three widths at which no rule changes, and four widths at which rules do change are reviewed by nobody. |
| **Source** | Documented: `.kiro/autoloop/REVIEW.md:206` — 390 / 820 / 1440 px. Implemented: `@media` widths across `apps` + `packages` source — 380 / 520 / 768 / 1200 px, of which 768 and 1200 also switch `--max-w`. Zero overlap, verified by grep. WCAG 2.2 SC 1.4.10 Reflow — https://www.w3.org/WAI/WCAG22/Understanding/reflow.html — independently requires 320 px CSS width to work, which appears on **neither** list. |
| **Acceptance** | **Given** a breakpoint declaration (a token axis, since breakpoints are one of the six dimensions with zero tokens), **When** every `@media` width literal in source is compared against it, **Then** every literal is a member. The reviewer-facing list (390 / 820 / 1440 px) is a **different** list — widths a reviewer eyeballs, not widths the CSS switches at (owner ruling Q1-C) — so it is left as-is and is **not** asserted equal to the declaration. **And** 320 px is a member or the declaration records why it is not. |
| **Check** | A guard extracting `@media` width literals and the reviewer list, both compared against the declaration, with a non-vacuity floor on the count of literals found. Currently unenforceable in this form — the declaration does not exist, which is the requirement. |
| **Priority** | **MUST** — cheap, and until it lands every responsive review is aimed at the wrong widths. |

---

# I. A green suite is the floor, not the bar

### XR-VER-22 — Every design change is driven in a real browser, and every fixed defect leaves a guard that reds on its own return

| | |
|---|---|
| **Statement** | A design change is not complete until (a) the affected surfaces have been driven in a real browser at the declared breakpoints and the resulting frames read, and (b) each defect fixed by the change is covered by a guard that fails when the defect is reintroduced. |
| **Surfaces** | Phone remote, TV, operator dashboards |
| **Rationale** | Every real defect found lately was invisible to a passing suite and surfaced only by driving the app, so a green suite is evidence of no *known* regression, not of a working surface. |
| **Source** | `.kiro/autoloop/REVIEW-LOG.md`, four independent passes: one found a roving-tabindex group with zero tabbable members and a singer dot shrinking to a measured 0.00 px — recorded as "nothing asserts the dot is non-shrinking … both shipped green"; another found an inert 90vw cap and a toast covering 25 px of a 44 px Undo button, with `routes/page.test.ts:26` green on that button's 44 px; another a 23-character name growing the document 3 px and pushing the gear off screen; the last a 28 px slider and eight frozen live readouts. |
| **Acceptance** | **Given** a change to any `.svelte` or `.css` file in the register's scope, **When** it is proposed, **Then** it carries frames from a real render at each declared breakpoint for each affected surface, and a statement of what was read in them. **And Given** each defect the change fixes, **When** the fix is reverted and the suite run, **Then** at least one named test fails. **And** the frames satisfy XR-VER-18. |
| **Check** | The revert-and-observe arm is machine-checkable and is XR-VER-04's mutation record applied to the change. The "frames were read" arm is `EXEMPT` — presence of a frame is checkable, comprehension of it is not; the deferred judgment is a human's. **Probe methodology is part of the requirement, because three recorded passes produced confidently wrong numbers first:** `elementFromPoint` returns null outside the viewport, so hit-test after `scrollIntoView({block:'center'})`; test `hit === el \|\| el.contains(hit)` and never the reverse, which counts `<body>` as a hit and inflated a 32 px target to 93 px; `captureScreenshot`'s `clip` is in page coordinates while `getBoundingClientRect` is viewport-relative, so add `scrollX`/`scrollY`; and check an ancestor's `overflow-x` before calling a wide cell clipped, or a designed table scroll reads as twelve defects. |
| **Priority** | **MUST** for anything on a rendered surface. |

---

## Requirements I deliberately did not write, and why

- **A re-point requirement for `tests/e2e/contract.ts`** (~90 `SEL` entries, 44 `HOOKS`
  pairs). Already enforced and enforced *well*: `unmodelled` is asserted empty, so an
  unmodellable shape **reds rather than degrading** — the good failure mode. The only new risk is
  someone relieving the pressure by widening an allowlist, which XR-VER-06 already covers as a
  scope decrease.
- **Anything asserting the `--tap` number.** `charts/trend-tap-target.test.ts:32` already bridges
  the token to the guard, so the number cannot drift. What is unenforced is the *expression* — 11
  bare `44px` literals against 5 files using `var(--tap)` — and that is a token-layer requirement,
  not a verification one.
- **A guard for the six zero-token dimensions.** A "no literal that duplicates a token" guard can
  only compare against a token that exists, so `design-system.test.ts` passed *correctly* and
  reported nothing about the ~391 literals. The requirement is to mint the token axes; the guard
  follows for free and belongs with the axis, not here. Worth stating once as sequencing: **a new
  token axis lands with its guard in the same change**, or the ~391-literal backlog surfaces as a
  reviewer-facing wall of red. *(Five of the six axes have since landed — see `01-tv.md` Group 2.
  `font-family` and easing have not, so the sequencing rule still applies to them.)*
- **A `prefers-reduced-motion` coverage requirement.** Already both stated and enforced —
  `motion.test.ts` rejects the Svelte directives outright and three floors at `:220/:270/:497`
  keep its scope honest. XR-VER-15 adds only the class-name arm that is genuinely invisible today.
- **A threshold for the drawer's snap-point fidelity** (how close a reproduced peek must be to
  132 px). No basis for a number; XR-VER-17 makes the determination exist instead of inventing a
  tolerance.
- **Anything about the 3 open concurrency policies, host-gating of `PUT /api/settings`, or the
  missing aesthetic brief.** Genuinely undecided per §4; a verification requirement over an
  undecided policy would check conformance to nothing. The one adjacent thing worth flagging:
  `settings-slider-live-readout.test.ts` exists, and AT RISK 9 asks whether a library slider
  emits during drag — that is XR-VER-13's register job to carry, not a new row.
- **A number for how many at-risk entries must pass before adoption.** The handoff's own
  answer is the spike (§7 step 6), and a percentage gate would be invented. (The "19 at risk" is a
  count of at-risk **files**, per "Restating the retirement split" above; the at-risk *case*
  population is larger and un-recounted, which is why a fixed number here would be doubly invented.)
- **A re-derivation of the 128/68/27/19 buckets themselves.** Their **unit** is already resolved (files,
  not cases), as is the "242 == 242" coincidence (it does not hold at `3f6ee2f`; the
  repo-wide count is now 287 files / 2652 cases). Re-deriving the four buckets means re-bucketing
  the design-enforcing population by retirement fate on the current tree — the analysis owner's
  call, and unnecessary downstream: XR-VER-13's register surfaces the true 70-file / 624-case
  population, so nothing waits on the old buckets.

[OPTIONS: Resolve the 242 cases-vs-files collision first | Write the register file XR-VER-13 specifies | Show me the happy-dom zero-rect evidence in full]