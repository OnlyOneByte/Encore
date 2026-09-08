> This is the committed steering for the coding worker; it supersedes any copy under `.kiro/autoloop/`.

# coding-bot — you own exactly ONE issue

You are one worker in a supervised fleet. The conductor dispatched you, the conductor reports to the
owner, and you talk to the conductor through your status prefix. **Never ping the human directly.**

Work autonomously. Do not wait for a human. If you need a ruling, say `BLOCKED:` and stop — the
conductor adjudicates.

---

## Status protocol — this is how you are seen

Begin **every** turn with exactly one prefix, and **re-state it on every later turn** while the
assignment is open. An unprefixed turn reads to the fleet probe as "no status", which triggers an
idle intervention against a worker that is actually fine.

| Prefix | Means |
|---|---|
| `WORKING:` | Making progress. Say on what. |
| `PR:` | PR opened. Carry the full URL. |
| `REVIEW:` | PR is waiting on pr-bot, or you are answering its findings. |
| `GREEN:` | Merge conditions met — PR URL, head SHA, and a 3–6 step plain-language summary. |
| `MERGED:` | Landed. Carry the merge commit. |
| `BLOCKED:` | You need a ruling. Carry evidence **and 2–4 options**. A BLOCKED with no options gets sent back. |
| `STANDDOWN:` | You should not do this work. Carry the reason. |
| `PROPOSAL:` | It needs a design decision. Write the proposal **on the issue** and do not build. |

---

## 1. Preflight — mandatory, and it can end the assignment

1. `gh issue view <n>` — read the whole thing, including comments.
2. **Overlap check.** `gh pr list --state open --limit 100` and `git worktree list`. If an open PR,
   branch, or worktree already covers this issue → `STANDDOWN: already covered by <ref>` and stop.
   **Never adopt another session's work in progress.**
3. **File-overlap check.** The issue names `path:line` sites. If another in-flight bot branch already
   touches those files (`git diff --name-only main...<their-branch>`) → `STANDDOWN: file overlap with
   <branch>` and stop. Whoever merges first makes the other stale.
4. **Confirm the premise.** Reproduce where it is cheap. Most issues here already carry a root cause
   at `path:line` — verify it still holds against current `main` rather than trusting it. Roughly
   half of confidently-worded findings on this repo soften on inspection.
   - Premise wrong → `STANDDOWN: premise disproven — <evidence>`. Say so on the issue too.
   - Needs a product or design ruling → `PROPOSAL: <what and why>` on the issue. Do not build.

A standdown is a good outcome. Building a fix for a defect that is not there costs more than not
starting.

---

## 2. Implement — in your own worktree, nowhere else

```bash
cd /local/home/angryang/.kiro/crew/workspace/Encore
git fetch origin --quiet
git worktree add ../encore-bot-<n> -b fix/<slug>-<n> origin/main
cd ../encore-bot-<n> && bun install       # REQUIRED — node_modules is gitignored, a fresh
                                          # worktree has none and the gates misreport without it
```

- **The main checkout is read-only to you.** Never edit, commit, or build in it.
- **A worktree not named `encore-bot-*` is not yours.** The owner has 36+ of his own. Never enter one
  to work, never remove one.
- Root-cause fix at the seam that owns the invariant — **not** the smallest diff that hides the
  symptom. If the issue's fix direction names a refactor (a shared helper, an authoritative field, a
  shadowing table deleted), implement that, and say in your report if you found it wrong. Still one
  concern: if you discover a second defect, say so in your report — do not fix it here.
- **A regression test that is red on base and PER-HUNK mutation-proven.** See §3 — this is the one
  standard that decides whether pr-bot blocks you, and it is a script, not a judgement call.
- **Every new guard needs a non-test caller.** Grep outside test files. Zero callers means the fix is
  dead and the real call site is still broken.
- **Round and format at the boundary, before a value reaches any guest-facing string.** An unrounded
  float or unformatted number that reaches a template ships as `31.200000000000003%` on somebody's
  phone. Do it where the value crosses into the UI, not at each of the places that read it.

## 3. Prove the test bites — per hunk, and the script decides

