# Karaoke — Job Lifecycle & Dial-Home Worker Protocol

Status: **LOCKED** (MVP design)
Scope: how a "make karaoke from this song" request flows from queue → worker → ready, and
how workers attach to the core. Instant media (YouTube iframe, pre-made files) does NOT
touch this system at all.

---

## 1. Principles

1. **Core is the coordinator + durable ledger.** SQLite holds job *state of record*. It is
   never the transport.
2. **Workers dial home.** Worker opens a WS *to* the core, announces capacity, core pushes
   work. Works across NAT / different servers. Add N workers → linear throughput.
3. **Eager.** Job fires the instant a song is added to the queue, not when it's about to play.
4. **Ordered by need.** Among queued jobs, process the one whose turn comes soonest first
   (priority = rotation position), not strict FIFO.
5. **Connection = liveness.** A job is only "owned" by a worker with a live WS session.
   Core restart drops all sessions → all in-flight jobs safely requeue.
6. **Idempotent.** One job per `(mediaId, jobType)`. Duplicate queue adds subscribe to the
   same job.

---

## 2. Job state machine

```
            create
              │
              ▼
        ┌──────────┐   assign (dispatch)   ┌───────────┐
        │  queued  │ ────────────────────► │ assigned  │
        └──────────┘                       └───────────┘
           ▲   ▲                             │   │   │
           │   │ ack-timeout / reject        │   │   │ job:accept
   reaper  │   └─────────────────────────────┘   │   ▼
  (lease   │                                      │ ┌──────────┐
  expired, │   progress-lease expired / worker    │ │ running  │◄─┐ job:progress
  attempt+)│   died (attempt+, < maxAttempts)     │ └──────────┘  │ (self-loop)
           └──────────────────────────────────────┘   │   │   └──┘
                                                        │   │ job:complete
           queued, attempts ≥ maxAttempts               │   ▼
                    │                                    │ ┌────────┐
                    ▼                                    │ │ ready  │ (terminal ✅)
              ┌──────────┐                               │ └────────┘
              │  failed  │ (terminal ❌)                 │ job:failed(retryable=false)
              └──────────┘ ◄───────────────────────────-┘

   any non-terminal state ──user removes song──► canceled (terminal)
```

| State | Meaning | Leaves on |
|---|---|---|
| `queued` | created, no worker | dispatch → `assigned`; cancel; max-attempts → `failed` |
| `assigned` | pushed to a worker, awaiting ack | `job:accept`→`running`; reject/ack-timeout→`queued`; cancel |
| `running` | worker actively processing | `job:complete`→`ready`; `job:failed`; lease-expiry→`queued`; cancel |
| `ready` | stems/lyrics written, media flipped | — terminal |
| `failed` | retries exhausted or non-retryable | — terminal (UI offers fallback/retry) |
| `canceled` | song removed before finish | — terminal (worker told to abort) |

---

## 3. Leases (the crash-recovery mechanism)

Two timers, both enforced by a single **reaper** tick on the core (every ~3s):

- **Ack lease** — after `job:assign`, worker must `job:accept` within `ackTimeoutSec` (default
  **10s**). Else → back to `queued` (no attempt increment; worker never started).
- **Progress lease** — while `running`, worker must emit `job:progress`/heartbeat at least every
  `heartbeatIntervalSec` (default **30s**). If `now > lastProgressAt + grace` → assume dead →
  back to `queued`, **attempts++**.

**Core boot recovery:** on startup, every job in `assigned`/`running` is reset to `queued`
(its owning WS session is gone by definition). Workers reconnect via dial-home and get
redispatched. No manual cleanup, no stuck jobs.

---

## 4. Dispatch algorithm

Triggered by: (a) new job enqueued, (b) worker frees a slot / completes, (c) reaper requeue,
(d) rotation reorder (re-prioritizes).

```
eligible_workers = registry.where(slotsFree > 0 AND capabilities ⊇ job.type)
if none: leave queued (will dispatch when a worker frees up)
next_job = queued_jobs.order_by(priority ASC, createdAt ASC).first   # priority = rotationSeq
worker   = eligible_workers.order_by(slotsFree DESC).first           # least-loaded
→ job.state = assigned; job.workerId = worker.id; set ack lease
→ send job:assign to worker; worker.slotsFree--
```

**Priority = the rotation position of the soonest queue entry that needs this media.** A song
that's *next up* preempts one 5 turns away. Recompute job priority when the rotation changes.

