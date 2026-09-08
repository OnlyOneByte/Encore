# Labels

Labels are the loop's coordination state. They are visible in the GitHub UI, survive a crash, and
need no side database — which is why they were chosen and why they stay.

## Severity — exactly one per issue

Replaced the retired `phase:P0`–`phase:P4` ladder on 2026-09-07.

| Label | Meaning |
|---|---|
| `user-facing` | A singer in the room can see it. Also covers a test that gives **false safety** — a vacuous pass is a functional defect, not untidiness |
| `internal` | No visible symptom: a mechanism with no non-test caller, duplicated vocabulary with no parity guard, a crossed layer boundary, dead weight, an unguarded invariant, a comment contradicting its code, missing coverage of a real path |

**A `user-facing` defect outranks all `internal` work, regardless of arrival order.**

## Category

`bug` · `enhancement` — `enhancement` only for a genuine capability gap, not a defect wearing a
polite name.

## Blocking — these two stop dispatch

| Label | Meaning |
|---|---|
| `needs-decision` | The owner must rule before anything is built. **The only park label.** |
| `wontfix` | Decided against. |

`needs-decision` is deliberately a **single boolean**. It replaced five labels
(`needs-owner`, `owner-only`, `needs-repro`, `needs-owner-verification`, `for-owner`) that each
tried to encode *why* the issue was blocked. A label carries one bit; the reason belongs in the
**Decisions block** in an issue comment, which can say it in a plain sentence. See
[`TRIAGE.md`](TRIAGE.md#the-decisions-block).

Note that `proposal` does **not** block on its own. A genuinely undecided proposal also carries
`needs-decision`. A `proposal` without it means the owner already gave the go-ahead.

## Lifecycle

`triaged` → `claimed` → `in-progress` → `review:pending` → `review:approved` | `review:blocked` |
`review:needs-human`

These exist so an observer can tell a busy loop from a stalled one: *a silent claim is
indistinguishable from no progress.*

## Routing and steering

| Label | Applied by | Meaning |
|---|---|---|
| `review` | ISSUEGEN passes | This is a reviewer finding, already carrying `path:line` — triage stamps it rather than re-investigating it |
| `rev:ui-design` `rev:core-arch` `rev:worker-arch` `rev:e2e-behavior` `rev:code-quality` | ISSUEGEN passes | Which charter filed it |
| `loop` | ISSUEGEN / triage | Machine-verifiable and inside the loop's fence, so it is dispatchable |
| `priority` | **the owner only** | Queue-jump. An agent that labels its own finding `priority` has removed the owner's only way to steer the queue — never do it |
| `overlaps` | conductor | Contends on files with an in-flight item |

### `triaged` has exactly one writer

Quoted from the ISSUEGEN brief, because this is contested and the rule is load-bearing:

> **Never apply `triaged` yourself.** That label belongs to the triage cron alone: it is the one
> writer, so a `triaged` label always means the triage pass has seen the issue. The cron stamps your
> `review` findings on its next wake without re-investigating them, which is also what makes them
> dispatchable to the fix loop. Applying it yourself would forge that record.

The live ISSUEGEN cron messages currently instruct reviewers to apply it themselves, which
contradicts this. Recorded in [`DRIFT.md`](DRIFT.md).

## Retired 2026-09-07 — do not reintroduce

| Retired | Became |
|---|---|
| `phase:P1` | `user-facing` |
| `phase:P2` | `internal` |
| `phase:P4` | `owner-only`, itself deleted the same day |
| `phase:P0` · `phase:P3` | deleted |
| `HIGH-PRIORITY` | `priority` |
| `needs-owner` · `owner-only` · `needs-repro` · `needs-owner-verification` · `for-owner` | `needs-decision` |

Historical rows in `.kiro/autoloop/TRIAGE-LOG.md` and `REVIEW-LOG.md` keep the old names. **That is
the record — do not rewrite it.**

## Labels currently doing trigger duty

This is the migration surface. Each row is a label edge being used as an *event*, and each will stop
being a trigger once the corresponding lane moves to webhooks. **The label itself stays** — only its
double duty as a signal goes away.

| Label edge | Simulated event | Real GitHub event | Migrates in |
|---|---|---|---|
| `triaged` removed | "re-triage this" | `issues.unlabeled` | Stage 1 |
| — (nothing today) | "the owner answered a question" | `issue_comment.created` | Stage 1 |
| `triaged` added | "this is dispatchable" | `issues.labeled` | Stage 2 |
| `review:pending` added | "a PR needs review" | `pull_request.opened` | Stage 3 |
| `review:blocked` → `review:pending` | "I pushed a fix, re-review" | `pull_request.synchronize` | Stage 3 |

The middle row is the one with no label at all today: there is no edge that means *the owner
answered*, which is why answering currently requires a separate label edit.
