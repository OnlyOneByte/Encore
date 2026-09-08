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
                        │   GitHub issues+PRs  │
                        │   labels = state     │
                        └──────────┬───────────┘
                                   │ webhook, outbound connection
                                   ▼
                        gh webhook forward ──▶ translator ──▶ cron trigger
                                                    │
                    ┌───────────────────────────────┘
                    ▼
            TRIAGE-Unified  (~5s after the event)
            labels, comments, asks the owner
                    │ applies `triaged`
                    ▼
        ┌───────────────────────────┐        ┌──────────────────────┐
        │  DEV CONDUCTOR (session)  │───────▶│  REVIEW ORCHESTRATOR │
        │  dispatches 1 worker per  │        │  1 reviewer per PR   │
        │  issue, max 5 in flight   │◀───────│  max 5, one verdict  │
        └───────────────────────────┘        └──────────────────────┘
```

Two structural facts that shape everything downstream:

- **There is no CI.** `.github/` does not exist — no workflows, no check runs, no `PR Readiness`
  status. Every gate is re-run by an agent on the box.
- **`main` has no branch protection.** So the label gates plus the conductor's independent verification
  are the entire safety system. See [`COMMON.md`](COMMON.md#merge-safety).

## Labels are state. Events are the bus.

Labels are a good coordination store — visible, crash-safe, no side database. They used to do a second
job as well: a lane learned there was work by noticing a label had changed since it last looked. That
is edge detection by polling, and a missed edge was silent and permanent. It cost two issues:

- **#707** — a freshly-opened PR carrying no label was *invisible* to the review lane, so its author
  waited for a verdict that never came.
- **#681** — a worker pushed a fix but left `review:blocked` in place and waited **forever**; the
  comment it posted asking for re-review was inert.

Both are events GitHub already emits. Triage now runs on those events, and the remaining label-as-
trigger edges are listed in [`LABELS.md`](LABELS.md#labels-still-doing-trigger-duty).

What webhooks did **not** change: what a lane may trust. With no CI there is no `check_suite` to
consume, so an event only says *when* to look. Every lane still re-establishes ground truth with `gh`
and re-runs its own gates.

## How each lane is woken

| Lane | Woken by | Latency |
|---|---|---|
| Triage | GitHub webhook → `cron trigger` on `TRIAGE-Unified`; its 2h schedule is only a safety net | ~5s |
| ISSUEGEN x5 | wall clock, staggered 4h offsets, six passes per charter per day | n/a |
| Dev conductor | its own ~90s patrol, reading GitHub for dispatchable issues | ≤90s |
| Coding worker | dispatched by the conductor; then its own review-wait loop | — |
| Review orchestrator | a PR appearing; one reviewer per PR, oldest head first | — |

Triage is the only lane on the webhook path today. The dev and review lanes still poll, which is a
known gap rather than a design choice — the trigger they need (`issues.labeled`, `pull_request.opened`,
`pull_request.synchronize`) is already delivered and recorded by the translator; nothing consumes it
yet.

## Why triage is a cron and the others are sessions

A webhook-woken agent turn runs **unattended**: it inherits whatever approval policy the gateway
started with, so a turn needing `gh` can block on an approval nobody is there to give and sit until it
times out. Cron jobs do not have that problem — they carry their own auto-approval. So the translator
does not run the lane itself; it rings the doorbell on a cron job with `kirocrew cron trigger`, which
also means the ingress needs **no gateway credential at all**.

The dev and review orchestrators are long-lived **sessions** instead, because they hold accumulated
context — rulings, in-flight tables, per-issue decisions — that an ephemeral turn cannot carry. That
context is why they are not simply moved onto the webhook path.

One consequence worth knowing: a cron run is a `cron_*` session, not a dashboard chat session, so it
**cannot be filed into a sidebar folder**. `Encore/triage` stays empty while triage is cron-driven.

## Sidebar layout

```
Encore
├── orchestrator   the dev conductor and the review orchestrator
├── dev            one session per issue (coding workers)
├── review         one session per PR (reviewers)
└── triage         empty — triage is a cron, see above
```
