# Dev lane — migration stage 2

Brief: `.kiro/autoloop/CODING-BOT.md` · Spec: `.kiro/autoloop/pipeline-issue-fix.json` ·
Wave model: `.kiro/autoloop/FLEET.md` · Serial model + safety: `.kiro/autoloop/LOOP.md`

The dev lane turns a triaged issue into a merged PR. It has two shapes that share the same worker
contract: a **conductor** dispatching one long-lived worker session per issue, and a **fleet wave**
dispatching a batch of subagents from one dashboard session.

## Worker charter

A coding worker owns **exactly one issue**. It talks to the conductor only through its status prefix
and **never pings the human** — if it needs a ruling it says `BLOCKED:` and stops; the conductor
adjudicates.

The main checkout is **read-only** to a worker. Any worktree not named `encore-bot-*` belongs to the
owner (36+ exist) — never enter one, never remove one.

A worker never: takes a second issue; fixes a second defect in the same PR (it *reports* it);
reviews or approves its own PR; merges without `review:approved` and the conductor's go; pushes to
`main`, force-pushes another branch, or uses `--no-verify`; opens a PR on a red per-hunk proof or
without test-merging onto current `origin/main`; lets a test compute its expected value the way the
code does; or goes quiet — an unprefixed turn reads as a stall and gets intervened on.

## Status protocol

Exactly one prefix begins every turn, **re-stated on every later turn** while the assignment is open.

| Prefix | Meaning |
|---|---|
| `WORKING:` | Making progress; say on what |
| `PR:` | PR opened; carry the full URL |
| `REVIEW:` | Waiting on the reviewer, or answering findings |
| `GREEN:` | Merge conditions met; PR URL, head SHA, 3–6 step plain-language summary |
| `MERGED:` | Landed; carry the merge commit |
| `BLOCKED:` | Needs a ruling; carry evidence **and 2–4 options** — a `BLOCKED` with no options is sent back |
| `STANDDOWN:` | Should not do this work; carry the reason |
| `PROPOSAL:` | Needs a design decision; write it **on the issue** and do not build |

## Lifecycle

**Preflight** — can legitimately end the assignment, and a standdown is a good outcome:

- `gh issue view <n>` including comments.
- Overlap: `gh pr list --state open --limit 100` and `git worktree list`. An existing PR/branch/
  worktree → `STANDDOWN: already covered by <ref>`. Never adopt another session's work in progress.
- File overlap: read the issue's `path:line` sites; if an in-flight bot branch touches those files
  (`git diff --name-only main...<their-branch>`) → `STANDDOWN: file overlap with <branch>`.
- Confirm the premise against current `main` — roughly **half** of confidently-worded findings soften
  on inspection. Premise wrong → `STANDDOWN: premise disproven — <evidence>`, said on the issue too.

**Worktree:**

```bash
cd /local/home/angryang/.kiro/crew/workspace/Encore
git fetch origin --quiet
git worktree add ../encore-bot-<n> -b fix/<slug>-<n> origin/main
cd ../encore-bot-<n> && bun install   # REQUIRED — node_modules is gitignored, so a fresh
                                      # worktree has none and the gates MISREPORT without it
```

**Fix** — root-cause fix at the seam owning the invariant, not the smallest symptom-hiding diff.
Every new guard needs a **non-test caller**: grep outside the test files, because zero non-test
callers means the fix is dead. This is the repo's most-repeated defect class.

**Merge** — six conditions, and since `main` has no branch protection these are the whole safety
system:

1. Four gates green on the current head
2. `review:approved` present
3. `review:blocked` absent
4. Every blocking finding answered
5. PR `MERGEABLE`, one commit, fresh base
6. The conductor verified 1–5 **independently** and said go

Then `gh pr merge <n> --squash --delete-branch` (required — the repo does not delete on merge, and
`--auto` is unavailable), confirm with `gh pr view <n> --json state,mergedAt`, then
`git worktree remove ../encore-bot-<n>` (never `--force`).

## The gates

All four, every pass, never narrowed — the full suite is cheap here.

```bash
bun test                                # expect 0 fail
cd apps/worker && python3 -m pytest -q  # expect 0 fail
bun run build                           # expect exit 0
bun run typecheck                       # expect exit 0, 0 errors, 0 warnings
```

Two measurement rules that have each caused a real false pass:

- **Read exit codes, never piped output.** `cmd | tail` makes `$?` tail's status, so a failing gate
  reads as green. Redirect to a file and test the exit code.
- For typecheck, read the `found N errors` line — **not** `grep -c error`, which counts the literal
  string inside "found 0 errors". Note `bun run typecheck` chains `typecheck:e2e`, and `svelte-check`
  can print "0 errors" while the chained leg fails.

Never trust a pinned pass count; re-measure. The count moves by tens within a day, and a pinned floor
reads a normal head as a regression.

## Proof requirements

A regression test **red on base** and **per-hunk mutation-proven**. Union-reverting all hunks proves
nothing about any individual hunk — measured on #224, where a union revert reddened 3 tests but
reverting `server.ts` alone left 1398 pass / 0 fail.

```bash
python3 .kiro/autoloop/scripts/prove_per_hunk.py --base origin/main --fast --report "$TMPDIR/proof-<n>.md"
```