---

## 5. Wire protocol

All messages are JSON `{ type, ...payload }` over the dial-home WS. `jobId`/`mediaId` are ULIDs.

### Worker → Core
| `type` | Payload | Effect |
|---|---|---|
| `worker:hello` | `workerId, authToken, capabilities[], concurrency, version` | register / re-register |
| `worker:heartbeat` | `slotsFree, runningJobIds[]` | liveness + reconciliation |
| `job:accept` | `jobId` | `assigned → running`, start progress lease |
| `job:reject` | `jobId, reason` | `assigned → queued` (try another worker) |
| `job:progress` | `jobId, stage, pct, etaSec?` | refresh lease + rebroadcast to phones |
| `job:complete` | `jobId, mediaUri, artifacts{stems{...}, lyrics?{...}}` | `running → ready`, flip media |
| `job:failed` | `jobId, error, retryable` | requeue (if retryable & attempts left) else `failed` |

### Core → Worker
| `type` | Payload | Effect |
|---|---|---|
| `worker:welcome` | `heartbeatIntervalSec, ackTimeoutSec, mediaStore{kind, ...}` | config handshake |
| `job:assign` | `jobId, mediaId, jobType, sourceUri, params{model, targetKey?}` | offer work |
| `job:cancel` | `jobId, reason` | abort in-flight work, free slot |
| `ping` | — | liveness probe |

### Core → Phones / TV (UI rebroadcast — the premium feel)
| `type` | Payload |
|---|---|
| `media:status` | `mediaId, status(queued\|downloading\|separating\|aligning\|ready\|failed), pct, etaSec` |

`stage` from the worker maps 1:1 to the `status` the phone shows on the live progress bar:
`Queued → Downloading → Separating vocals… 68% → Ready ✅`.

---

## 6. Idempotency & dedup

- Job identity = unique key `(mediaId, jobType)`.
- On queue-add, if a non-terminal job for that key exists → **reuse it**; the new queue entry
  just subscribes to the same `media:status`. Two people queueing the same song = one compute.
- On `ready`, every queue entry pointing at that media becomes playable at once.

---

## 7. Rotation interaction — the "held slot"

When a `processing` queue entry reaches the front:
- **ready** → play.
- **not ready** → entry → `waiting`; rotation advances to the next singer; entry keeps its
  `rotationSeq` so it slots back at the *same fairness position* when ready.
  TV shows: `Maya's song is still cooking 🔥 — up next: Sam`.
- **failed** → drop from queue, notify the singer's phone, offer **play original / retry**.

---

## 8. Failure & retry

- `job:failed retryable=true` → requeue if `attempts < maxAttempts` (default **3**) with small
  backoff; else → `failed`.
- `retryable=false` (corrupt source, unsupported, source gone) → `failed` immediately.
- Terminal `failed` → singer notified, fallback offered (play original audio / YouTube iframe).

---

## 9. Crash scenarios

| Scenario | Outcome |
|---|---|
| Worker dies mid-job | progress lease expires → reaper requeues (attempt++) → another worker |
| Core restarts | WS sessions drop → boot resets assigned/running → workers redial → redispatch |
| Worker net blip | WS reconnect w/ same `workerId`; `worker:hello` reconciles `runningJobIds` vs ledger — orphaned work aborted, live work resumes reporting |
| Duplicate add | dedup key → single job |
| Single-box mode | core hosts an in-process worker (thread) using the same protocol over a loopback channel — identical lifecycle, zero extra containers |

---

## 10. Job ledger schema (SQLite, Drizzle)

```ts
jobs = {
  id:            ulid (pk),
  mediaId:       fk → media,
  jobType:       'stems' | 'align' | 'score',
  status:        'queued'|'assigned'|'running'|'ready'|'failed'|'canceled',
  priority:      int,            // mirror of soonest rotationSeq; lower = sooner
  attempts:      int default 0,
  maxAttempts:   int default 3,
  workerId:      text null,      // current owner
  stage:         text null,      // last reported worker stage
  progressPct:   int default 0,
  etaSec:        int null,
  error:         text null,
  leaseExpiresAt:int null,       // epoch ms; ack-lease or progress-lease deadline
  createdAt:     int,
  updatedAt:     int,
  // unique(mediaId, jobType) where status NOT IN ('failed','canceled')  → dedup
}
```

Worker registry is **in-memory only** (rebuilt from dial-home reconnects) — never persisted.
