# The Encore autonomous loop

Encore is maintained partly by a fleet of agents: they read the codebase, file issues, triage them,
fix them, review the pull requests, and merge. This directory is the **tracked** description of that
system — what the lanes are, how work reaches each one, and where the design is going.

## Why this directory exists

The operational briefs the agents actually read live in `.kiro/autoloop/`, which is **gitignored**
(`.gitignore:38` ignores `.kiro` wholesale). That has two consequences worth naming plainly:

- The loop's design has never been reviewable. It cannot be diffed, commented on, or bisected, and
  a brief edited on one box exists nowhere else.
- The briefs have drifted against each other and against the live schedule, silently. See
  [`DRIFT.md`](DRIFT.md) — every entry there was found by reading two sources that disagree.

So this directory is the reviewable copy. The briefs stay authoritative for **what an agent is told
to do**; these docs are authoritative for **how the system is meant to fit together**.

## Read this first, if you read nothing else

The loop's coordination state lives in **GitHub labels**. That part is sound: labels are visible,
crash-safe, and need no side database.

The problem is that labels are currently doing a *second* job they are bad at — they are also the
**event bus**. A lane learns there is work to do by noticing that a label changed since the last
time it looked. That is edge detection by polling, and a missed edge is silent and permanent:

- A freshly-opened PR carrying no label is invisible to the review lane, so the author waits for a
  verdict that will never come (issue #707).
- A worker that pushes a fix but leaves `review:blocked` in place waits **forever**; a comment
  asking for re-review is inert (issue #681).
- An owner who answers a triage question in a comment has answered nothing, because nothing reads
  comments. The owner must additionally strip the `triaged` label and wait for the next cron pass.

Every one of those is an event GitHub already emits for free. The migration in
[`MIGRATION.md`](MIGRATION.md) moves the bus to GitHub webhooks and lets labels go back to being
state only.

## The lanes

| Lane | What it does | Doc |
|---|---|---|
| **Triage** | Categorizes, labels and comments on incoming issues; asks the owner for rulings | [`TRIAGE.md`](TRIAGE.md) |
| **Issue generation** | Five scheduled code-review passes that *file* new issues from a slice of the codebase | [`REVIEW.md`](REVIEW.md) (Part B) |
| **Dev / fix** | Claims a triaged issue, builds the fix in its own worktree, opens the PR | [`DEV.md`](DEV.md) |
| **PR review** | Adversarially reviews an open PR and posts one verdict | [`REVIEW.md`](REVIEW.md) (Part A) |

## Document map

| File | Contents |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the lanes connect; the label-as-bus problem; the target shape |
| [`LABELS.md`](LABELS.md) | The full label taxonomy, what blocks, what was retired, and which labels are doing trigger duty |
| [`TRIAGE.md`](TRIAGE.md) | The triage lane in full, including the Decisions-block protocol — **migration stage 1** |
| [`DEV.md`](DEV.md) | The coding worker: charter, status protocol, gates, proof requirements, governance |
| [`REVIEW.md`](REVIEW.md) | Both review lanes: the PR reviewer and the ISSUEGEN passes |
| [`WEBHOOKS.md`](WEBHOOKS.md) | The ingress mechanism and the constraint that shapes it |
| [`MIGRATION.md`](MIGRATION.md) | The staged plan, with acceptance criteria per stage |
| [`DRIFT.md`](DRIFT.md) | Contradictions between the briefs, and between a brief and reality |

## Reading conventions

Each lane doc separates two things explicitly, because conflating them is how the briefs rotted:

- **Today** — what the system actually does right now, verified against the live configuration.
- **Target** — what it becomes after its migration stage. Not yet true.

A claim marked *unverified* is one nobody has measured. Leave it marked rather than promoting it.
