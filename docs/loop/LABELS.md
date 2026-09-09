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
silent and permanent, which is why the edges doing trigger duty are worth naming one at a time.

Triage no longer works this way, and it needed no event to stop: it POLLS. The review lane never
worked this way either — its probe lists every open PR with **no label filter** and buckets on "no
verdict at the current head", so `review:pending` is an **output the reviewer clears**, not an input it
selects on. These three are **retired as triggers** while the labels themselves keep their meaning:

| Label edge | Now found by |
|---|---|
| `triaged` removed — the owner's re-triage lever | the untriaged query, on the next ~360s patrol |
| the owner answering a question | the `needs-decision` query, whose newest comment is not bot-authored |
| `review:pending` added | the review probe, which reads every open PR and asks whether its **current head** has a verdict |

That third row used to be listed as still label-triggered, citing #707 as what losing the edge cost.
**That was wrong, and the measurement is the record now.** On PR #772 the first verdict posted at
`18:32:38Z` while the PR carried no review label at all; the first review label of any kind was
`review:blocked` at `18:32:45Z` — seven seconds later, posted by the reviewer itself. #707's own
timeline says the same: opened `02:16:00Z`, `review:pending` applied `02:28:31Z`, verdict `02:39:56Z`,
so the verdict came 11m25s *after* the label. Both gaps are one or two ~360s patrol intervals. A
patrol-interval wait was misread as invisibility. The committed reviewer brief
[`PR-BOT.md`](PR-BOT.md) agrees: it carries no selection probe at all and only *clears* the label as an
output. Settled on #781.

These two are **still described as label-triggered**, and neither is polled for directly yet:

| Label edge | Used to mean | The event that would replace it |
|---|---|---|
| `triaged` added | "this is dispatchable" | `issues.labeled` |
| `review:blocked` → `review:pending` | "I pushed a fix, re-review me" — **unverified**, see below | `pull_request.synchronize` |

The second row is not the entry claim over again, and it is not disproven either — it is **untested**.
On every PR checked, the flip and a new head arrived together, so the two are confounded and the data
cannot say which one the lane reacted to; a head-based probe would need no flip at all. Read that row
as an open question, not as a mechanism in either direction. It is tracked on **#783**, which waits on
the review orchestrator's real selection rule being committed (**#780**). Keep flipping the label
meanwhile: it is cheap, and it is the board state that says a fixed PR is waiting again. Whether a
worker may flip its own `review:blocked` is answered in [`CONDUCTOR.md`](CONDUCTOR.md) under
"Coding-bot seed rule — re-review after a block", which records a worker doing exactly that on #681.
