# Review lanes — migration stage 3

Two different things share the word "review", and conflating them causes real confusion:

| | **PR reviewer** | **ISSUEGEN passes** |
|---|---|---|
| Brief | `.kiro/autoloop/PR-BOT.md` | `.kiro/autoloop/REVIEW.md` |
| Input | One open pull request | One slice of the codebase |
| Output | One verdict comment + labels | **New issues** |
| Touches a PR? | Yes | Never |
| Log | — | `.kiro/autoloop/REVIEW-LOG.md` |

Part A is the first. Part B is the second.

---

# Part A — the PR reviewer

Adversarial review of an open PR. It is the **only** review a PR gets before merge, because Encore
has no CI.

## The four charters — all four run on every PR

**R1 · Break the fix.** What input, ordering or state makes the change wrong: concurrency and
interleaving, `null`/`undefined`/empty collections, the error path, restart and reconnect, partial
failure mid-write. If the diff touches a fallback or resolution chain, **enumerate every sibling
branch** — an incomplete chain fix is the most common defect here. Schema diffs: is it additive
against a DB built at the previous schema, is the folded `0000_baseline.sql` intact, does the journal
guard still hold. Privilege widening is its own blocking class since Encore has no operator identity
— a payload gaining a field (precedent: a room broadcast leaking `Singer.sessionToken`, closed by
`PublicSinger = Omit<Singer,'sessionToken'>`), a route gaining a write path with no `can()` gate, or
a capability string gaining a wider asker than the issue asked for.