| Exit | Meaning |
|---|---|
| `0` | Every hunk reds a named test |
| `20` | A hunk is unverified — **blocking**, not advisory |
| `30` | HEAD is not green |

`PINNED-AS-GROUP` is normal for a replacement and does not block. The one exception is a **pure
deletion**, whose exit 20 is expected: close it with a source-scan guard that reads the real
production file.

Three things the script cannot check, all of which have shipped bugs:

- Never derive an expected value with the same operation the code performs (#165).
- Trace that the fixed code is actually **reached** on the issue's path (#190).
- Name the failing assertion per hunk.

**PR body:** Problem · Root cause · What changed · Tests · Manual verification · Screenshots for
rendered surfaces, plus `Closes #<n>` **as a whole line**, read back with
`gh pr view <n> --json closingIssuesReferences` — an empty list means the keyword is malformed and
the issue will silently stay open after merge. Under Tests, paste the `prove_per_hunk.py` table
**verbatim**: the table is the proof, not prose.

## Governance

From `pipeline-issue-fix.json`:

| Setting | Value |
|---|---|
| Work source | `gh_issues`, `select_labels: ["triaged"]` |
| Skip signals | `claimed` · `in-progress` · `needs-decision` · `wontfix` |
| Order | Oldest issue number first, skip-to-disjoint on file overlap |
| `max_in_flight` | **5** (the prose comment in the same file says 3 — see [`DRIFT.md`](DRIFT.md)) |
| `max_per_cycle` | 3 |
| `session_ceiling` | 36 |
| `idle_alert_secs` | 900 |
| Branch / worktree | `fix/{slug}-{n}` / `../encore-bot-{n}` |
| Merge | squash, delete branch, six conditions above |

The binding limit is **the box, not the scheduler** — each worker runs `bun install`, the full test
suite and a build, and 36+ of the owner's worktrees already exist. Raise the cap only after
`resource_status` holds `ample` through a full round.

`encore_overrides` records three places the generic conductor procedure is wrong for this repo:

- **`full_suite_is_cheap`** — the generic "targeted tests only" rule is for slow repos. Here `bun
  test` runs ~1351 tests in ~8s and worker pytest ~540 in ~5s, so banning full-suite runs would strip
  the only safety net.
- **`there_is_no_ci`** — no `.github/`, so "babysit the PR to green" has nothing to read. There are
  no check runs, no reviewer lanes, no `PR Readiness` status.
- **`file_overlap_gate`** — the generic check catches the same *item* only, not two different items
  touching the same files. Common here in `TvPlayer.svelte`, `settings.ts` and `packages/shared`.
  The loser's rebase eats the whole win.

A fourth entry, `phase_ladder_still_applies`, is marked **retired** as of 2026-09-07. See
[`LABELS.md`](LABELS.md#retired-2026-09-07--do-not-reintroduce).

## The wave model, and why it cannot be a cron

`FLEET.md` runs up to **3 file-disjoint issues** per wake, one agent each, in a single batch. The cap
is arithmetic: each fix agent spawns its own 3 reviewers, so 3 + 9 = 12 subagents, under the 16 cap;
four would sit exactly on it.

The reason the fleet lives in a dashboard session rather than a cron, near-verbatim:

> A cron-hosted agent on this box **cannot spawn subagents** — `spawn refused by governance: profile
> denies: capability disabled`. The adversarial review *is* three subagents, so a cron cycle can fix
> and open a PR but can **never** satisfy the review merge criterion. It parks every time. Throughput
> was never the first problem: the merge path was closed.

Merges are serialized across concurrent agents by an **atomic `mkdir` lock**, with a 20-minute
staleness breaker for a lock leaked by a crashed agent, released on every exit path via `trap`.

## Trigger surfaces — the stage 2 migration list

| What is watched | Mechanism today | Target event | Failure if the edge is missed |
|---|---|---|---|
| Dispatchable issues | Conductor polls `gh issue list` for `triaged` minus skip signals, each cycle | `issues.labeled` (`triaged`) | Queue stalls silently |
| Owner ruling resolved | `needs-decision` re-read at next selection | `issues.unlabeled` (`needs-decision`) | A resolved issue stays unclaimed — nothing polls for label removal |
| Claim exclusivity | `claimed` / `in-progress` labels | unchanged (state, not trigger) | Two workers take one issue; one's work is discarded |
| Verdict arrival | Worker's own ~300s monitor loop asking "has a verdict been posted?" | `issue_comment.created` on the PR | Worker goes quiet and is intervened on, or never sees findings |
| Base freshness | Manual re-check; the repo merges ~10 PRs/hour | `push` to `main` | A branch green an hour ago can be semantically stale |
| Merge landed | `gh pr view <n> --json state,mergedAt` | `pull_request.closed` | An unlanded PR reported as `MERGED:` |
| Worktree debris | `git worktree list \| grep encore-loop-` each cycle | `pull_request.closed` | Worktrees accumulate against the session ceiling |

Absent surfaces to keep in mind: no check runs, no `--auto` merge, no delete-on-merge, no branch
protection. Every normally-automatic edge here is replaced by a poll, a label or a conductor nudge.

**Stage 2 is not started.** It begins once stage 1's acceptance criteria hold.
