# Loop architecture

How the lanes connect, and how work reaches each one. Reference material — no lane reads this file.

## The shape

```
   ISSUEGEN x5 (cron, 4h staggered)          owner opens an issue
   reads one code slice, files issues                 │
                    │                                 │
                    └──────────────┬──────────────────┘
                                   ▼
                        ┌──────────────────────┐
                        │   GitHub issues+PRs  │  ← labels are STATE
                        └──────────┬───────────┘
                                   │ polled by each orchestrator
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
   TRIAGE orchestrator      DEV conductor           REVIEW orchestrator
   ~360s, 5 slots           ~90s, 5 slots           ~120s, 5 slots
   TRIAGE-ORCHESTRATOR.md   CONDUCTOR.md            REVIEW-ORCHESTRATOR.md
          │                        │                        │
          ▼                        ▼                        ▼
   Encore/triage            Encore/dev              Encore/review
   one issue per worker     one issue per worker    one PR per reviewer
```

Two structural facts that shape everything downstream:

- **There is no CI.** `.github/` does not exist — no workflows, no check runs, no `PR Readiness`
  status. Every gate is re-run by an agent on the box.
- **`main` has no branch protection.** So the label gates plus the conductor's independent verification
  are the entire safety system. See [`COMMON.md`](COMMON.md#merge-safety).

## Every lane polls, and that is deliberate

Each orchestrator runs its own `monitor_start` loop and discovers work by querying live GitHub. No
lane is event-driven.

An earlier revision put a GitHub webhook in front of this — `gh webhook forward` into a local
translator, which triggered a cron job that dispatched all three lanes. It was removed, and the reason
generalises:

- **Concurrency here comes from sessions, not from triggers.** A cron job is a single serialized
  runner, so routing three lanes through one created a choke point. A trigger arriving while it was
  mid-run was simply dropped, and a burst of events collapsed into one pass. Three independent
  patrol loops are strictly more parallel.
- **Polling is idempotent; delivery is not.** A missed cycle costs nothing because the next cycle
  reads the same state and acts. Delivery has to be made durable, supervised, and recovered — the
  ingress cost a 52-minute silent outage, a leaked-hook failure mode that reported healthy while
  delivering nothing, a supervisor that needed its own supervisor, and a secret in a process
  command line.
- **Everything it delivered was already discoverable by a label query.** Including the one case that
  looked like it needed an event — see below.

## Labels are state, and three queries find all the work

| Lane | Query |
|---|---|
| Triage | `review` and not `triaged` · neither · `needs-decision` with a non-bot newest comment |
| Dev | `triaged`, not `needs-decision`/`wontfix`, unclaimed, no open PR |
| Review | open PRs whose current head has no matching verdict — the probe is label-blind |

Each query's full rule, and the dispatch mechanics around it, live in that lane's supervisor brief:
[`TRIAGE-ORCHESTRATOR.md`](TRIAGE-ORCHESTRATOR.md), [`CONDUCTOR.md`](CONDUCTOR.md),
[`REVIEW-ORCHESTRATOR.md`](REVIEW-ORCHESTRATOR.md).

The third triage query is the interesting one. "The owner answered a question" has no label of its
own, which is what once justified a durable event queue. It needs none: check whether the newest
comment on a `needs-decision` issue is bot-authored. If it is not, the owner has spoken and the lane
has not replied yet. Once the lane replies — every comment carries `<!-- loop-bot lane=triage -->` on
its first line — the newest comment is a bot comment and the query stops matching. Stateless, and it
cannot drift.

That marker is therefore load-bearing twice: it prevents the lane waking itself on its own words, and
it is how "answered" is distinguished from "awaiting an answer".

No label edge is a review trigger, in either direction. `review:blocked` → `review:pending` was the
last one *described* as one, meaning "I pushed a fix, re-review me" (a worker that pushed without
flipping it waited, and its comment asking for re-review was inert). That description was carried as
unverified, because the flip and a new head had always arrived together. **One PR separates them:**
verdict 3 posted at `04:31:41Z` against head `b48581f` while the PR carried `review:blocked` and no
`review:pending`, and the flip did not arrive until `04:35:32Z` — 3m51s later. The head had been
force-pushed at `04:14:38Z`, before the block was applied. So the re-review is the head-based probe in
the table above doing its ordinary job on an unjudged head; the flip is board state the reviewer clears.
Keep flipping it — the instruction is unchanged, only its stated reason is. The reason is settled.

`review:pending` added is **not** in that category, despite this file previously saying it was. The
review probe is label-blind, so the label is board state the reviewer clears, not an entry trigger.
One PR was cited here as left unreviewed for want of the label; its timeline does not support that —
opened `02:16:00Z`, labelled `02:28:31Z`, verdict `02:39:56Z`, so the verdict came *after* the label, by
about one patrol interval. On another PR a verdict landed while it carried no review label at all. See
[`LABELS.md`](LABELS.md#labels-still-doing-trigger-duty); measured, not assumed.

## What polling does not change

With no CI there is no `check_suite` to consume, so no lane can ever trust an external verdict. Every
lane re-establishes ground truth with `gh` and re-runs its own gates. A faster wake would not have
changed that.

## Sidebar layout

```
Encore
├── orchestrator   the three orchestrators
├── dev            one session per issue (coding workers)
├── review         one session per PR (reviewers)
└── triage         one session per issue (triage workers)
```
Workers are created with `agent="default"` passed EXPLICITLY and the folder id passed explicitly.
Both are silent failures if omitted: omitting the agent inherits the caller's in some contexts, and a
dropped folder lands the session unfiled at the sidebar root.

Runtime state — the append-only triage log — lives outside the repo at
`/local/home/angryang/workspace/encore-loop-state/`. Nothing in `docs/loop/` should point into
`.kiro/`; the one remaining exception is the `prove_per_hunk.py` proof harness.
