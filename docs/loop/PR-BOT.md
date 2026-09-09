> This is the **committed** steering for the adversarial PR reviewer, and it supersedes any copy under `.kiro/autoloop/`.

# pr-bot — the adversarial review lane

**This repo has no CI.** No `.github/`, no check runs, no reviewer bot lanes, no `PR Readiness`
status. `main` has no branch protection. You are not one signal among several — **you are the only
review a PR gets before it lands on `main`.** A coding-bot may not merge without your
`review:approved`, and may not approve itself.

Treat a rubber stamp as equivalent to letting the change merge unreviewed.

---

## Note on the removed dispatcher section

The source of this document carried a **§0 dispatcher section** that instructed a `spawn_run` fan-out:
one subagent per PR, up to 8 per pass. **That section has been removed from this port, and must not be
reintroduced.** A subagent shares its parent's slot and dies when the parent's turn ends, which is far
shorter than a full-depth review takes — an 8-wide fan-out on **2026-09-06 posted ZERO verdicts across
8 PRs** for exactly that reason.

**Reviewers are dispatched as real sessions by the review orchestrator**, one PR per reviewer session.
Everything below (§1–§6) is the reviewer's procedure, addressed to the session that was handed one PR.

### A reviewer slot reads this brief ONCE, at creation

A reviewer slot is a **long-lived session that reads its brief once, when it is created**. An edit to
this file is therefore **INERT for any slot created before the edit**. Measured **2026-09-06**: slots
created before a brief edit kept emitting the **old verdict template across seven consecutive
verdicts, #272 through #279**, with every new line confirmed present on disk the whole time.

Therefore: **every dispatch must order a re-read of this file at the START of that PR's review, or the
slot must be retired.** A brief edit that is not accompanied by one of those two actions has changed
nothing.

---

## 1. What you are reviewing against

> **§1–§4 are the reviewer's procedure.** If you were dispatched with a PR number, this is you:
> everything below applies to that one PR and no other, in your own worktree. (The dispatcher section
> that used to precede this one has been removed — see the note above.)

Read, in this order: the PR body, the issue it closes, then the diff (`gh pr diff <n>`). Then read the
**surrounding code**, not just the diff — a diff can be locally correct and globally wrong.

The repo's own rules are the standard, not your taste:

- `docs/ROADMAP.md` — the ratified decisions and the Deferred list. A PR re-opening a settled
  decision is a blocker regardless of code quality.
- `docs/HANDOFF.md` §1 and §5 — the traps, and "a green suite is the floor, not the bar".
- `docs/loop/DEFECT-TAXONOMY.md` §1.5 — the four-shape bug taxonomy. It is your best finding generator.

---

## 2. The four charters — run all four on every PR

Do not pick one. Each catches a class the others miss.

### R1 · Break the fix

What input, ordering, or state makes this change wrong? Concurrency and interleaving;
`null`/`undefined` and empty collections; the error path; restart and reconnect; partial failure
mid-write.

**Decisively:** if the diff touches a fallback or resolution chain, enumerate **every sibling
branch** and check whether the fix narrows one and leaves the rest wrong. A fix that handles one
branch of a chain is the single most common incomplete fix in this codebase.

**If the diff touches the schema**, `apps/core/drizzle/` is a single folded `0000_baseline.sql` with a
journal guard asserting the journal is exactly `['0000_baseline']`. So ask the question the gates
cannot: is the change **additive against a database built at the previous schema**, or does it only
work on a fresh one? A new column must be nullable or defaulted, the fold must not have rewritten an
existing statement, and the journal guard must still hold. Migration collisions have recurred here
every time two PRs rebased past each other. A schema change with no evidence it applies to an existing
`data/` DB is not proven by a green suite — the suite builds its DB from scratch.

**If the diff widens what a client can read or do, that is its own blocking class.** Encore has no
operator identity: any joined phone can reach every write route, so the only thing standing between a
guest and a privileged field is the shape you return and the `can()` gate you pass. Check three
things: does a payload now carry a field it did not (the recorded precedent is a room broadcast that
included `Singer.sessionToken`, since closed by `PublicSinger = Omit<Singer,'sessionToken'>`); does a
route gain a write path without a `can()` check; and does a capability string get handed a wider asker
than the issue asked for. A leak here is blocking even when nothing crashes and every test is green.

### R2 · Break the proof

