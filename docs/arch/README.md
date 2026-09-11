# Encore — architecture requirements

> **Purpose.** The subsystem contracts as requirements a person can disagree with and a machine can
> often check. Its sibling [`../ux/`](../ux/README.md) holds the same kind of document for the
> **design** rules; ratified decisions are in [`../DECISIONS.md`](../DECISIONS.md), how the system
> works now is [`../ARCHITECTURE.md`](../ARCHITECTURE.md), and how to operate it safely is
> [`../HANDOFF.md`](../HANDOFF.md). Open work is tracked in **GitHub issues**.

**35 requirements** across three sections. Row format, field meanings and the `Source` markers are
defined once in [`../ux/README.md`](../ux/README.md#how-to-read-a-row) and are identical here — a
reader who knows one tree can read the other without relearning anything.

| Section | Rows | Covers |
|---|---|---|
| [`01-media.md`](01-media.md) | 11 | Where a song's bytes live, which may be destroyed, what may be claimed about an unmeasured file |
| [`02-api.md`](02-api.md) | 12 | The HTTP envelope, status discipline, and what an unjoined caller may do and learn |
| [`03-jobs.md`](03-jobs.md) | 12 | Restart and crash recovery, idempotency and retry, how a failure becomes visible |

## Why this tree exists separately

`../ux/` opens by declaring itself **UX requirements** — the design rules. Media layout, HTTP status
codes and job retry ceilings are not design rules, and filing them there would dilute a document
whose stated purpose is the thing a designer argues about. The split is by *kind of concern*, not by
importance: a ship-blocking row lives in whichever tree its subject belongs to.

Two areas deliberately did **not** get a namespace here:

- **`server/realtime`** extends `XR-CON` instead. Concurrency and authority already govern that
  ground and already cite its call sites; a second namespace over the same subject would produce
  two places to look and two rows to keep in agreement.
- **`lib/components` and `lib/tv`** went to `../ux/` as `XR-CMP` and `XR-TVM`. They are the
  components the design rules already constrain, so their contracts belong beside them.

## What these three sections found

Recorded here because each was verified against source and each is open. A reader who assumes this
tree is descriptive will otherwise mistake these for settled behaviour.

**1. A permanently failed cook settles its readiness gate in memory only.** `stem_status` and
`lyrics_status` are stored columns and the *cooking* flip is persisted, but the terminal-failure path
carries no persistence sink and no boot pass reconciles the value against the job ledger. After a
restart the song reads as still cooking, with a terminal job row and no Sing button. `XR-JOB-04` —
and it is the one finding in this tree a guest cannot work around.

**2. The unservable-job TTL is not a timer.** Both the stamp and the check live inside `dispatch()`,
which is event-driven; with an empty fleet nothing is assigned or running, so the sweep produces no
actions, `dispatch()` is never called again, and the 120 s TTL is never reached. It reproduces the
exact hang the TTL was added to end, in the quietest case. `XR-JOB-11`.

  > The trap for whoever fixes it: `worker-hub.test.ts` *appears* to cover this branch, because the
  > test supplies the second `dispatch()` pass that production may never make. A test can be green
  > about a path that production cannot reach.

**3. One endpoint answers 200 for a request it discards.** `POST /api/lyrics-reselect` reads
`body.text`, branches on it and returns a job id; `pinnedText` appears in exactly one TypeScript
file — its own type declaration. The worker half is built and waiting. A guest pastes correct lyrics,
is promised a job, and watches the wrong words scroll past. `XR-API-06`.

**4. Eleven auth gates had zero assertions.** Closed while this tree was being written:
`tests/guards/wiring/route-auth-posture.test.ts` now pins every route method's posture, per method,
because one file gates its `PUT` and leaves its `GET` open. `XR-API-12`.

**5. `MediaStore.url()` has no production caller.** It is documented as how the TV resolves a
playable source and presigns with a one-hour TTL; the TV string-builds the path directly instead.
Its test exercises it *from a test*, which is what keeps the production absence invisible to
coverage. `XR-MED-10`.
