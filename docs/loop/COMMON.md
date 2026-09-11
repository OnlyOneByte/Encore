# Common rules — every lane

Committed steering. This is the shared layer: defect classification, severity, gate discipline and
merge safety. It supersedes the equivalent sections of the retired `.kiro/autoloop/LOOP.md`.

Every lane brief in this directory points here rather than restating these rules, because a rule
restated in five places drifts in four of them. If a lane needs a rule that contradicts this file,
that is a bug in one of them — say so rather than following the closer copy.

Deliberately **not** ported from the old serial-loop brief: its one-item-per-cycle procedure and its
ledger-queue mechanics. That loop no longer runs. What survived is below.

## Defect taxonomy — hunt the shape, not the instance

Six live reports collapsed into four recurring shapes. Each has a **detector** — the test that finds
that shape rather than that instance. The detector is the useful half.

**1. Derived state that is accumulated instead of computed.** A value carried in an accumulator when
it should be a function of the clock. Seen as a per-step percentage displayed as overall progress, and
as a TV lyrics scroll offset held in an `rAF` accumulator rather than derived from `currentTime`.

> **Detector:** assert `render(t)` is **path-independent**. Reach the same `t` by two different
> histories — seek versus play, or background the tab and return — and require identical output.

**2. A decision made from the wrong source — config where data was needed.** A per-item question
answered from a global setting. Seen as a word-highlight clamp reading a fleet-wide `syncMode` instead
of whether *this song* has word stamps.

> **Detector:** for every capability gate, ask *whose* capability it reads. A global answer to a
> per-item question is a bug **even when the global happens to be right**.

**3. Transitions handled where steady state was.** An invariant maintained on the steady path but not
across a transition. Seen as a seek repositioning the instrumental but not the guide.

> **Detector:** enumerate the transitions — seek, restart, skip, pause, reconnect, song change, slot
> swap — and assert the invariant *across* each one. Steady-state tests pass straight through these.

**4. Silent degradation with no report.** A deliberate fallback that is invisible. Seen as a suspended
`AudioContext` leaving transpose inert while audio kept playing.

> **Detector:** wherever code degrades on purpose, confirm the degradation is visible on screen or in
> an operator-visible log.

Two cross-cutting greps worth running on any diff: a UI control offering an option the data cannot
honour, and two surfaces deriving the same status independently.

## Severity — exactly one label per issue

| Label | Use for |
|---|---|
| `user-facing` | a defect a singer in the room can see — **or** a test that gives false safety, because a vacuous pass is a functional problem, not a tidiness one |
| `internal` | no visible symptom: a mechanism with no non-test caller, duplicated vocabulary with no parity guard, a layer boundary crossed, dead weight, an unguarded invariant, a comment contradicting its code, missing coverage of a real path |

**A `user-facing` defect outranks all `internal` work, regardless of arrival order.**

`priority` is the owner's queue-jump. **An agent must never apply it to its own finding** — doing so
removes the owner's only way to steer the queue.

## The gates

Five, and all five every time. The full suite is cheap here, so narrowing it buys nothing and costs
the only safety net the repo has.

```bash
bun test                                # expect 0 fail
cd apps/worker && python3 -m pytest -q  # expect 0 fail
bun run build                           # expect exit 0
bun run typecheck                       # expect exit 0, 0 errors, 0 warnings
bun run gate:measured                   # expect exit 0 — the layout rung, AFTER build
```

`gate:measured` is the fifth gate (owner ruling Q1 = A). It boots its own ephemeral
server and its own headless Chromium and MEASURES the four claims a source scan cannot decide —
rendered control heights, computed field font size, the drawer's viewport cap and safe-area term, and
the focus ring's painted form. **It has no skip path**: a missing Chromium, an unbuilt app or a
server that will not boot are FAILURES, because option B — skip when the environment is missing — is
the shape `tests/guards/hygiene/contract.test.ts:23` already ruled is indistinguishable from silent rot. Run
it after `bun run build`; it drives the real bundle.

### Measurement discipline — three rules, each from a real false pass

- **Read exit codes, never piped output.** `cmd | tail` makes `$?` *tail's* status, so a failing gate
  reads as green. Redirect to a file, test `$?`, then read the file.
- **Never trust a pinned test count — re-measure.** Counts move by tens within an hour. A pinned floor
  reads a normal head as a regression. Judge `0 fail`, not a number.
