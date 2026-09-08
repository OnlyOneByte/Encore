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

> **Never apply `triaged` yourself.** That label belongs to the triage lane alone: it is the one
> writer, so a `triaged` label always means the triage pass has seen the issue. The lane stamps your
> `review` findings on its next wake without re-investigating them, which is also what makes them
> dispatchable to the fix loop. Applying it yourself would forge that record.

The live `ISSUEGEN-*` cron messages currently instruct reviewers to apply it themselves, which
contradicts this rule. Four of the five predate the rule; only `ISSUEGEN-e2e-behavior` reads correctly.
[`REVIEW-PASSES.md`](REVIEW-PASSES.md) supersedes those messages, and correcting them at source needs
the cron registry.

## Retired 2026-09-07 — do not reintroduce

| Retired | Became |
|---|---|
| `phase:P1` | `user-facing` |
| `phase:P2` | `internal` |
| `phase:P4` | `owner-only`, itself deleted the same day |
| `phase:P0` · `phase:P3` | deleted |
| `HIGH-PRIORITY` | `priority` |
| `needs-owner` · `owner-only` · `needs-repro` · `needs-owner-verification` · `for-owner` | `needs-decision` |

Historical rows in the run logs under `/local/home/angryang/workspace/encore-loop-state/` keep the
old names. **That is
the record — do not rewrite it.**

## Labels still doing trigger duty

A label is coordination **state**. Some edges are additionally being used as an *event* — a lane
notices the label changed since it last looked. That is edge detection by polling, and a missed edge is
silent and permanent; it is what cost #707 and #681.

Triage no longer works this way, and it needed no event to stop. It POLLS, so these two are **retired
as triggers** while the labels themselves keep their meaning:

| Label edge | Now found by |
|---|---|
| `triaged` removed — the owner's re-triage lever | the untriaged query, on the next ~360s patrol |
| the owner answering a question | the `needs-decision` query, whose newest comment is not bot-authored |

These three are **still label-triggered**, and none of them is polled for directly yet:

| Label edge | Used to mean | The event that would replace it |
|---|---|---|
| `triaged` added | "this is dispatchable" | `issues.labeled` |
| `review:pending` added | "a PR needs review" | `pull_request.opened` |
| `review:blocked` → `review:pending` | "I pushed a fix, re-review me" | `pull_request.synchronize` |

The third row is the expensive one. A worker cannot clear its own `review:blocked`, so a fix that is
pushed without that flip waits forever, and the comment asking for re-review is inert. The manual flip
protocol exists only to synthesise an edge GitHub already emits.
