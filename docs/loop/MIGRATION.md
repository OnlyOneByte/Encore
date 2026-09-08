# Migration plan

Moving the loop's event bus from label edges to GitHub webhooks, one lane at a time.

## Principles

- **One lane per stage.** A stage lands, is observed working, and only then does the next begin.
- **Labels keep their state job.** Nothing in this plan deletes a label. What goes away is a label
  edge being used to *signal* something, once the real event exists.
- **Every existing lever keeps working.** Stripping `triaged` must still trigger a re-triage. New
  triggers are additive, so nothing the owner already knows how to do stops working.
- **The cron is paused, never deleted.** Every stage's rollback is re-enabling one cron.
- **`inbox` mode first.** Bring the ingress up inert, confirm events accumulate, then switch the lane
  over deliberately. Safe to do mid-wave.

## Stage 0 — ingress (prerequisite)

Not a lane. Stand up the transport, with nothing consuming it.

- A per-repo `gh webhook forward` process for `OnlyOneByte/Encore`, with its own pidfile and log.
- The translator on loopback, `WAKE_MODE=inbox`.
- The supervisor's leaked-hook sweep extended to be per-repo, and `status` deriving health from the
  forwarder log tail rather than `pgrep`. Both are required — see
  [`WEBHOOKS.md`](WEBHOOKS.md#two-known-traps).

**Done when:** an issue event lands in `inbox/` within ~2s, a forged request is rejected `401`, and a
`SIGKILL` of the forwarder recovers on the next watch attempt with the leaked hook swept and no `422`
loop. Registering the repo hook is a write to the repository — do it deliberately, not as a probe.

## Stage 1 — triage

Full detail in [`TRIAGE.md`](TRIAGE.md#target). Subscribes to `issues.opened`, `issues.reopened`,
`issues.labeled` (`review`), `issues.unlabeled` (`triaged`), and — the new capability —
`issue_comment.created`.

The headline outcome: **answering a triage question in a comment is enough.** No label edit, no wait
for a poll.

Hard prerequisite: **the marker rule.** Every lane that comments must emit
`<!-- loop-bot lane=<lane> -->`, and `pr-bot`'s existing `<!-- pr-bot head=<sha> -->` must be left
exactly as it is. Without this, triage's own Decisions block re-triggers triage forever, and author
filtering cannot help because every lane acts as the same GitHub user.

**Acceptance criteria:** the seven listed in
[`TRIAGE.md`](TRIAGE.md#acceptance-criteria-for-stage-1).

**Rollback:** resume cron `TRIAGE-IssueTriager` (`3ba751b0`), set `WAKE_MODE=inbox`. No code change.

## Stage 2 — dev

Replaces the conductor's per-cycle `gh issue list` poll with dispatch on `issues.labeled` (`triaged`)
and `issues.unlabeled` (`needs-decision`).

This is where the bridging choice becomes load-bearing, because the conductor is a **long-lived
dashboard session** holding rulings and an in-flight table that `register_hook` cannot carry. Take
option A then B from [`WEBHOOKS.md`](WEBHOOKS.md#bridging-into-a-live-session): first have the
existing ~90s patrol drain the inbox instead of polling, then add the doorbell relay to collapse
latency.

Two things that must not change: the **file-overlap check before every dispatch**, and the six merge
conditions. Neither is a trigger, so neither is in scope — but a faster dispatch loop makes overlap
collisions more likely, not less.

**Acceptance criteria:**

1. Applying `triaged` dispatches a worker without waiting for a patrol cycle.
2. Removing `needs-decision` makes the issue dispatchable without a poll.
3. The file-overlap check still runs before every dispatch, and a collision still holds the
   collider.
4. `max_in_flight` is still respected — the faster trigger must not let the fleet exceed it.
5. Killing the gateway mid-dispatch loses no event.
6. The conductor's accumulated context survives the cutover.

**Rollback:** the conductor resumes polling; the ingress reverts to `inbox` mode.

## Stage 3 — review

Full detail in [`REVIEW.md`](REVIEW.md#trigger-surfaces--the-stage-3-migration-list). This stage
retires the most expensive piece of hand-rolled machinery in the loop.

Replaces:

- the `review:pending`-added trigger with `pull_request.opened`, fixing #707 by construction — a PR
  cannot be invisible, because the event is the PR's own creation;
- the `review:blocked` → `review:pending` flip with `pull_request.synchronize`, fixing #681 by
  construction — a push *is* the re-review signal, so no label edit is needed;
- the `gh pr list --limit 50` poll, which silently truncates when open PRs exceed 50.

**The manual flip protocol can then be deleted from the worker brief.** That protocol exists only to
synthesize an edge GitHub already emits, and it has cost two issues.

Note what does **not** change: the verdict contract, the four charters, and the
`<!-- pr-bot head=<sha> -->` marker. The marker becomes *more* important, not less — it remains how a
verdict is scoped to the head it judged.

**ISSUEGEN does not migrate.** It is a scheduled sweep of code, not a reaction to an event, and no
GitHub event means "this slice is worth re-reading". It stays on cron.

**Acceptance criteria:**

1. Opening a PR queues a review with no label applied by the worker.
2. Pushing to a blocked PR queues a re-review with no label edit.
3. A verdict is never posted against a stale head — the `head=` freshness check still holds.
4. Two events for the same PR in quick succession produce one review, not two.
5. More than 50 open PRs are all reachable.
6. The worker brief's manual-flip instructions are removed, and no worker waits on a flip.

**Rollback:** restore the flip protocol in the brief and resume the reviewer's poll.

## Current status

| Stage | State |
|---|---|
| 0 — ingress | Mechanism proven on a sibling repo; **not yet stood up for Encore** |
| 1 — triage | Designed, documented. Not implemented |
| 2 — dev | Not started |
| 3 — review | Not started |

## Risks worth stating

- **A wave in flight during a cutover.** The dev lane runs live worker sessions. `inbox` mode is
  inert and safe to enable mid-wave; switching a lane's trigger is not. Land trigger changes between
  waves.
- **Two brains draining one inbox.** If both a cron and an event-driven lane are live at once they
  will race on labels. Exactly one consumer per lane, always.
- **Faster dispatch is not free.** Removing latency from the dev lane increases the rate at which
  file-overlapping work is dispatched. The overlap gate is what absorbs that, so it must not be
  weakened in the same change.
- **The unattended approval policy is unresolved.** A hook turn runs with whatever policy the gateway
  started with, and a turn that blocks on an unapprovable tool call looks exactly like a wedged
  orchestrator. This gates the doorbell relay in stage 2. See
  [`WEBHOOKS.md`](WEBHOOKS.md#the-unattended-turn-caveat).
