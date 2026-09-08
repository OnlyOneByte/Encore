# Drift

Contradictions between the loop's briefs, and between a brief and what is actually running. Every
entry here was found by reading two sources that disagree.

These are recorded rather than silently fixed, for two reasons: an agent reads the brief, not this
file, so a fix has to land in the brief to matter; and several entries are a judgement call about
which side is right.

Ordered by what a wrong answer costs.

## 1. The typecheck baseline — a stale rule that accepts real errors as green

| Source | Claim |
|---|---|
| `LOOP.md` gate baseline | `bun run typecheck` → **exit 2 expected, exactly 9 known errors**. Same 9 lines = green |
| `CODING-BOT.md` | That rule is **DEAD** (issue #56, closed by PR #73). Expect **exit 0, 0 errors, 0 warnings**; any error is a regression you caused |
| `PR-BOT.md` | Agrees with `CODING-BOT.md`: exit 0 / 0 errors / 0 warnings |

**`LOOP.md` is stale.** A worker following it would accept nine real type errors as a green gate.
Two against one, and the newer sources name the issue and PR that closed it.

**Status: FIXED 2026-09-08.** `LOOP.md`'s gate block now reads `exit 0, 0 errors, 0 warnings`, states
that the old rule is dead and names #56 / PR #73, and carries the two measurement traps that go with
it: read the `found N errors` line rather than `grep -c error` (which counts the literal string inside
"found 0 errors"), and remember that `bun run typecheck` chains `typecheck:e2e`, so `svelte-check` can
print "0 errors" while the chained leg fails. The same edit dropped the pinned "536 worker tests"
figure that contradicted the block above it — see #10 — rather than replacing it with a number that
would go stale again.

Worth noting that the section had already asked to be fixed: *"Once a cycle fixes them, **update this
section and the ledger** so the new baseline is `exit 0`."* The cycle fixed them; nobody updated the
section. That is the drift mechanism in one sentence.

Compounding trap, from `CODING-BOT.md`: read the `found N errors` line, **not** `grep -c error`,
which counts the literal string inside "found 0 errors". And `bun run typecheck` chains
`typecheck:e2e`, so `svelte-check` can print "0 errors" while the chained leg fails.

## 2. `triaged` — the rule and the live crons disagree about who may apply it

| Source | Claim |
|---|---|
| `REVIEW.md` §4 | *"**Never apply `triaged` yourself.** That label belongs to the triage cron alone: it is the one writer, so a `triaged` label always means the triage pass has seen the issue."* |
| Live ISSUEGEN cron messages | Instruct reviewers to apply it themselves — *"you are the triage for your own finding"* |

The cron messages predate the one-writer rule and drifted. Consequence: those passes **forge** the
signal, and the dispatch gate keys on exactly that label — so an issue can be dispatched as
"triage has seen this" when triage never has.

Of the current fleet, `ISSUEGEN-e2e-behavior` (`d2a58be7`) follows `REVIEW.md` correctly; the others
were left alone rather than silently rewriting live jobs.

**Status: NEUTRALIZED 2026-09-08, not yet fixed at source.** `REVIEW.md` §4 now names the
contradiction and supersedes it explicitly — it says that a cron message telling you that you are "the
triage for your own finding" is stale, that this rule wins, and that the contradiction is not licence
to choose. Because each ISSUEGEN pass runs in a **fresh** session it re-reads `REVIEW.md` every time,
so this takes effect on the next pass — unlike a brief edit aimed at a long-lived session, which would
be inert (see #9).

**The four cron messages themselves are still wrong**, and correcting them needs the cron registry,
which is credential-fenced to every reader available here. Rewriting them blind would have destroyed
charter text that cannot be read back. That step is the owner's:

> Dashboard → **Schedule**, or `kirocrew cron update <id> --message "<corrected text>"`, for
> `516cbfbd` (ui-design), `debbdb80` (core-arch), `0593a3f6` (worker-arch) and `997a93c4`
> (code-quality) — remove the instruction to self-apply `triaged`. `d2a58be7` already reads correctly
> and is the model to copy.

Until then the SOP supersession is what holds, and that is weaker than agreement: it relies on the
reviewer reading §4 and preferring it over its own prompt.

## 3. `max_in_flight` — the stored value and its own comment disagree

| Source | Value |
|---|---|
| `pipeline-issue-fix.json`, stored | **5** |
| `pipeline-issue-fix.json`, prose comment in the same file | *"max_in_flight is 3, NOT the 8 default"* |
| `CONDUCTOR-SEED.md` | 3 |

The scheduler obeys the stored value, so the effective cap is **5** while two documents say 3. Since
the stated reason for the low cap is that the box is the binding limit — each worker runs
`bun install`, the full suite and a build — the gap matters.

**Status: RECONCILED 2026-09-08, upward, and one question left open.** The comment now says 5, matching
the stored value. The direction was deliberate: reconciling *downward* to 3 would have cut dispatch
throughput as a side effect of a documentation fix, so the running behaviour was preserved and the
stale prose corrected to match it. `governance` was not touched — `max_in_flight` is still 5.

What that surfaced: there is a **third** value. The conductor's live patrol context tops up toward
**10**, which is neither 3 nor 5 and is an unratified override. `CONDUCTOR-SEED.md` still says 3. So
the honest state is that four sources now hold three different numbers, with 5 in the spec and 10 in
practice. **Which number is right is a call about how hard to push the box, and belongs to the owner.**

## 4. The scope fence — is anything still fenced off?

| Source | Claim |
|---|---|
| `LOOP.md` §1.6 | *"Nothing is fenced off from the loop by size any more… **everything is loop-dispatched**"*, naming `T-4` rename, `T-6` duets, `T-7` UI rewrite specifically |
| `LOOP.md` §1 scope fence | `T-4`–`T-7` *"are too large for this loop's diff cap… do not start them"* |
| `FLEET.md` "Do not" list | *"Never touch `T-4` (rename), `T-5` (rooms), `T-6` (duets), `T-7` (UI rewrite) — **P4, the owner's to open**"* |

`LOOP.md` contradicts **itself** between two sections, and `FLEET.md` sides with the older one while
invoking `P4`, a rung retired on 2026-09-07. Unresolved: an agent can justify either behaviour on
the big tickets.

## 5. ISSUEGEN's interval — the noise rationale is based on a schedule that no longer exists

| Source | Claim |
|---|---|
| `REVIEW.md` | *"You run every 30 minutes"*, 48 passes/day/reviewer; the silence rule is justified as *"five reviewers × 30 min = 240 notifications/day"* |
| Live crons | Every **4 hours** — 6 passes/day/reviewer, ~30/day across the fleet |

Verified against the live schedule: the five ISSUEGEN crons fire on staggered 4-hour offsets, not
every 30 minutes. The silence rule is still right, but the arithmetic behind it is off by 8×, and any
reasoning that depends on pass frequency (how quickly a slice gets re-read, how stale a `slice-sha`
can be) is wrong in the brief.

## 6. The triage cron's name

| Source | Name |
|---|---|
| `LOOP.md` | `encore-issue-triage` |
| Live | `TRIAGE-IssueTriager` (`3ba751b0`) |

The interval agrees (15 min / 900s). Only the name drifted — but a grep for the documented name
**false-misses**, which is exactly how a stale job gets assumed dead.

## 7. `review:pending` has no writer in either brief

`PR-BOT.md` requires *removing* it, and the label is what puts a PR in the review lane's view. Neither
brief says who **applies** it.

In practice the worker must add it immediately after `gh pr create` — learned the expensive way on
issue #707, where a freshly-opened PR with no label was invisible and the worker babysat a verdict
that never came. That requirement currently lives only in the conductor's patrol context, not in
either brief.

Stage 3 makes this moot: `pull_request.opened` cannot be missed.

## 8. `PR-BOT.md` §0 is wrong for the current review model

The spec loads *sections 1-4 and 6 only*, because §0 instructs a `spawn_run` fan-out that does not
work here — a subagent shares the parent's slot and dies when the parent's turn ends. An 8-wide
fan-out on 2026-09-06 posted **zero** verdicts for exactly that reason. Reviewers must be real
sessions.

The wrong instructions are still in the file, relying on every dispatch to exclude them.

## 9. A brief edit is inert for a running reviewer

A reviewer slot is long-lived and reads its brief **once, at creation**. Measured 2026-09-06: an edit
to `PR-BOT.md` at 07:36:42 left slots `chat-110` and `chat-168/169/170` emitting the old verdict
template across seven verdicts (#272–#279).

So editing a brief is not deployment. Every dispatch must order a re-read and name what changed, or
the slot must be retired. This is a property of the system, not a contradiction — but it is the
reason several entries above have survived being "fixed".

## 10. Pinned test counts are stale everywhere, by design

| Source | Core tests | Worker tests |
|---|---|---|
| `LOOP.md` §1.5 / §2 | 1307 | 536 |
| `LOOP.md` §2 baseline block | — | 542 passed, 1 skipped |
| `CODING-BOT.md` | ~1351 | ~540 |
| `PR-BOT.md` | notes 1351 → 1367+ **within a day** |  |

`LOOP.md` disagrees with itself on the worker count. The correct reading is the one all three briefs
converge on: **never trust a pinned count — judge `0 fail` and re-measure.** A pinned floor reads a
normal head as a regression.

## 11. `playwright-cli` — the stated reason it cannot be used is retired, the conclusion is unverified

Both briefs retire the original premise (needs Node 20, box had 18.20.2) because Node 20.20.2 and
22.22.3 are now installed. Neither confirms whether `playwright-cli` actually works. The repo's
zero-dependency CDP driver in `apps/core/e2e/` remains preferred regardless.

Marked **unverified** rather than promoted to either answer. Check `node --version` yourself.

## Status summary

| # | Item | State |
|---|---|---|
| 1 | Typecheck baseline in `LOOP.md` | **Fixed** 2026-09-08 |
| 2 | ISSUEGEN crons forging `triaged` | **Neutralized** in `REVIEW.md` §4; the four cron messages still need the owner |
| 3 | `max_in_flight` | **Reconciled** to 5; a third value (10, in the live patrol context) needs the owner's ruling |
| 4 | The scope fence on `T-4`–`T-7` | Open — needs a ruling, then all three sources aligned |
| 5 | ISSUEGEN interval | Open — correction of fact |
| 6 | Triage cron name | Open — correction of fact |
| 7 | `review:pending` has no writer | Resolved by migration stage 3 |
| 8 | `PR-BOT.md` §0 | Resolved by migration stage 2 |
| 9 | Brief edits are inert for a running session | Structural — the reason several of these survived being "fixed" |
| 10 | Pinned test counts | Partly addressed: `LOOP.md`'s contradicting figure was dropped in #1 |
| 11 | `playwright-cli` | Open — unverified, needs one measurement |

Two of the three items closed on 2026-09-08 were closed **in a brief**, not in the mechanism. Item 2
in particular is a supersession rather than an agreement: the cron messages still say the wrong thing
and are only overridden by an SOP the reviewer also reads. Prefer fixing the mechanism when the
mechanism is reachable.