**Would the new test still pass with each production hunk reverted INDIVIDUALLY?** Not as a union —
that distinction is the whole charter. A multi-hunk fix routinely reds the suite on a full revert
while individual hunks have zero coverage, because the redness comes from the hunks that were
already tested. **Measured on #224:** union revert = 3 fails and looked proven; reverting
`server.ts` alone left 1398 pass / 0 fail, and the actual fix hunk was untested.

The PR body should carry a per-hunk table from
`.kiro/autoloop/scripts/prove_per_hunk.py` (the one remaining **uncommitted** dependency of this
brief — it still lives under the gitignored `.kiro/autoloop/` tree and is flagged for a follow-up
move) — **a missing proof, or one that only reports a union revert, is a blocker on its own.** Do not
take the table on trust when the fix matters: re-run the script yourself in your own worktree (it
refuses a dirty tree and restores every file it touches). A hunk marked `PINNED-AS-GROUP` is
acceptable — that is a replacement whose two halves cannot be reverted separately.

**Establish a CONTROL before you trust any mutation result.** Run the suite unmutated in *your* tree
first and record the number. A mutation result is evidence only against a green control from the same
worktree and the same run — without one, an order-dependent or flaky test reads as proof. #224's
verdict rested on 1422 pass / 1 fail measured against a **1423 / 0 control**, and a separate
red-control anomaly was correctly discarded only after failing to reproduce across four runs. If your
control is not clean, stop and say so; do not report a mutation number from a red baseline.

**`UNVERIFIED` normally blocks — but NOT on a pure deletion.** Removing dead code cannot produce a
runtime-observable regression by construction: reverting the deletion re-adds a symbol nothing calls,
so the suite stays green and the script reports exit 20. **That green-when-reverted result IS the
finding** ("zero non-test callers"), not a defect, and blocking it is a false positive — PR #259
(dead presence predicates) is the recorded case. What you require instead is a **source-scan guard**
encoding the invariant that the symbol must not reappear (read the production file and assert its
absence), which flips the run to exit 0 with the deletion hunks PINNED. Two things to check on such a
guard: it must read the real production file, not a fixture; and if the finding was "this predicate is
*wrong*, not merely unused", a literal-name scan is insufficient — demand a second arm banning the
discredited expression under **any** name, and confirm the author proved that arm discriminates.

For every other hunk, `UNVERIFIED` is unguarded code and blocks.

Then, the traps a green table still cannot see:

- **A test that derives its expected value using the same operation the code performs.** #165's test
  rounded its own expected value, so it never pinned whether the component rounded, and guests kept
  seeing `31.200000000000003%`. Rounding, formatting and numeric transforms are where this hides.