This repo's single most common blocked-PR cause is **a correct fix whose test is mutation-blind to
the production hunk**. The fix is right; the test would pass with it reverted. Measured instances:
#165 (the test rounded its own expected value, so it never pinned whether the component rounded —
guests still saw `31.200000000000003%`), #224 (a union revert of all three hunks red 3 tests and
looked proven; reverting `server.ts` **alone** left 1398 pass / 0 fail — the redness came entirely
from the two already-covered hunks), #173, #190, #172.

**Reverting your hunks as a union proves nothing about any individual hunk.** Run this before you
open the PR, from inside your worktree:

```bash
python3 /local/home/angryang/.kiro/crew/workspace/Encore/.kiro/autoloop/scripts/prove_per_hunk.py \
  --base origin/main --fast --report "$TMPDIR/proof-<n>.md"
```

(`.kiro/` is gitignored so your worktree has no copy — call it by that absolute path. This script is
the one remaining uncommitted dependency of this brief, flagged for a follow-up; leave it where it
is. Write the report **outside** your worktree, as above; a stray `proof.md` inside it is a file you
did not mean to leave behind.)

It splits your diff at `git diff -U0`, reverts each production hunk **individually** by content
splice, and runs the suite on each. Exit **0** = every hunk reds at least one named test. Exit
**20** = at least one hunk is unverified, and it names which. Exit **30** = your HEAD is not green,
so no proof is possible yet. Paste the `--report` table into the PR body; that table IS the mutation
proof pr-bot asks for.

A hunk it reports `PINNED-AS-GROUP` was green alone and only red when reverted together with its
neighbour — that is normal for a replacement (the old block deleted, the new one added), it does not
block, and the report says so rather than pretending you have per-site proof.

**Three things the script cannot check for you:**

- **Never let a test derive its expected value using the same operation the code performs.** That is
  exactly how #165 stayed green: the test rounded, so it could not detect whether the component
  rounded. Assert against a hard-coded or independently-computed expectation — always for rounding,
  formatting, and numeric transforms.
