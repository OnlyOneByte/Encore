# Queue order as a room setting

**Status: BUILT.** Four algorithms ship — fair rotation (default, unchanged behaviour), first come
first served, stable shuffle, whoever sang longest ago. What follows is the design as built; the
staging table at the end records what each stage verified.

Make the ordering algorithm a **room** choice instead of a hardcoded one. Default stays exactly
today's behaviour; a room can pick pure first-come-first-served instead, and a fifth algorithm is a
registry edit plus one pure function.

Branch `feat/queue-order-room-setting`, worktree `/local/home/angryang/.kiro/crew/workspace/encore-queue-order`, cut from `main` at `ba9e160`.

## First, a terminology correction

Today's algorithm **is** round-robin. `rotate()` in `packages/shared/src/rotation.ts` interleaves
each singer's picks by pick index — "everyone's Nth before anyone's (N+1)th" — and breaks ties by
`addedAt`. So "fair" and "round-robin" are the same option, not two. The genuine third axis is
whether ordering accounts for songs **already sung** (see [Future slots](#future-slots)).

## What already exists (and what that buys us)

| Piece | Where | Status |
|---|---|---|
| Pure ordering function | `packages/shared/src/rotation.ts` → `rotate` / `assignSeqs` | exists, no policy param |
| Shared reducer run on BOTH sides | `applyAndReseq(entries, op)` | exists — client and server call the same function |
| Room settings layer | `separators.ts` `RoomSettings` + `normalizeRoomSettings` | exists, 11 fields |
| Room settings persistence | `room_settings` table + `SettingsRepository.getRoom/setRoom` | exists |
| Settings transport | `settings:changed` broadcast + `settings` on `queue:sync` | exists |
| Settings UI | `/settings` page, "This room" section | exists |

So the transport, the persistence and the picker pattern are all precedent. The work is threading
one policy id through the reducer **on both sides** and reseq'ing the live queue when it changes.

## The one hard part: the client predicts the order

`applyAndReseq` is deliberately the same function on the client optimistic store
(`apps/core/src/lib/stores/queue.ts:108`) and the authoritative server
(`apps/core/src/server/state/store.ts:52`). That is what makes an add land at its real position in
the same frame with no jump-and-resort flicker. If the policy lives only on the server, every
optimistic add under FCFS renders in round-robin position and then snaps — the exact defect the
shared reducer exists to prevent.

Therefore the phone must know the room's `queueOrder`. It already receives it: `queue:sync` carries
`settings`, and `settings:changed` carries a full snapshot. The phone page just doesn't read them
today (only `/tv` and `/settings` do). So:

- `QueueStoreDeps` gains `queueOrder?: () => QueueOrderId` — a **getter**, not a value, so a
  mid-party change is picked up without re-wiring the store.
- The phone page holds `settings` like `/tv` does (seed from `queue:sync`, update on
  `settings:changed`) and passes `() => settings.room.queueOrder`.

A client whose settings snapshot is stale predicts the old order for one op and then adopts the
server's snapshot from the patch. Self-healing, and no worse than any other stale-settings window.

## Design

### 1. Registry, in its own module

New `packages/shared/src/queue-order.ts`, mirroring `separators.ts` / `lyrics-engines.ts`: a
registry, not a bare union, so a stored value can be validated against it, the settings page renders
the picker from one source, and a new algorithm cannot be added without a label and a stated
consequence.

```ts
export type QueueOrderId = 'fair' | 'fcfs' | 'shuffle' | 'least-recently-sung';

/** Everything a policy may read beyond the entries. One object, so a future signal is a field. */
export interface Ordering {
	order?: QueueOrderId;                        // absent = DEFAULT_QUEUE_ORDER
	lastSungAt?: ReadonlyMap<string, number>;    // absent from the map = has not sung
}

export interface QueueOrderPolicy {
	id: QueueOrderId;
	label: string;
	queueLabel: string;        // the order's own noun, for "Up next · in order"
	note: string;              // what it does to the room, in the phone's voice
	respectsAddedAt: boolean;  // false for shuffle → the phone hides the reorder arrows
	usesSingHistory: boolean;  // true for least-recently-sung → a caller must supply lastSungAt
	order: (entries: QueueEntry[], ordering: Ordering) => QueueEntry[];
}

export const DEFAULT_QUEUE_ORDER: QueueOrderId = 'fair';
export function isQueueOrder(v: unknown): v is QueueOrderId;
export function orderQueue(entries: QueueEntry[], ordering?: Ordering): QueueEntry[];
export function queueOrderLabel(order: QueueOrderId | null | undefined): string;
export function reorderIsMeaningful(order: QueueOrderId | null | undefined): boolean;
export function singHistoryFrom(singers: Iterable<{ id: string; lastSungAt?: number | null }>): ReadonlyMap<string, number>;
```

`shuffle` ranks by a 32-bit FNV-1a hash of the entry id, NOT by a random draw: the rank has to be
stable (a re-randomising order reshuffles the whole queue on every add) and identical on both sides
of the wire (a policy that reads a clock or a random source diverges immediately).

`least-recently-sung` reuses the same interleave as `fair` and only changes what ranks the singers —
their `lastSungAt` instead of their first pick's `addedAt`, with unsung singers at `-Infinity` so
they go first, and the addedAt as the tie-break. With no history it is therefore EXACTLY fair, which
is what makes it safe and easy to reason about at the start of a party.

`singHistoryFrom` is shared so the phone and the server build the identical map from the identical
records — the same reason `applyAndReseq` itself is shared.

Direction of dependency: `rotation.ts` imports `queue-order.ts`, never the reverse (same rule the
lyrics registries follow). `rotate()` stays exported from `rotation.ts` as `orderQueue(e, 'fair')`
so existing tests and call sites are untouched.

`byAddedAt` is one line — `[...entries].sort((a, b) => a.addedAt - b.addedAt)` — and correct because
the client already mints a **monotonic** `addedAt` (`queue.ts:#nextAddedAt`), so two adds in the same
millisecond cannot tie.

### 2. Thread the policy as an optional trailing parameter

Every signature gains an optional `order` defaulting to `DEFAULT_QUEUE_ORDER`, so today's behaviour
is literally the default and no existing call site or test changes:

- shared: `assignSeqs(entries, ordering?)`, `applyAndReseq(entries, op, ordering?)`
- server: `reseq(entries, ordering?)`, `nextPlayable(entries, mediaById, ordering?)`,
  `upNextAfter(currentId, entries, mediaById, ordering?)`
- `AuthoritativeState` takes an injected `orderingOf: () => Ordering` (default `() => ({})`) used by
  `hydrate`, `applyQueueOp` and `reorder`. A **getter** for the same reason as on the client: the
  algorithm can change mid-party, and the sing history changes every time a song starts.
- `app.ts` moves `new SettingsRepository(db)` above the state construction (it only needs `db`) and
  passes `() => ({ order: settings.getRoom().queueOrder, lastSungAt: singHistoryFrom(singers.listPublic()) })`.
- `player.ts` and `server.ts` read it through **one** helper, `orderingOf(deps)` in `realtime/hub.ts`,
  assembled from deps that already exist (`getSettings` + `listSingers`). One place, because a second
  source is how the server comes to pick a different "next" than the queue the clients see.
- `player.ts` gains `beginSinging(deps, entry)`: flip to `playing` → `onSang(singerId)` →
  `state.reorder()`, in that order, because under `least-recently-sung` the stamp is an INPUT to the
  ordering. Used by all three places a song becomes current (advance, the `play` command, and
  `reconcileOnReady` when a cook finishes into an idle room).

### 3. The `move` op needs no change — and that is load-bearing

`move` is already policy-agnostic because it operates in the `addedAt` domain, not the seq domain:
`reorderWithinSinger` permutes the moving singer's own `addedAt` stamps, and the phone passes an
index **within that singer's own picks** (`+page.svelte:386`). Under FCFS those stamps are a subset
of the global order, so a drag still reorders your own songs within the slots you already hold and
still cannot jump you past another singer. Test this explicitly under both policies — it is the one
property that would silently turn drag-reorder into queue-jumping.

### 4. Persistence

`RoomSettings.queueOrder: QueueOrderId`, `DEFAULT_ROOM_SETTINGS.queueOrder = 'fair'`, one branch in
`normalizeRoomSettings` (`isQueueOrder(input) ? input : d.queueOrder` — reject-to-current, like
`tvProgressStyle`), and `Singer.lastSungAt?: number | null`.

Both columns are **folded into the single pre-release baseline**, `apps/core/drizzle/0000_baseline.sql`
— not added by a follow-on migration.

This changed mid-flight and it is worth saying why. The feature was built while main still carried
thirteen incremental migrations, so it originally shipped its own numbered one. Main then collapsed the
chain to one baseline on the grounds that no production database exists yet, and the same reasoning
applies here: a second migration would be history nobody will ever replay. Regenerating is a
`drizzle-kit generate` after deleting `0000_baseline.sql` + `meta/`, then restoring the file's
provenance header by hand — the header is what tells the next person to STOP doing this once the schema
ships to a real box. A test asserts the journal holds exactly one entry and that the baseline contains
both columns with the header intact, so nobody re-adds the chain by accident.

The cost, which the baseline's own header states: an older dev database records migration hashes that no
longer exist and cannot be migrated forward. Delete it and let the library rebuild from the meta/
sidecars, which are authoritative.

`last_sung_at` is nullable on purpose: NULL means "has not sung", which is NOT the same as 0 — an
unsung singer sorts ahead of everyone who has sung. It lives on the singer rather than in `plays`
because that table deliberately carries no `singer_id` (over a small library "who sang what" is
identifying). A bare timestamp records THAT someone sang and when, never what, and that is the least
the rotation can know and still be fair. A test asserts the singer row holds no media or entry id.

### 5. Changing it mid-party must reseq the live queue

This is the piece with no precedent. Today `PUT /api/settings/room` persists and broadcasts
`settings:changed` — nothing else. For every other room setting that is enough, because they are
render-time choices. `queueOrder` is different: `rotationSeq` is **stored** on each entry and
re-derived only on a mutation, so flipping the setting would leave the TV and every phone showing
the old order until someone happened to add or remove a song.

So the room PUT handler, when `queueOrder` actually changed:

1. `app.state.reorder()` — a new `AuthoritativeState` method that re-runs `assignSeqs` with the
   current policy, bumps `rev`, schedules the write-behind flush, and returns the snapshot.
2. Publish `queue:patch` with `{ ops: [], entries, media }` — the same shape `player.ts`'s
   `publishQueue` sends, which clients already adopt and re-apply pending ops onto.
3. Publish `settings:changed` as it does today.

Only when it changed: republishing an unchanged snapshot makes every client re-adopt state for
nothing.

**What it does not touch:** the song currently playing. `currentEntryId` points at a `playing` entry
and ordering only ranks `queued` ones, so a mid-song flip changes who is *next*, never who is
singing. Worth saying out loud on the settings page.

### 6. Picker, and two things eyes-on caught

One `<select>` at the top of the "This room" section of `/settings`, rendered from `QUEUE_ORDERS`,
with the selected policy's `note` under it as the consequence line — same shape as the TV-progress
and lyrics pickers — plus a line stating that a change re-orders the pending queue immediately and
does not interrupt the current song.

> The eyes-on frames this section embedded (`settings-queue-order`, `queue-order-fair`,
> `queue-order-shuffle`) were retired with the rest of the per-milestone frames — see
> [`docs/mocks/README.md`](../../mocks/README.md). The picker they showed is in
> `tour-settings-room-eyeson.png` in the current set.

Driving it found two defects a green suite could not see, both now fixed and test-pinned:

1. **The phone's list heading said "Up next · rotation" unconditionally**, which is a lie in three of
   the four orderings. The noun now comes from the policy (`queueLabel`), so a new algorithm cannot
   inherit a previous one's word. The collapsed sheet hint's "N in the rotation" became "N waiting",
   which is true under every ordering and needs no prop.
2. **The reorder arrows were still offered under `shuffle`**, where a move is a legal no-op — a
   control that silently does nothing. `respectsAddedAt` now hides them.

| Fair rotation (default) | Shuffle |
|---|---|
| _(frame retired)_ | _(frame retired)_ |

Both frames are the SAME already-open phone: the room was flipped from a second tab and the queue
re-ordered live, with no reload — the `queue:patch` from the settings PUT. Note "You're #2 · after
Cam" updating, the heading changing from ROTATION to SHUFFLED, and the arrows disappearing.

## Staging

| Stage | Content | Verified by |
|---|---|---|
| S1 | `queue-order.ts` registry + `RoomSettings.queueOrder` + normalizer + `Ordering` param on `assignSeqs`/`applyAndReseq`/server rotation | `queue-order.test.ts` — fair pinned unchanged, fcfs/shuffle/LRS behaviour, purity + totality per policy, and the drag-reorder property asserted **for every registered policy** |
| S2 | Both columns folded into the single baseline + `SettingsRepository` + `Singer.lastSungAt` | `settings-repository.test.ts` — round-trip, reject-to-current, and one entry in the journal with both columns and the provenance header present in the baseline SQL |
| S3 | Server wiring: `orderingOf`, `AuthoritativeState.orderingOf` + `reorder()`, `beginSinging`, `app.ts` construction order | `queue-order-wiring.test.ts` against a real SQLite + the real repositories |
| S4 | Room PUT reseq + `queue:patch` broadcast on change only | covered by `reorder()` returning null when unchanged; eyes-on for the live path |
| S5 | Client: phone holds `settings`, `QueueStoreDeps.ordering`, optimistic add lands in the room's position | `queue-ordering.test.ts` — fair vs fcfs vs LRS placement, apply-time read, and the resync rebase path |
| S6 | `/settings` picker + docs + eyes-on | three frames in `docs/mocks/`; two defects found and fixed (§6) |

822 tests pass, `bun run typecheck` and `bun run check` both 0 errors.

## Future slots

A fifth algorithm is a registry entry plus one pure function — provided it needs nothing but the
queued entries and `Ordering`. If it needs a NEW signal, that signal has to reach the client the way
`lastSungAt` does (server-owned, on a record the phone already receives), never be derived locally: a
phone that joined mid-party has no history of its own, so a locally-derived signal orders the queue
differently on every device.

Deliberately NOT built, with the reason:

- **Ordering that knows who is away.** `least-recently-sung` asks when someone last sang, which is a
  different question from whether they are in the room. Presence has its own lifecycle contract and
  an away/skip interaction belongs there, not smuggled into an ordering.
- **Anything needing per-singer song history.** The stamp is a bare timestamp on purpose. A policy
  that wants "has this singer sung this song" needs the `plays`-has-no-singer-id decision revisited
  first — that is a privacy call, not an implementation detail to work around.