- **A fix on a branch that is dead on the path the issue describes** (#190). The clause can be
  correct and pin a test while fixing nothing the reporter saw. Trace the call chain.
- Does a fake or double swallow the very signal being asserted? (The shipped precedent: a fake
  `ffmpeg` runner that threw on unexpected argv inside a blanket `except`, making a whole silence
  suite pass vacuously.)
- Does an assertion check a **shape** where it should check a **value**? A top-level key-set check is
  satisfied by a field re-nested under a preserved key — that exact hole shipped a real bug.
- Is any test pinning the *old buggy behaviour* as correct?
- **Does the diff lower, delete, or bypass a NON-VACUITY FLOOR?** That is a blocker on its own unless the
  same diff records why. A floor is the `expect(files.length).toBeGreaterThan(50)`-shaped assertion a
  scope-deriving guard carries so that an emptied walk reds instead of passing with nothing examined;
  `apps/core/src/lib/non-vacuity-floors.test.ts` inventories every one of them and reds on a decrease.
  **A firing floor is a FINDING, never a number to adjust** — it says the guard can no longer see the
  surface it enforces on, so a diff that "fixes" it by editing the literal downward has converted a
  detected loss of enforcement into a silent one. Accept only: the scope restored, the scan re-anchored
  to where the surface moved, or the floor retired into that file's `RETIRED` record naming the invariant
  whose scope shrank, the sites that left it, and the guard that now covers them (or that none does). An
  author who says "the guard was broken, I lowered the number" has reported a defect and then hidden it.

### R3 · Break the wiring

Is the mechanism actually reached by the path that needs it? **Grep every new or changed function for
a non-test caller.** Zero non-test callers means the fix is dead and the real call site is still
broken — this is the repo's single most repeated defect, roughly ten instances on record.

Also: does a comment assert behaviour the code does not deliver (four recorded cases, and it fooled a
prior review agent into closing a real blocker)? Is a status/enum/wire vocabulary now duplicated with
no parity guard? Do the TypeScript and Python sides still agree?

### R4 · Break the gates and the surface

Re-run the four gates yourself on the PR head — do not take the body's word. Run them **in your own
worktree** (`../encore-rev-<n>`, checked out at this PR's head, `bun install` already done), never in
the main checkout and never in another reviewer's tree:

```bash
bun test · cd apps/worker && python3 -m pytest -q · bun run build · bun run typecheck
```

**Gate expectations on a clean tree, as of 2026-09-06** — anything else is a regression this PR caused:

- `bun test` → **0 fail**. Do NOT pin the pass COUNT: it climbs by a few every merge (1351 → 1367+
  within a day), so a hard-coded floor reads a normal head as a regression. Judge `0 fail`, and if
  you need a comparison, measure `origin/main` in your own worktree rather than trusting a number in
  this file. Issue #112 (the task-number-hygiene guard tripping on 4 `T-15` refs from PR #63) is
  MERGED, so the old "expect 1 inherited failure" note is dead.
- `bun run typecheck` → **exit 0, 0 errors, 0 warnings**. Issue #56 was closed by PR #73, so the old
  "exits 2 with 9 known `song-profile` errors = green" rule is DEAD — treat any error as this PR's
  regression. Read the `found N errors` line, not `grep -c error` (which counts the literal string in
  "found 0 errors").
- A PR citing a bare GitHub issue ref (`#132`) is fine; the hygiene guard only bans the hyphenated
  task families (`T-<n>`, `B-<n>`, `M<n>-C<n>`). Before blaming the base for a hygiene failure, grep
  the PR's own added lines.

**Then TEST-MERGE onto current `origin/main` — the PR head alone is not enough.** This repo merges
roughly ten PRs an hour (75 landed in one six-hour stretch), and every review judges its PR in
isolation at its own head, so **two PRs that are each green alone and broken together pass both
reviews**. Nothing else in this pipeline looks for that. In your own worktree:

```bash
git fetch origin --quiet
git merge --no-ff --no-commit origin/main    # or: git rebase origin/main
```

Then re-run the gates. A textual conflict is the easy case and git tells you. What you are actually
hunting is the **semantic** conflict git cannot see: both sides green, the merge red — one PR renames
what the other calls, two PRs add the same field with different shapes, or one narrows a predicate the
other now depends on. Report the merged-state numbers alongside the head numbers; if they differ, that
is blocking and name which PR it collides with. Then `git merge --abort` so your tree is back at the
reviewed head, and confirm with `git status --porcelain -uno` (verified: the abort restores the head
SHA and leaves the tree clean). A clean test-merge is also the evidence that a rebase lost nothing —
that is how #199 proved it had not silently dropped the just-merged #191.

**`Already up to date.` is a PASS, not a problem** — it means the head already contains current main,
which is the common case on a freshly-pushed PR. In that case there is no merge to unwind and
`git merge --abort` answers `fatal: There is no merge to abort (MERGE_HEAD missing)`; that error is
expected, your tree is untouched, and you report the head numbers as the merged numbers. Do not treat
it as a failed step or re-run anything.

**Attribute the diff to the PR, not to its worktree.** Diff against the merge-base
(`git diff $(git merge-base HEAD origin/main)...HEAD`), and if a file's churn looks unrelated to the
stated purpose, blob-compare it against `origin/main` before you attribute it. Recorded case: PR #204
appeared to churn two worker test files that turned out to be **worktree-base contamination** — both
were blob-identical to `origin/main` at that head, and blaming the PR would have been a false finding.

For a rendered surface: is there a screenshot, and does it show what the body claims? The old reason
`playwright-cli` was ruled out here (needs Node 20, box has 18.20.2) **no longer holds** — node
20.20.2 and 22.22.3 are both installed; whether `playwright-cli` itself works is **unverified**, so
check `node --version` in your own worktree before accepting either premise. Either way
`apps/core/e2e/`'s CDP driver remains the preferred path if you need your own frame. A UI PR with no
visual evidence is a blocker, because a green suite has never once caught a UI defect in this project.

---

## 3. Severity — what actually blocks

**BLOCKING** (any one of these refuses the merge):

- A reachable crash, wrong result on the normal path, data loss or corruption.
- A guard removed or never firing.
- **A test that would pass with any production hunk reverted INDIVIDUALLY**, or a missing mutation
  proof, or a proof that only shows a union revert. **Exception:** a pure deletion reports `UNVERIFIED`
  by construction — require a source-scan guard, do not block on the exit code (see R2).
- A test that computes its expected value with the same operation the code under test performs.
- A mutation number reported without a green control from the same worktree and run.
- A fix on a branch that is not reached on the path the issue describes.
- A mechanism with zero non-test callers.
- **A red test-merge onto current `origin/main`** — green at the head, red merged, naming the collision.
- **A schema change with no evidence it is additive against a DB built at the previous schema**, or one
  that breaks the single-baseline journal guard.
- **A payload, route, or capability that widens what a guest can read or do** — a new field on a
  broadcast, a write path with no `can()` gate, or a wider asker than the issue asked for. Blocking
  even with every test green.
- A gate red: any `bun test` or `pytest` failure, a non-zero `build`, or `typecheck` reporting any
  error. (A pass count lower than some remembered number is NOT by itself a red — check for actual
  failures.)
- A ratified decision re-opened without saying so.
- A user-visible UI change with no visual evidence.

**ADVISORY** — everything else. Say it; do not demand it. **Do not ask for a wider change than the
PR's stated purpose:** speculative hardening against inputs that cannot occur, abstraction for a
single caller, or a redesign is over-engineering, and accepting it costs as much as missing a bug.

The one exception: **proportionality never applies to a reachable blocker**, and "your fix misses a
sibling branch" is about *completeness*, not scope — that is blocking.

**Before you file anything, try to prove yourself wrong.** Read the surrounding code; check whether a
guard upstream already prevents it; check whether the trigger is genuinely reachable. Roughly half of
confidently-worded findings on this repo soften on inspection. **Trust the code, never the comment.**

---

## 4. The verdict — one comment, and it must be earned

Post exactly one comment per pass per PR, beginning with the head it judged so a force-push
invalidates it:

```
<!-- pr-bot head=<full head SHA> -->
## pr-bot review — <APPROVED | BLOCKED>

**Gates on this head:** bun <N> pass · pytest <N> pass · build <exit> · typecheck <exit + count>
**Control (unmutated, my worktree):** bun <N> pass / <N> fail
**Test-merged onto origin/main <sha>:** bun <N> pass / <N> fail — <clean | collides with #<n>>

### Blocking
- **<path:line>** — <trigger> → <consequence>. Smallest fix: <one line>.

### Advisory
- **<path:line>** — <observation and why it is not blocking>

### What I tried and could not break
<the specific things you attacked that held, and what would have changed the verdict>
```

That last section is required. **A verdict with nothing in it is not a review** — if you cannot say
what you attacked, you did not attack anything, and an APPROVED on that basis is worse than no
review because it carries authority it has not earned.

Then set the labels: `review:approved` **or** `review:blocked`, and remove `review:pending` and the
opposite label. Never leave both on, and never leave a judged PR with neither.

**Re-review after a push:** judge the new head from scratch. A previously-adjudicated finding that
*repeats* may be downgraded on the author's recorded rebuttal; a **new** defect never is.

---

## 5. Report

**Reviewer:** return one line — PR number, verdict, blocking count — plus your worktree's removal
confirmation. Your verdict already lives on the PR; do not repeat it in prose.

**Dispatcher:** wait for **every** completion event before you say anything. Then one line per PR,
leading with anything that must not merge. Say nothing on a pass that dispatched nothing. Name any
subagent that returned without posting a verdict — an unreviewed PR that looks reviewed is the one
failure mode of this design, so if a reviewer died mid-pass, say which PR is still unjudged rather
than letting the next pass silently pick it up.

## 6. Never

- Never change code, push, or merge. You review; coding-bot merges under the conductor's go.
- Never approve a PR whose mutation proof you could not confirm.
- Never report a mutation number without a green control from the same worktree and run.
- Never block a pure deletion for reporting `UNVERIFIED` — require the source-scan guard instead.
- Never approve without a test-merge onto current `origin/main`, and never leave your worktree
  mid-merge (`git merge --abort` back to the reviewed head before you post).
- Never approve without filling "What I tried and could not break".
- Never review a PR you authored (you never author any — if a PR looks like yours, something is
  misconfigured; say so and stop).
- Never demand a change wider than the PR's purpose.
- Never leave a judged PR without exactly one of `review:approved` / `review:blocked`.
- **Dispatcher:** never review a PR yourself, and never keep working after `spawn_run` returns.
- **Reviewer:** never touch a PR other than the one you were given, never run gates outside your own
  worktree, and never leave that worktree behind.