- **A firing NON-VACUITY FLOOR is the exception, and it is a FINDING, never a number to adjust.** The
  rule directly above is about *suite pass counts*, which drift innocently. It does **not** extend to a
  floor assertion inside a guard — `expect(files.length).toBeGreaterThan(50)` and its ~21 siblings,
  inventoried in `tests/guards/meta/non-vacuity-floors.test.ts`. Those guards derive their own scope by
  walking a tree, then assert an `offenders` array is empty; an empty array is what a working guard
  produces *and* what a guard examining nothing produces, so the floor on the size of what was examined
  is the only thing separating the two. A firing floor therefore does not mean the guard broke. It means
  **the guard can no longer see the surface it was enforcing on** — a real defect it just caught.
  Restore the scope, or re-anchor the scan to where the surface moved, or retire the floor on the record
  in `non-vacuity-floors.test.ts` (`RETIRED`, with the invariant, the sites that left scope, and what
  covers them now). Lowering the literal to make the red go away converts a *detected* loss of
  enforcement into a *silent* one, which is worse than never having planted the floor.

- **For typecheck, read the `found N errors` line**, not `grep -c error`, which counts the literal
  string inside "found 0 errors". `bun run typecheck` also chains `typecheck:e2e`, so `svelte-check`
  can print "0 errors" while the chained leg fails — confirm the whole chain exits 0.

**The old baseline is dead.** Any brief claiming `bun run typecheck` exits 2 with exactly 9 known
`@encore/shared` `song-profile` errors and that this counts as green is stale — that was issue #56,
closed by PR #73. Any error is now a regression, and fixing it outranks the assignment.

## Proof — a fix is not done until the test bites

A regression test must be **red on base** and **per-hunk mutation-proven**. Union-reverting all hunks
proves nothing about any individual hunk: measured, a union revert reddened 3 tests while
reverting `server.ts` alone left 1398 pass / 0 fail.

The harness is `.kiro/autoloop/scripts/prove_per_hunk.py` *(the one remaining uncommitted dependency —
flagged for a follow-up)*. Exit `0` every hunk reds a named test · `20` a hunk is unverified, which is
**blocking**, not advisory · `30` HEAD is not green. `PINNED-AS-GROUP` is normal for a replacement.

The sole exception is a **pure deletion**, whose exit 20 is expected: close it with a source-scan guard
that reads the real production file.

Three things the harness cannot check, all of which have shipped bugs:

- Never derive an expected value with the same operation the code performs.
- Trace that the fixed code is actually **reached** on the issue's path.
- Name the failing assertion per hunk.

## Merge safety

`main` has **no branch protection**. The label gates plus an independent verification are the entire
safety system — nothing external will catch a bad merge.

- **A red `main` outranks the queue.** Prefer `git revert` of the offending squash commit, through
  branch → PR → merge. Leaving a red `main` for another agent to trip over is the worst available
  outcome.
- **Re-run all five gates after a rebase.** The gates that passed pre-rebase were measured against a
  base that no longer exists, so criterion "gates green" fails silently otherwise. The repo merges
  roughly 10 PRs an hour, so a branch green an hour ago can be semantically stale.
- **Serialize merges with an atomic lock.** `until mkdir "$LOCK"` … `sleep 20`, retrying about ten
  minutes and then leaving the PR open. Release on **every** exit path (`trap … EXIT`): a lock leaked
  by a crashed agent stalls every later merge until the breaker clears it. The breaker is
  `find "$LOCK" -maxdepth 0 -mmin +20` → `rmdir`.
- **Grep for conflict markers** before committing a resolution:
  `git grep -nE '^(<{7}|={7}|>{7})'`. Never `git add -A` after a scripted resolution.

## `SKIPPED` — stop re-attempting the same span

Three failed attempts in the same `file:function` retires the item to `SKIPPED`. **Never
re-investigate a `SKIPPED` entry** — check against it before starting work. Without that record, the
fourth patch attempt happens.

## Unresolved — needs an owner ruling

The large tickets `T-4` (rename), `T-5` (rooms), `T-6` (duets) and `T-7` (UI rewrite) are described
three contradictory ways across the retired briefs: one section says nothing is fenced off by size any
more and names them as dispatchable, another says they are too large to start, and the fleet brief says
never to touch them. **This is unresolved.** Do not pick a side on your own authority — surface it.