**R2 · Break the proof.** *Would the new test still pass with each production hunk reverted
**individually**?* Not as a union — that distinction is the charter. Requires the per-hunk table from
`prove_per_hunk.py` and a **green control from the same worktree and the same run**. `UNVERIFIED`
blocks, except on a pure deletion where green-when-reverted *is* the finding and a source-scan guard
is required instead. Also hunts: a test deriving its expected value the way the code does (#165); a
fix on a branch dead on the issue's path (#190); a fake swallowing the asserted signal; a **shape**
assertion where a **value** check was needed; a test pinning the old buggy behaviour.

**R3 · Break the wiring.** Is the mechanism reached? **Grep every new or changed function for a
non-test caller** — zero non-test callers means the fix is dead, with roughly ten instances on
record. Also comments asserting behaviour the code does not deliver (four cases, one of which fooled
a prior review agent into closing a real blocker), and duplicated status/enum/wire vocabulary with no
parity guard.

**R4 · Break the gates and the surface.** Re-run all four gates **in the reviewer's own worktree**
`../encore-rev-<n>`, then **test-merge onto current `origin/main`**
(`git merge --no-ff --no-commit origin/main`), re-run the gates, hunt the *semantic* conflict git
cannot see, `git merge --abort`. `Already up to date.` is a pass, and the abort's `MERGE_HEAD
missing` error is expected. A UI PR with no visual evidence blocks.

## Verdict contract — exactly one comment per pass per PR

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
<the specific things attacked that held, and what would have changed the verdict>
```

The last section is **mandatory**: a verdict with nothing in it is not a review, and an `APPROVED`
without it is worse than no review at all.

Labels: set `review:approved` **or** `review:blocked`; remove `review:pending` **and** the opposite
label. Never both, never neither.

The `<!-- pr-bot head=<sha> -->` marker is load-bearing twice over: it scopes the verdict to the head
it judged, and the freshness check greps for that literal `head=` string. **Do not change it** — see
[`TRIAGE.md`](TRIAGE.md#the-marker-rule--required-and-not-a-security-control).

## Blocking vs advisory

**Blocking:** a reachable crash, wrong result on the normal path, or data loss/corruption · a guard
removed or never firing · a test that passes with any hunk reverted individually, a missing mutation
proof, or a union-only proof · a test computing its expected value the way the code does · a mutation
number with no green same-run control · a fix on a branch not reached on the issue's path · a
mechanism with zero non-test callers · a red test-merge onto current `origin/main`, naming the
collision · a schema change with no evidence it is additive · a payload, route or capability widening
what a guest can read or do — blocking **even with every test green** · any gate red · a ratified
decision silently re-opened · a user-visible UI change with no visual evidence.

**Advisory:** everything else — *say it, do not demand it.* No demand wider than the PR's stated
purpose: no speculative hardening, no abstraction for a single caller, no redesign. The sole
exception is that proportionality **never** applies to a reachable blocker, and "your fix misses a
sibling branch" is completeness, therefore blocking.

Before filing anything, try to prove yourself wrong — roughly **half** of confidently-worded findings
soften. **Trust the code, never the comment.**

## Hard limits

Never change code, push, or merge. Never approve on an unconfirmed mutation proof; never report a
mutation number without a green control; never block a pure deletion for `UNVERIFIED`; never approve
without a test-merge; never review a PR you authored; never demand a wider change; never leave a
judged PR without exactly one of the two labels. Caps: **≤8 PRs per pass**, oldest head first, cut to
3 when `resource_status` reads `tight` or `critical`.

Reviewers run the gates **in the PR's existing `../encore-bot-<n>` worktree** — it is already at the
head and has `node_modules` — after confirming `git status --short` is clean and `HEAD` equals the PR
head. Never write in a bot worktree; fall back to a private `../encore-rev-<n>` if it is dirty.

---

# Part B — ISSUEGEN: scheduled code review that files issues

Five charters, one cron each. Each pass reads one slice of the codebase and files what it finds.

| Charter | Scope |
|---|---|
| `rev:ui-design` | Rendered appearance, rotating through `src/lib/components` · `src/lib/tv` · `+page.svelte`+`join` · `routes/tv` · `settings` · `stats`+`metrics` · `src/lib/ui`+`app.css` |
| `rev:core-arch` | Structure — plus vacuous-test findings, since no test charter is scheduled |
| `rev:worker-arch` | The Python worker's enforcement invariants |
| `rev:e2e-behavior` | Drives the running app; autoplay honesty outranks everything; fuzz with the RNG seed printed on line 1 |
| `rev:code-quality` | Cost to the next developer; every finding must name a structural guard that **reds on base** |

## Rotation

1. Any slice never reviewed → take the first.
2. All reviewed → take the first whose files **changed**, comparing the logged `slice-sha` against
   `git log -1 --format=%h -- <the slice's paths>`.
3. Nothing never-reviewed and nothing changed → **stop silently.**

`rev:e2e-behavior` is exempt from the path-keyed form: it uses a coarse union sha over
`apps/core/src packages/shared` and rotates one flow per pass unconditionally, stopping only when the
union sha is unchanged **and** every flow has been driven at that sha. Path-keying it would either
freeze the reviewer or re-file the same finding many times a day.

## Filing bar

Four elements, all required:

1. **`path:line`**
2. **A reachable trigger** — *"If you cannot name it, you have a hypothesis, not a finding."*
3. **A consequence** — a finding whose consequence chain cannot be completed is **dropped**, not
   downgraded.
4. **The smallest fix direction.**

Then try to prove yourself wrong: read the surrounding code, check for an upstream guard, and check
comment-against-code — a mismatch is itself a finding. Two named traps: a credible docstring
rationale (a prior agent closed a real blocker on one), and **reading a guard instead of running
it**.

Not findings: style with no consequence, "could be refactored", anything ratified or deferred in the
roadmap, and anything the environment prevents confirming. Duplicate-search first with
`gh issue list --state all --limit 100 --search "<distinctive terms>"` — *a duplicate is worse than a
gap; it splits the discussion and gets worked twice.*

## Labels a filed issue is born with

`review` + its `rev:*` charter label · `bug` (or `enhancement` only for a genuine capability gap) ·
exactly one of `user-facing` / `internal` · and `loop` **only if** machine-verifiable and inside the
loop's fence, else `needs-decision` with a Decisions block.

**Never `triaged`.** That label has one writer. See
[`LABELS.md`](LABELS.md#triaged-has-exactly-one-writer) — and note the live cron messages currently
contradict this, recorded in [`DRIFT.md`](DRIFT.md).

## Silence is the normal outcome

Write nothing at all — no issue, no message, no log line — when rotation finds nothing never-reviewed
and nothing changed. Never message on a pass that filed nothing. A pass that *did* review and found
nothing still appends a **clean row** to `REVIEW-LOG.md`, which is append-only.

---

## Trigger surfaces — the stage 3 migration list

**PR reviewer**

| What is watched | Mechanism today | Target event | Failure if missed |
|---|---|---|---|
| Open PRs | Poll `gh pr list --state open --limit 50` | `pull_request.opened` | `--limit 50` truncates; with a PR opened every ~2 min, PRs beyond 50 are invisible and can land unreviewed |
| **Verdict freshness vs head** | Grep comments for `head=<full head SHA>` | `pull_request.synchronize` | Named as "the one failure mode of this design": a review of yesterday's head is an unreviewed PR that looks reviewed |
| A new PR entering the lane | `review:pending` label added | `pull_request.opened` | A PR with no label is invisible (#707) |
| A fixed block re-entering | `review:blocked` → `review:pending` flip, done by the worker | `pull_request.synchronize` | Label left in place → waits forever; a comment is inert (#681) |
| Draft → ready | `isDraft` read in the same poll | `pull_request.ready_for_review` | Picked up only on the next interval |
| Pass interval | 600s, and it must stay longer than a pass's wall clock (~3–5 min) | event-driven | **No claim mechanism**: two overlapping passes both dispatch the same head |
| `origin/main` moving | Test-merge freshness, ~10 merges/hour | `push` to `main` | Two PRs each green alone and broken together pass both reviews — *nothing else in this pipeline looks for that* |

**ISSUEGEN** — this lane is **deliberately not migrating.** It is a *scheduled sweep of code*, not a
reaction to an event: its trigger is the wall clock plus a slice-sha comparison, and there is no
GitHub event that means "this slice is worth re-reading." It stays on cron.

The one webhook-adjacent improvement available to it is using `push` to `main` to invalidate slice
shas immediately rather than discovering the change on the next pass. That is optional and not part
of stage 3.

**Stage 3 is not started.** It begins once stage 2's acceptance criteria hold.
