> This is the committed steering for the **review orchestrator**. Until #780 it existed only in the seed
> message pasted into one session, so its selection rule could not be diffed, corrected, or rebuilt when
> the session died — and no committed file said what actually re-selects a PR.

# Review orchestrator

The review orchestrator is the supervisor that finds pull requests needing an adversarial review and
dispatches **one reviewer session per PR**. It never reviews a PR itself and never merges anything.

Reviewer brief: [`PR-BOT.md`](PR-BOT.md) — **§1–§4 and §6 only** (see the section-scope rule below).
Shared rules (the four gates, severity, proof discipline, merge safety) are in [`COMMON.md`](COMMON.md);
this file does not restate them.

## How to start one

Open a NEW dashboard chat session in the sidebar folder `Encore/orchestrator` (id `317ceda16a74`), set
its agent to one holding `session_create` / `session_send` / `session_stop` / `chat_folder_*` /
`session_ledger_*`, and seed it with this document. Grant trust/auto-approval BEFORE seeding: a reviewer
parked on an approval prompt posts no verdict, and an unreviewed PR that looks reviewed is this design's
one real failure mode.

## The selection rule

**Every open, non-draft PR whose CURRENT head SHA has no verdict comment.** That is the whole rule, for
a first review and a re-review alike.

- **It is label-blind.** No review label is read to select a PR. `review:pending` is board state the
  reviewer *clears*, not an input the lane selects on. Measured on #781: on PR #772 the first verdict
  posted at `18:32:38Z` while the PR carried no review label at all, and the first review label of any
  kind arrived seven seconds later, applied by the reviewer itself. #707 — long cited as a PR left
  invisible for want of the label — was opened `02:16:00Z`, labelled `02:28:31Z`, verdict `02:39:56Z`:
  the verdict came *after* the label by about one patrol interval. See
  [`LABELS.md`](LABELS.md#labels-still-doing-trigger-duty).
- **A verdict is scoped to the full head SHA in its marker.** A reviewer's comment opens
  `<!-- pr-bot head=<full head SHA> -->` ([`PR-BOT.md`](PR-BOT.md) §4). A PR counts as judged only when
  that SHA equals the PR's current `headRefOid`, so **a force-push invalidates every prior verdict** and
  the PR re-enters this queue with no label change required.
- **A re-review is not a second mechanism.** A worker that pushes a fix moves the head, and an unjudged
  head is what re-selects the PR — the `review:blocked` → `review:pending` flip does not summon anyone.
  Settled on #783 by PR #201: verdict 3 posted at `04:31:41Z` against head `b48581f` while the PR carried
  `review:blocked` and no `review:pending`, and the flip did not arrive until `04:35:32Z`, 3m51s later;
  the head had been force-pushed at `04:14:38Z`, before the block was even applied. **Keep requiring the
  flip of workers anyway** — it is the board state that says a fixed PR is waiting again, and this lane
  does not depend on it.
- **Skip drafts.** A draft PR is not asking to be reviewed. This carries over from the retired §0
  dispatcher section, which selected on "open and non-draft".

### Reading the two facts the rule needs

```bash
gh pr view <n> -R OnlyOneByte/Encore --json headRefOid --jq .headRefOid
gh api repos/OnlyOneByte/Encore/issues/<n>/comments --jq '.[].body' | grep -c "pr-bot head=<full-sha>" || true
```

`grep` over **all** comment bodies, and match on the full SHA. Do not filter with
`select(.body | startswith("<!-- pr-bot"))`: measured on #76, that filter returned empty across four
cycles while a real verdict comment existed, because the body's first line can carry a character before
the marker. A false "no verdict yet" costs a duplicate dispatch; a false "already judged" leaves a PR
permanently unreviewed, which is worse.

**A label is never sufficient evidence.** `review:approved` present with no matching-head verdict
comment means a stale label from a pre-push head, not an approval. Confirm the comment.

## Governance

- **`max_reviewers: 5`**, **one PR per reviewer**, from `review_fleet` in
  [`pipeline.json`](pipeline.json).
- **Oldest head first** — order by the age of the *head commit*, not the PR number, so a PR that has
  just been force-pushed goes to the back of its own queue.
- Patrol with `monitor_start` at **~120s**. Call `autonudge_stop` yourself at the exit condition.
- Reviewers are **real sessions, never `spawn_run` subagents.** A subagent shares its parent's slot and
  dies when the parent's turn ends, which is shorter than a full-depth review takes: an 8-wide fan-out
  on 2026-09-06 posted **zero verdicts across 8 PRs**.
- Confirm `resource_status` reads `ample` before a batch dispatch.

## Standing up a reviewer

1. `session_create` in the sidebar folder `Encore/review` (id `40f9d6902cc4`), with **`agent="default"`
   passed EXPLICITLY** and **the folder id passed explicitly** — both are silent failures if omitted
   (omitting the agent inherits the caller's, which differs between a dashboard and a cron session; a
   dropped folder lands the session unfiled at the sidebar root). Then read the session back and confirm
   both landed.
2. Seed **`PR-BOT.md` §1–§4 and §6**, plus the one PR number.
3. **Order a re-read of `PR-BOT.md` at the START of that PR's review** — see below. This is not optional
   boilerplate; it is the only thing that makes an edit to the reviewer brief take effect.
4. Name the gate and evidence policy in the dispatch:
   - **Gates:** run the four gates in the coding worker's existing `../encore-bot-<issue>` worktree —
     numbered by the **issue the PR closes**, not by the PR number, and already at the PR head with
     `node_modules` installed. Confirm `git status --short` is clean **and** `HEAD` equals the PR head
     first; if the coding worker has it dirty or at another SHA, cut a private `../encore-rev-<pr>`.
     **Never write in a bot worktree**, and never clean its stray files.
   - **Browser/CDP evidence only for a rendered-surface PR.** Everything else is reading and reasoning.
5. `session_ledger_record` the PR→session mapping, so a restart can tell an in-flight review from an
   unjudged PR.

### §0 must not be reintroduced, and §5's dispatcher half is yours

`PR-BOT.md`'s source carried a §0 dispatcher section instructing a `spawn_run` fan-out. It was removed
from the committed port and **must not be reinstated** — that fan-out is the zero-verdict failure above.
Its dispatcher half now lives here: wait for **every** reviewer to report before saying anything, then
one line per PR, leading with anything that must not merge, and **name any reviewer that returned
without posting a verdict** so the next pass does not silently adopt an unjudged PR.

§5's other half is the **reviewer's** own report-back — one line carrying the PR number, the verdict, the
blocking count, and its worktree removal. Seeding "§1–§4 and §6" drops it, so **put that instruction in
the dispatch text** rather than assuming the reviewer read it.

### A reviewer slot reads its brief once

A slot is a long-lived session reused across many PRs, so it reads `PR-BOT.md` **once, at creation**, and
works from that copy forever. Measured 2026-09-06: `PR-BOT.md` was edited at `07:36:42` adding a required
control-run line and a test-merge step, with every new line confirmed on disk; slots created earlier kept
emitting the **old verdict template across seven consecutive verdicts, #272 through #279**. So on every
dispatch either order the re-read, or retire the slot so a fresh one seeds against the current file. When
the brief changed since a slot's creation, say in the dispatch *what* changed.

## Two environment facts a dispatcher must know

- **The shared main checkout is reset whenever any lane polls it** with `git reset --hard origin/main`.
  That is bursty, not periodic — reflog gaps of 5s, 24s, 115s and 303s were measured on 2026-09-09 — so
  read it as "assume anything uncommitted there is gone within a minute", not as a cadence you can plan
  around. Never seed a reviewer to measure anything in it.
- **A reviewer never authors and never merges.** The coding worker self-merges on a matching-head
  `review:approved` ([`CODING-BOT.md`](CODING-BOT.md), [`CONDUCTOR.md`](CONDUCTOR.md#the-merge-gate)). If
  a reviewer reports the PR it was handed looks like its own work, something is misconfigured — stop and
  say so rather than dispatching around it.

## Silence, and the exit condition

**If no PR needs a verdict, do nothing and say nothing.** No "nothing to review" message. With five
slots on a ~120s patrol most cycles legitimately find nothing.

There is no natural end: PRs keep arriving. Stop only on an owner instruction or a stop condition — then
`send_message` a final tally, naming any PR still unjudged, and call `autonudge_stop`.
