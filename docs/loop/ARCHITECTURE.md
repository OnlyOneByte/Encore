# Loop architecture

## The shape today

```
                  ┌─────────────────────────────────────────┐
                  │  ISSUEGEN ×5  (cron, staggered)         │
                  │  reads one code slice, files issues     │
                  └────────────────┬────────────────────────┘
                                   │ opens issue with `review` + `rev:*`
                                   ▼
   owner opens ──────────▶  ┌──────────────┐
   an issue                 │  GitHub      │
                            │  issues +    │◀────── labels are the state
                            │  PRs         │        AND the event bus
                            └──┬────────┬──┘
        polls every 900s ──────┘        └────── polled per pass
                 │                                     │
                 ▼                                     ▼
        ┌─────────────────┐                  ┌────────────────────┐
        │  TRIAGE (cron)  │                  │  PR REVIEW         │
        │  labels + asks  │                  │  one verdict/head  │
        │  the owner      │                  │  sets approved /   │
        └────────┬────────┘                  │  blocked           │
                 │ applies `triaged`         └─────────▲──────────┘
                 ▼                                     │ `review:pending`
        ┌──────────────────────────────┐               │
        │  DEV — conductor session     │───────────────┘
        │  polls for triaged issues,   │  dispatches one worker session
        │  dispatches coding workers   │  per issue; worker merges after
        └──────────────────────────────┘  the conductor's independent go
```

Two structural facts about Encore that shape everything downstream:

- **There is no CI.** `.github/` does not exist — no workflows, no check runs, no `PR Readiness`
  status, no reviewer lanes. Every gate is re-run by an agent on the box.
- **`main` has no branch protection.** So the label gates plus the conductor's independent
  verification are the *entire* safety system. Nothing external will catch a bad merge.

## The problem: labels are doing two jobs

Labels are a good state store. They are a bad event bus, and they are currently being used as both.

| Label edge | What it is really being used for | Failure mode |
|---|---|---|
| `triaged` removed | "re-triage this issue" | Only lever the owner has; noticed up to 900s later |
| `review:pending` added | "a PR is ready to review" | A PR opened without it is **invisible** (#707) |
| `review:blocked` → `review:pending` | "I pushed a fix, re-review me" | Left in place → waits forever; a comment is inert (#681) |
| `review` added | "triage should stamp, not re-investigate" | Missing → triage tries to reproduce an architecture finding |
| `needs-decision` removed | "the owner answered" | Nothing reads the answer itself; a label left on parks the issue indefinitely |

The pattern is identical in every row: a lane needs to know *something happened*, GitHub already
knows it happened, and the loop instead reconstructs it by comparing label state against the last
time it looked. Reconstruction is what fails.

The clearest illustration is the triage Decisions block. Triage asks the owner a question in a
comment and applies `needs-decision`. The owner answers in a comment. That answer changes nothing,
because the only thing the loop watches is the label — so the protocol requires the owner to *also*
perform a label edit to signal that the comment they just wrote exists.

## The target shape

GitHub events become the bus. Labels keep exactly one job: state.

```
GitHub ──(outbound connection, no ingress)──▶ gh webhook forward
                                                     │ signed POST
                                                     ▼
                                            translator (loopback :8787)
                                            verify HMAC · dedupe on
                                            X-GitHub-Delivery · write
                                            one file to a durable inbox
                                                     │
                                                     ▼
                                            ┌────────────────────┐
                                            │  inbox/  (on disk) │
                                            └─────────┬──────────┘
                                                      ▼
                                            the lane drains it, and
                                            reconciles against live
                                            GitHub with `gh`
```

Three properties this buys, none of which the current design has:

1. **Edges cannot be missed.** Every event is delivered with a delivery id, deduped, and written to
   disk *before* anything is dispatched. A crash loses nothing.
2. **Latency collapses** from "up to one poll interval" to about a second.
3. **The hand-rolled label protocol can be retired**, because the events it was simulating are now
   delivered directly. That removes the class of bug behind #681 and #707.

What it explicitly does **not** buy: any new source of truth about correctness. Encore has no CI, so
there is no `check_suite` event to consume. Webhooks change *when* a lane wakes, never *what* it is
allowed to trust. Every lane still re-runs its own gates.

## The constraint that shapes the bridge

Encore's Dev and Review orchestrators are **long-lived dashboard sessions** carrying substantial
accumulated context — rulings, in-flight tables, per-issue decisions. The webhook endpoint cannot
talk to them directly:

- `POST /api/hooks/agent` **refuses** to inject into a dashboard session. `sessionKey` must begin
  with `hook:` — an explicit namespace guard so an external caller cannot steer a chat session.
- Hook sessions are **ephemeral**: one turn, then destroyed. Continuity is only a `register_hook`
  summary, capped at 5,000 characters and dropped entirely after 24 hours.

So the events have to be bridged into the existing sessions rather than delivered to them. The three
ways to do that, and why the staged plan picks the one it does, are in
[`WEBHOOKS.md`](WEBHOOKS.md#bridging-into-a-live-session).

## Ordering of the migration

One lane at a time, in this order, because each stage's blast radius is contained by the one before:

1. **Triage** — [`TRIAGE.md`](TRIAGE.md). Cheapest and most isolated: triage writes labels and
   comments, never code. It also carries the most-felt pain (answering a question requires a label
   edit). Doing it first proves the ingress on a lane that cannot break `main`.
2. **Dev** — [`DEV.md`](DEV.md). Replaces the conductor's `gh issue list` poll with dispatch on
   `issues.labeled`.
3. **Review** — [`REVIEW.md`](REVIEW.md). Replaces the label-transition trigger with
   `pull_request.opened` / `pull_request.synchronize`, and retires the manual flip protocol.

Acceptance criteria per stage are in [`MIGRATION.md`](MIGRATION.md).
