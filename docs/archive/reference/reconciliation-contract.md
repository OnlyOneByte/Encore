# Karaoke — Optimistic UI + Diff-Broadcast Reconciliation Contract

Status: **LOCKED** (MVP design)
Goal: every tap renders instantly; 20 phones stay in sync over flaky wifi; the server is always
the final authority — but the UI never *waits* for it.

---

## 1. Core invariants

1. **Client mints the id.** Queue entries get a **ULID generated on the phone**. The optimistic
   row already carries its final id, so the server's echo matches by id → **no flicker, no
   re-sort, no duplicate**.
2. **Server is authority.** On any conflict, server state wins. Clients converge to it.
3. **Monotonic revision.** Server keeps a single integer `rev` for queue state, incremented on
   every committed mutation. Every broadcast carries the resulting `rev`.
4. **Diffs on the hot path, full state only on (re)connect.** `queue:patch {rev, ops[]}` for
   live changes; `queue:sync {rev, entries[]}` on connect or gap-detected resync.
5. **Idempotent by `clientOpId`.** Retries are safe; the server dedups (same pattern as job
   dedup).

---

## 2. The op envelope

Every mutation — optimistic local apply, the command sent to the server, and the broadcast back
— uses the **same op shape**, so apply logic is written once and reused on both ends.

```ts
type QueueOp =
  | { op: 'add';    entry: QueueEntry }              // entry.id is the client ULID
  | { op: 'remove'; id: string }
  | { op: 'move';   id: string; toSeq: number }      // toSeq = target rotationSeq
  | { op: 'status'; id: string; status: EntryStatus } // playing|waiting|done|skipped

type ClientCommand = {
  clientOpId: string;        // ULID — idempotency + reject routing
  baseRev: number;           // client's rev when it made the change (optimistic concurrency)
  op: QueueOp;
}

type ServerPatch = {
  rev: number;               // new authoritative rev AFTER applying ops
  ops: QueueOp[];            // canonical ops (server may rewrite, e.g. assign rotationSeq)
  causedBy?: string;         // echoes clientOpId so originator can clear 'pending'
}
```

---

## 3. The happy path (optimistic add)

```
PHONE                                    CORE
  │ user taps "Add to my turn"
  │ id = ulid()                          (rotationSeq still unknown — server assigns)
  │ apply locally: entry{pending:true}   ── queue renders THIS FRAME
  │ send ClientCommand{clientOpId, baseRev, op:add{entry}}
  │ ─────────────────────────────────────►
  │                                      validate · assign rotationSeq · rev++
  │                                      persist write-behind (async)
  │ ◄───────────────────────────────────  broadcast queue:patch{rev, ops:[add{entry+seq}], causedBy:clientOpId}
  │ match entry by id:
  │   - clear pending:true
  │   - adopt server rotationSeq (reorder if it differs — usually it won't)
  │ OTHER PHONES: receive same patch, apply add (no pending flag, they never had one)
```

Originator and observers run the **identical apply function** on the broadcast. The only
difference is the originator already had the row (matched by id → update in place) while others
insert it. Net visual: instant for everyone, zero flicker for the actor.

---

## 4. The reject path (the rare exception)

```
  │ send ClientCommand{clientOpId, op:add{...}}
  │ ─────────────────────────────────────►
  │                                      validate FAILS (e.g. room closed, dup, bad media)
  │ ◄───────────────────────────────────  op:reject{clientOpId, reason}
  │ find optimistic entry by the op's id:
  │   - 'add'    → animate row out + toast "couldn't add: <reason>"
  │   - 'move'   → snap back to prior rotationSeq
  │   - 'remove' → re-insert the row
```

Rollback is keyed off the **inverse of the optimistic op**, recorded when the op was applied.
Reject is never silent and never leaves the UI in a wrong state.

---

## 5. Ordering & concurrency

- **`baseRev` = optimistic concurrency token.** Server applies ops in arrival order; it does
  **not** reject on stale `baseRev` for adds/removes (they commute). For **`move`**, if the
  target neighborhood changed since `baseRev`, the server **re-resolves `toSeq`** against current
  state and broadcasts the canonical result — the client adopts it. (Last-write-wins on position,
  authority = server. No lock, no merge dialog.)
- **rotationSeq is server-owned.** Clients propose intent (`toSeq`), server assigns the real
  value. This keeps round-robin fairness centralized and prevents two phones fighting over order.

---

## 6. Gap detection & resync (party wifi WILL drop)

```
on receive queue:patch{rev}:
  if rev == localRev + 1  → apply ops, localRev = rev          (normal)
  if rev <= localRev      → ignore (duplicate / out-of-order)  (idempotent)
  if rev >  localRev + 1  → MISSED ONE → request queue:sync     (gap)

on WS reconnect:
  send hello{lastRev}
  core replies queue:sync{rev, entries[]}  (or a compact patch range if cheap)
  client REBASES: keep still-pending local ops, re-apply on top of authoritative state,
                  re-send any pending ClientCommands (idempotent via clientOpId)
```

The phone holds its optimistic copy through a blip; on reconnect it rebases onto truth and
replays anything the server never acked. **A dropped socket is invisible to the singer.**

---

## 7. Pending-op bookkeeping (client)

```ts
// one small map is the entire optimistic engine
pending: Map<clientOpId, { op: QueueOp; inverse: QueueOp; sentAt: number }>

// clear when: matching broadcast (causedBy) arrives  → success
//             op:reject arrives                        → rollback via inverse
//             ack timeout (~5s) with no broadcast      → resend (idempotent) or resync
```

No global lock, no CRDT, no operational-transform engine. Client-minted ids + a server `rev` +
inverse-op rollback is the whole contract — small enough to get right, robust enough for a party.

---

## 8. What this buys
- Taps feel instant (Tier-1 perceived speed).
- Tiny payloads survive bad wifi (diffs, not full state).
- 20 phones converge to one truth without merge conflicts (server authority + rev).
- Reconnects self-heal silently (rebase + idempotent replay).
- Reject is a graceful, visible exception — never a hang.