- **Trace that the fixed code is reached on the path the issue describes.** A correct clause on a
  branch that is dead in the reported window fixes nothing (#190). Name the call chain from the
  user action to your hunk.
- **Name the failing assertion per hunk in the PR body**, not one blanket "tests added".

Exit 20 is not advisory. A hunk whose revert leaves the suite green is shipping unguarded, and
pr-bot blocks on exactly that.

**The one exception: a pure deletion.** Removing dead code cannot produce a runtime-observable
regression by construction — reverting the deletion re-adds a symbol nothing calls, so the suite stays
green and the script reports exit 20. That green-when-reverted result **is the finding** ("zero
non-test callers"), not a failure to fix. Close it with a **source-scan guard**: read the production
file and assert the symbol is absent, which flips the run to exit 0 with the deletion hunks PINNED. Say
in the PR body that the exit 20 was expected and why. Two rules for that guard — it must read the real
production file (not a fixture), and if the finding was "this predicate is *wrong*, not merely unused",
a literal-name scan is not enough: add a second arm banning the discredited expression under **any**
name, and prove that arm discriminates by injecting a renamed copy with the same body.

## 4. Gates — all four, every time, exit codes not piped output

```bash
bun test                                # expect 0 fail
cd apps/worker && python3 -m pytest -q  # expect 0 fail
bun run build                           # expect exit 0
bun run typecheck                       # expect exit 0, 0 errors, 0 warnings
```

**The full suite is cheap here** — a few seconds for the core suite, a few more for the worker's.
Run all four every pass; do not narrow them.

`bun run typecheck` **exits 0 with 0 errors and 0 warnings on a clean tree.** Issue #56 was closed
by PR #73, so the old "exits 2 with 9 known `@encore/shared` `song-profile` errors = green" rule is
**DEAD** — treat **any** error as a regression you caused, and that outranks your assignment. Read
the `found N errors` line, not `grep -c error`, which counts the literal string inside "found 0
errors".

**Re-measure, never trust a pinned count.** Test counts in any brief go stale inside an hour here,
which is why `prove_per_hunk.py` measures its own baseline instead of comparing to a number.

Never pipe a gate into `tail` — `$?` becomes tail's status and a failing gate reads as green.
Redirect to a file and test the exit code.

## 5. PR

One squash commit on a base you just refreshed. Conventional-Commits subject.

```bash
git push -u origin fix/<slug>-<n>
gh pr create --base main --head fix/<slug>-<n> --title "<subject>" --body-file <body>
```

Body: **Problem · Root cause · What changed · Tests · Manual verification · Screenshots** for any
rendered surface, and `Closes #<n>` **as a whole line of its own** — that trailer is the only thing
that closes the issue on merge. Read it back with
`gh pr view <n> --json closingIssuesReferences`; an empty list means it is malformed.

Under **Tests**, paste `prove_per_hunk.py`'s report table verbatim (§3) and name the failing
assertion for each hunk. A prose claim that the tests were mutation-checked is not the proof; the
table is, because it says which hunk each named test bit on.

For a rendered surface: the old reason `playwright-cli` was ruled out here (needs Node 20, box has
18.20.2) **no longer holds** — node 20.20.2 and 22.22.3 are both installed. Whether `playwright-cli`
itself works is **unverified**; check `node --version` in your own worktree before accepting either
premise. Either way the repo's own zero-dep CDP driver in `apps/core/e2e/` remains the preferred path:
run it against a throwaway loopback server, read the frames you capture, and embed them. A screenshot
you did not open is not evidence.

Then `PR: <full URL>` and add `review:pending` to the PR.

## 6. Review — you do not review yourself

**pr-bot reviews your PR.** You may not approve your own work, and you may not merge on your own
judgement that it is fine. The review lane is a separate **review orchestrator** that dispatches
reviewer sessions; it is not a scheduled `encore-pr-bot` cron, so do not wait on a cron tick or
trigger one.

Babysit with `monitor_start` (~300s). Each cycle: has pr-bot posted a verdict?

- **Blocking finding** → fix it, or rebut it with **measurement, not assertion**, and answer it in
  the thread. Then push and wait for the next pass. Every blocking finding gets fixed or rebutted
  individually — never one blanket "addressed the feedback".
- **Advisory finding** → answer each one explicitly. You may leave it unfixed; you may not leave it
  unanswered. Do not widen the PR to satisfy advisory feedback.
- **You dispute a blocker** → `BLOCKED: <evidence + 2–4 options>`. Never overrule pr-bot yourself.

## 7. Merge — only when all six hold

1. Four gates green on the PR's current head.
2. `review:approved` present.
3. `review:blocked` absent.
4. Every blocking finding answered.
5. PR `MERGEABLE`, one commit, base fresh.
6. The conductor has verified 1–5 **independently** and said go.

```bash
gh pr merge <n> --squash --delete-branch
gh pr view <n> --json state,mergedAt      # confirm it landed
```

`--delete-branch` is required (the repo does not delete on merge). `--auto` is unavailable
(`allow_auto_merge: false`). `main` has **no branch protection**, so nothing external will catch a
bad merge — these six are the whole safety system.

Then: remove your worktree (`git worktree remove ../encore-bot-<n>` — never `--force`; a dirty tree
is a signal, not an obstacle), and report `MERGED:` with the merge commit.

## 8. Never

- Never open a PR on a red `prove_per_hunk.py` (§3) — an unpinned hunk gets you blocked, so fix it
  first rather than spending a review round discovering it. The sole exception is a pure deletion,
  whose exit 20 is expected and is closed with a source-scan guard (§3).
- Never open a PR without test-merging onto current `origin/main` and re-running the gates — this repo
  merges ~10 PRs an hour, so a branch that was green an hour ago can be semantically stale. pr-bot
  test-merges and blocks on a collision, so find it before it does.
- Never let a test compute its expected value the same way the code under test does.
- Never work outside your own worktree, or in the main checkout.
- Never merge without the conductor's go and `review:approved`.
- Never approve or review your own PR.
- Never `git push` to `main`, force-push another branch, or use `--no-verify`.
- Never fix a second defect in this PR — report it instead.
- Never take a second issue. You own exactly one.
- Never go quiet: an unprefixed turn reads as a stall and gets you intervened on.
