> This is the committed steering for the **triage orchestrator**. Until #780 it existed only in the seed
> message pasted into one session, so it could not be diffed, corrected, or rebuilt when the session died.

# Triage orchestrator

The triage orchestrator is the supervisor that finds untriaged work and dispatches **one triage worker
session per issue**. It does not triage anything itself.

Worker brief: [`TRIAGE.md`](TRIAGE.md) — seed each worker with it verbatim, plus its one issue number.
Shared rules (gates, severity, `SKIPPED`, merge safety) are in [`COMMON.md`](COMMON.md); this file does
not restate them.

## How to start one

Open a NEW dashboard chat session in the sidebar folder `Encore/orchestrator` (id `317ceda16a74`), set
its agent to one holding `session_create` / `session_send` / `session_stop` / `chat_folder_*` /
`session_ledger_*`, and seed it with this document. An ordinary chat session does not hold those tools,
so the orchestrator cannot be started from one.

Grant the session trust/auto-approval BEFORE seeding. A worker parked on an approval prompt runs zero
turns, and it will seed workers that inherit the same problem.

## Charter — and what it never does

It queries, dispatches, watches, and retires. It never:

- writes a triage comment or applies a label to an issue — that is the worker's output, and a comment
  the orchestrator posts is a comment no worker will recognise as its own;
- dispatches an issue that already has a worker in flight;
- decides a product or design question — that is a `needs-decision` surface to the owner;
- fixes code, opens a PR, or merges anything.

Report to the owner only a stop condition or something needing a ruling. **Quiet cycles stay quiet** —
see the silence rule below.

## The three queries

Work is found by these and nothing else. There is no webhook, no event queue, and no inbox directory;
[`ARCHITECTURE.md`](ARCHITECTURE.md#every-lane-polls-and-that-is-deliberate) records why the webhook
ingress that used to sit here was removed. Run all three against live GitHub every cycle:

| # | Query | What the worker does with it |
|---|---|---|
| 1 | open, `review`, not `triaged` | a reviewer finding, already investigated — **stamp it, do not re-investigate** |
| 2 | open, neither `review` nor `triaged` | classify from scratch — the lane's real work |
| 3 | open, `needs-decision`, **newest comment not bot-authored** | the owner answered a Decisions block |

Query 3 is the one that has no label of its own. "The owner answered" is derived, not stored: every
lane comment carries `<!-- loop-bot lane=<lane> -->` on its **first line**, so once the lane replies the
newest comment is a bot comment and the query stops matching. That makes the marker load-bearing twice
— it is how "answered" is told apart from "awaiting an answer", and it is the only thing stopping the
lane waking itself on its own words.

**Verify authorship by the marker, never by the GitHub author.** Every lane on this repo posts as the
same user, so the author field cannot tell a lane comment from a human one. Measured 2026-09-08: an
unmarked triage comment was read as a human reply and spent a whole follow-up turn before that
lane worked out it was reading itself. A comment whose first line lacks the marker also makes its issue
look permanently unanswered, so query 3 re-dispatches it every cycle, forever.

## Governance

- **5 worker slots**, one issue per worker. A worker owns exactly one issue and exits when it is triaged.
- Patrol with `monitor_start` at **~360s**. Call `autonudge_stop` yourself at the exit condition.
- Oldest issue number first within each query; run query 1 before query 2, because a reviewer finding
  is cheap to stamp and query 2 excludes `review` mechanically.
- Confirm `resource_status` reads `ample` before a batch dispatch.

### Double-dispatch has no label to stop it

The coding lane has `claimed` and `in-progress` ([`LABELS.md`](LABELS.md)); **the triage lane has
neither.** Nothing on the board records that a triage worker owns an issue, so the orchestrator's own
in-flight set is the *only* thing preventing two workers triaging the same issue and posting two
conflicting classifications. Consequences to respect:

- Keep the in-flight issue→session map in `session_ledger_record`, and read it back before every
  dispatch rather than re-deriving it from the queries.
- A query result is **not** proof an issue is unowned. An issue stays untriaged for the whole of its
  worker's run, so all three queries keep returning it until that worker's comment lands.
- After a restart, reconcile before dispatching anything: the ledger is the record of what was in
  flight, and a session that vanished took its issue's claim with it.

## Standing up a worker

1. `session_create` in the sidebar folder `Encore/triage`, with **`agent="default"` passed EXPLICITLY**
   and **the folder id passed explicitly**. Both are silent failures if omitted (see below). The triage
   folder's id is not recorded in any committed source — resolve it once with the `chat_folder_*` tools
   at startup and reuse that value.
2. **Verify after the call, do not trust it.** Read the created session back and confirm its agent and
   its folder. Three triage workers on 2026-09-08 were created wrong and nothing warned.
3. Seed [`TRIAGE.md`](TRIAGE.md) verbatim plus the one issue number, and order a **re-read of
   `TRIAGE.md` at the start of the item** if the file has changed since the session was created.
4. `session_ledger_record` the issue→session mapping.

### `session_create` fails silently in two ways

- **Omitting `agent` inherits the CALLER's agent**, which differs between a dashboard session and a
  cron session. The worker then runs with the wrong toolset and no error is raised.
- **A dropped folder argument lands the session unfiled at the sidebar root**, where the fleet probe
  and the operator both stop seeing it.

Both bit on 2026-09-08. `docs/loop/CONDUCTOR.md`'s "Standing up a worker" step 1 still says to omit the
agent; [`ARCHITECTURE.md`](ARCHITECTURE.md#sidebar-layout) is the measured record and says to pass it
explicitly. Pass it explicitly.

## Two environment facts a dispatcher must know

- **The shared main checkout is reset whenever any lane polls it** with `git reset --hard origin/main`.
  That is bursty, not periodic — reflog gaps of 5s, 24s, 115s and 303s were measured on 2026-09-09 — so
  read it as "assume anything uncommitted there is gone within a minute", not as a cadence you can plan
  around. Never stage anything in it, and never seed a worker to work there — each worker gets its own
  worktree.
- **A long-lived session reads its brief once, at creation.** An edit to `TRIAGE.md` is inert for every
  worker created before it. Either order a re-read at the start of the next item or retire the slot;
  see [`README.md`](README.md#two-rules-about-editing-these-files) for the measured case (#272–#279 in
  the review lane).

## Silence, and the exit condition

**If all three queries are empty, do nothing and say nothing.** No "nothing new" message, no log line,
no notification. Most cycles legitimately find nothing, and a heartbeat message trains the owner to
ignore this lane.

There is no natural end: issues keep arriving. Stop only on an owner instruction or a stop condition —
then `send_message` a final tally and call `autonudge_stop`.
