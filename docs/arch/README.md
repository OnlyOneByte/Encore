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

A row may name a test that does not exist yet, but it has to say so at the site. Nothing checks the
paths cited in these documents automatically, so a stale path here is only caught by reading.

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

| Document                             | Covers                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| [`04-alignment.md`](04-alignment.md) | How a lyric gets its timings: the decode, the repair ladder, the four gates, grading, invariants                     |
| [`05-worker.md`](05-worker.md)       | The rest of the worker: separation and stem roles, the audio profile, artifacts, providers, transport, durability, invariants |

The rule they serve: a docstring in `worker/encore_worker` says WHAT and WHY in a few lines and points
at the section of one of these documents that explains the mechanism.

## Why this tree exists separately

These are subsystem contracts, not design rules: media layout, HTTP status codes and job retry
ceilings are not things a designer argues about. A ship-blocking row lives in whichever document its
subject belongs to.

Two areas deliberately have no namespace of their own here:

- **`src/lib/server/realtime`** is governed by "Authority and the hub" in
  [`../SERVER.md`](../SERVER.md), which already cites its call sites; a second namespace over the same
  subject would produce two places to look and two rules to keep in agreement.
- **`src/lib/components` and `src/lib/tv`** are governed by the design rules in
  [`../FRONTEND.md`](../FRONTEND.md), so their contracts belong beside them rather than here.
