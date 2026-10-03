# Encore — architecture requirements

> **Purpose.** The subsystem contracts as requirements a person can disagree with and a machine can
> often check. How the system works now is [`../ARCHITECTURE.md`](../ARCHITECTURE.md); the rules a
> change has to respect are [`../SERVER.md`](../SERVER.md) and [`../FRONTEND.md`](../FRONTEND.md);
> what the tests already cover is [`../TESTS.md`](../TESTS.md). Open work is tracked in
> **GitHub issues**.

**35 requirements** across three sections. Each row is a table with the same seven fields:

| Field          | What it carries                                                                            |
| -------------- | ------------------------------------------------------------------------------------------ |
| **Statement**  | the requirement itself, in the present tense, with its named exemptions                    |
| **Surfaces**   | where a user meets the consequence, or `None directly` for a server-only rule              |
| **Rationale**  | what goes wrong without it — the cost, not the mechanism                                   |
| **Source**     | `Cited` (repo evidence, naming the file) or `DERIVED` (with its model stated)              |
| **Acceptance** | given/when/then, ending in the single observation that would falsify it                    |
| **Check**      | the test that defends it, or what is missing — `exists`, `half exists`, or `to be written` |
| **Priority**   | `Ship-blocking`, or the reason it is not                                                   |

A row may name a test that does not exist yet, but it has to say so at the site. Nothing checks cited
paths automatically any more — the guard that did (`cited-paths-resolve.test.ts`) went with the guard
suite, so a stale path here is now only caught by reading.

| Section                      | Rows | Covers                                                                                          |
| ---------------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| [`01-media.md`](01-media.md) | 11   | Where a song's bytes live, which may be destroyed, what may be claimed about an unmeasured file |
| [`02-api.md`](02-api.md)     | 12   | The HTTP envelope, status discipline, and what an unjoined caller may do and learn              |
| [`03-jobs.md`](03-jobs.md)   | 12   | Restart and crash recovery, idempotency and retry, how a failure becomes visible                |

## Two worker documents, in a different genre

The first three sections are requirement rows. The two below are **design documents** for the Python
worker — the pipeline, what each mechanism is for, and what was measured and rejected — because that
subsystem is large enough that a reader needs the mechanism explained before a row about it means
anything. Each ends in an invariants table in the same spirit as a row above (statement, why, what holds
it). Each quotes **only the few readings a rule cannot be understood without** — a gate that let 189 of 380
wrong texts through is an argument, not a statistic — while every sweep, every table and every per-song
reading lives in `../benchmarks/`. A number in one of these documents is load-bearing: it is there because
deleting it would leave a rule looking arbitrary.

| Document                                   | Covers                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| [`04-alignment.md`](04-alignment.md)       | How a lyric gets its timings: the decode, the repair ladder, the four gates, grading, 17 invariants  |
| [`05-worker.md`](05-worker.md)             | The rest of the worker: separation and stem roles, the audio profile, artifacts, providers, transport, durability, 14 invariants |

They exist because the code used to carry them. In October 2026 `worker/encore_worker` was 54% prose —
3 876 comment lines and 7 764 docstring lines against 9 778 of code, blank lines excluded — which is a
documentation set living inside a package. The owner's directive moved it here, measurements to
`../benchmarks/`, on the rule that a docstring says WHAT and WHY in a few lines and points at the document.
(The directive's own count of the same tree reads 48% — 3 685 comment and 7 577 docstring lines against
12 252 of code. The two counts were taken by different instruments days apart, so all three columns differ,
not only the code one; neither is wrong and the ratio is the point. Both counts, and the check that no
measured number was lost in the move, are in
[`../benchmarks/forced-alignment/README.md`](../benchmarks/forced-alignment/README.md), "W7b".)

## Why this tree exists separately

These are subsystem contracts, not design rules: media layout, HTTP status codes and job retry
ceilings are not things a designer argues about. A ship-blocking row lives in whichever document its
subject belongs to.

Two areas deliberately have no namespace of their own here:

- **`src/lib/server/realtime`** extends the concurrency rows instead. Authority already governs that
  ground and already cites its call sites; a second namespace over the same subject would produce two
  places to look and two rows to keep in agreement.
- **`src/lib/components` and `src/lib/tv`** are governed by the design rules in
  [`../FRONTEND.md`](../FRONTEND.md), so their contracts belong beside them rather than here.

## What these three sections found

Recorded here because each was verified against source and each is open. A reader who assumes this
tree is descriptive will otherwise mistake these for settled behaviour.

**1. A permanently failed process settled its readiness gate in memory only — NOW FIXED, both halves.** `stem_status` and
`lyrics_status` are stored columns and the _processing_ flip is persisted, but the terminal-failure path
carried no persistence sink and no boot pass reconciled the value against the job ledger. After a
restart the song read as still processing, with a terminal job row and no Sing button. `XR-JOB-04`. The
epilogue now persists a settled gate at all three terminal paths, and a boot pass
(`reconcileStrandedGates`) re-derives every gate the ledger says nothing alive can finish — which is
what recovers rows stranded BEFORE the sink existed, plus a crash between the settle and the write and a
job row deleted with its dedup slot. Both halves settle through one shared table, so neither can drift.

**2. The unservable-job TTL was not a timer — NOW FIXED.** Both the stamp and the check live inside `dispatch()`,
which is event-driven; with an empty fleet nothing is assigned or running, so the sweep produces no
actions, `dispatch()` is never called again, and the 120 s TTL is never reached. It reproduces the
exact hang the TTL was added to end, in the quietest case. The reaper now fires a dispatch hook on every
tick rather than only on a tick that changed a job. `XR-JOB-11`.

> The trap for whoever fixes it: `worker-hub.test.ts` _appears_ to cover this branch, because the
> test supplies the second `dispatch()` pass that production may never make. A test can be green
> about a path that production cannot reach.

**3. One endpoint answers 200 for a request it discards.** `POST /api/lyrics-reselect` reads
`body.text`, branches on it and returns a job id; `pinnedText` appears in exactly one TypeScript
file — its own type declaration. The worker half is built and waiting. A guest pastes correct lyrics,
is promised a job, and watches the wrong words scroll past. `XR-API-06`.

**4. Eleven auth gates had zero assertions.** Was closed by `route-auth-posture.test.ts`, which pinned every route method's posture, per method,
because one file gates its `PUT` and leaves its `GET` open. **That guard was deleted with the guard
suite, so this is REOPENED.** `XR-API-12`.

**5. `MediaStore.url()` had no production caller — RESOLVED by deletion.** It was documented as how
the TV resolves a playable source and presigned with a one-hour TTL; the TV string-builds the path
directly instead. Its test exercised it _from a test_, which is what kept the production absence
invisible to coverage. The method, `mediaProxyUrl`, `S3Like.presign` and the
`presignExpiresIn`/`proxyUrls` options are now deleted, with the reason on record at
`src/routes/media/[...path]/+server.ts` and the rule was pinned by
`store-members-have-production-callers.test.ts` — **deleted with the guard suite, so the rule is now
unenforced.** `XR-MED-10`.
