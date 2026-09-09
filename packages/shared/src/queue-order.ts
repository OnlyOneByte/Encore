// How the room decides who sings next — the ordering algorithm as a registry, not a hardcoded rule.
//
// THE MODEL (#856): the queue is a single STORED ordered list, and that list is the source of truth.
// It is persisted (`rotationSeq` is the durable position) and mutated in place — it is NOT recomputed
// from entry fields on every render. So an ordering "algorithm" is not a full sort any more. It is an
// INSERT-POSITION rule: given the current stored queue, at what index does one newly-added song go?
// After the insert the rule has no further authority over that song — a later drag rewrites the list
// directly and is durable by construction, because there is no re-derivation to fight.
//
// WHY THIS EXISTS. Round-robin fairness was the differentiator and it was also the only option:
// `rotate()` was called directly by the shared reducer, so a room that wanted strict queue order had
// nothing to turn. Fairness is a house rule, and different parties genuinely want different ones —
// a rotation for a living room, first-come-first-served for a bar with a sign-up sheet.
//
// A registry rather than a bare union, mirroring separators.ts and lyrics-engines.ts: a stored
// setting can be validated against it, the settings page renders its picker from one source, and a
// new algorithm cannot be added without a label and a stated consequence.
//
// EVERY INSERT RULE MUST BE PURE, TOTAL AND DETERMINISTIC. It runs on the phone (optimistic
// prediction) and on the server (authority), and the two are compared by nothing but the fact that
// they agree — an insert rule that reads a clock, a local random source, or anything not in its
// arguments makes the client's predicted index diverge from the server's, which is precisely the
// flicker the shared reducer exists to prevent. `ordering.lastSungAt` (sing history) and
// `ordering.shuffleSeed` (the shuffle seed) are how a rule gets state beyond the queue itself:
// server-owned, broadcast to clients, never derived locally.

import { makeRegistry } from './registry';
import type { QueueEntry } from './types';

export type QueueOrderId = 'fair' | 'fcfs' | 'shuffle' | 'least-recently-sung' | 'manual';

/**
 * Everything an ordering rule is allowed to read beyond the queue itself.
 *
 * One object threaded through `insertIndexFor` / `assignSeqs` / `applyAndReseq` rather than a growing
 * positional tail, so a future rule that needs another signal is one field here instead of a
 * signature change at every call site.
 */
export interface Ordering {
	/** Which algorithm. Absent = `DEFAULT_QUEUE_ORDER` (today's fair rotation). */
	order?: QueueOrderId;
	/**
	 * When each singer last STARTED a song, by singer id. A singer ABSENT from the map has not sung
	 * (which is not the same as `0`, and is why this is a map rather than a field on the entry).
	 *
	 * Server-owned and broadcast on the singer roster. A rule must never derive this locally: a
	 * phone that joined mid-party has no history of its own, so a locally-derived map would order the
	 * queue differently on every device.
	 */
	lastSungAt?: ReadonlyMap<string, number>;
	/**
	 * The room's shuffle seed. `shuffle` ranks a candidate by `hash32(seed + entry.id)`, so the seed
	 * is the only thing that varies the shuffle between rooms. Server-owned and broadcast like
	 * `lastSungAt`: a locally-rolled seed would put the same song at a different index on every device,
	 * the exact prediction divergence the shared reducer forbids. Absent = the empty seed (stable).
	 */
	shuffleSeed?: string;
}

/**
 * An ordering policy in the registry. The behaviour is `insertIndex`: where a NEW entry lands in the
 * current stored queue. The metadata fields drive the settings picker and the phone's list heading.
 */
export interface QueueOrderPolicy {
	id: QueueOrderId;
	label: string;
	/**
	 * Two or three words naming the order itself, for a heading like "Up next · in order". The phone
	 * used to say "rotation" unconditionally, which is a lie in three of these — worth a field rather
	 * than a call site, because a new algorithm must not be able to inherit someone else's noun.
	 */
	queueLabel: string;
	/** What it does to the room, in one line, in the phone's voice. */
	note: string;
	/** Whether this rule reads `Ordering.lastSungAt`, so a caller knows it has to supply it. */
	usesSingHistory: boolean;
	/** Whether this rule reads `Ordering.shuffleSeed`, so a caller knows it has to supply it. */
	usesShuffleSeed: boolean;
	/**
	 * Where a NEW entry lands: an index into `queued` (the current stored queued list, in stored
	 * order), in `[0, queued.length]`. `queued` does NOT include the entry being inserted. Pure,
	 * total, deterministic: reads only its arguments, so the phone and the server compute the same
	 * index. Never mutates its input.
	 */
	insertIndex: (queued: readonly QueueEntry[], entry: QueueEntry, ordering: Ordering) => number;
}

// ── the insert rules ──────────────────────────────────────────────────────────

/**
 * The fair round-robin slot for `entry` in the current stored `queued` list.
 *
 * Fair rotation is "everyone's Nth pick before anyone's (N+1)th". Adding a song is that singer taking
 * one more turn: it lands after the last song already in the SAME round as this new one. The new
 * song's round is how many queued picks that singer already has (0 → their first pick, joins round 0).
 * We walk the stored list counting each singer's running pick index, and drop the new entry AFTER the
 * last existing entry whose round is `<=` the new song's round. A brand-new singer's first pick joins
 * the current tail of round 0; a singer's second pick joins the tail of round 1; and so on. This is
 * the same interleave the old full sort produced for a from-scratch queue, computed as one insert
 * against whatever arrangement now exists rather than by re-sorting everything.
 */
function insertFair(queued: readonly QueueEntry[], entry: QueueEntry): number {
	const myRound = queued.filter((e) => e.singerId === entry.singerId).length;
	const seen = new Map<string, number>();
	let at = queued.length; // default: append (every existing entry is in an earlier round)
	for (let i = 0; i < queued.length; i++) {
		const r = seen.get(queued[i]!.singerId) ?? 0;
		seen.set(queued[i]!.singerId, r + 1);
		if (r > myRound) {
			at = i; // first entry in a LATER round — the new song goes just before it
			break;
		}
	}
	return at;
}

/** First come, first served: a new song always appends to the tail. */
function insertFcfs(queued: readonly QueueEntry[]): number {
	return queued.length;
}

/**
 * Deterministic shuffle: rank a candidate by `hash32(seed + id)` and insert so the queued list stays
 * sorted by that rank. Seeded (server-owned, broadcast) so the shuffle is stable within a room and
 * identical on phone and server; hashed rather than rolled so a song's rank is fixed for its life and
 * the same everywhere. Returns the first index whose entry outranks the new one — a binary-search-free
 * linear scan is fine for a party queue.
 */
function insertShuffle(queued: readonly QueueEntry[], entry: QueueEntry, ordering: Ordering): number {
	const seed = ordering.shuffleSeed ?? '';
	const mine = hash32(seed + entry.id);
	for (let i = 0; i < queued.length; i++) {
		const h = hash32(seed + queued[i]!.id);
		if (h > mine || (h === mine && entry.id < queued[i]!.id)) return i; // id breaks a hash collision
	}
	return queued.length;
}

/**
 * Fairness that counts songs already sung: rank singers by when they last STARTED a song (longest ago
 * first; never-sung before everyone). The new song lands after the last queued entry whose singer
 * ranks at or ahead of the new song's singer, so it takes the same rotation slot the full sort gave it.
 *
 * With no history it is EXACTLY `fair` for a fresh queue (every singer is unsung, so the rank ties and
 * the round tie-break carries the ordering), which is what makes it safe as a room default.
 */
function insertLeastRecentlySung(queued: readonly QueueEntry[], entry: QueueEntry, ordering: Ordering): number {
	const sung = ordering.lastSungAt;
	// -Infinity, not 0: an unsung singer must rank before every singer who has sung, and a room whose
	// clock is at 0 in a test must behave the same as one at Date.now().
	const rankOf = (singerId: string) => sung?.get(singerId) ?? -Infinity;
	const myRank = rankOf(entry.singerId);
	const myRound = queued.filter((e) => e.singerId === entry.singerId).length;
	const seen = new Map<string, number>();
	let at = queued.length;
	for (let i = 0; i < queued.length; i++) {
		const s = queued[i]!.singerId;
		const r = seen.get(s) ?? 0;
		seen.set(s, r + 1);
		// A later round always sorts after; within the same round, a strictly-better (smaller) rank
		// sorts before, so the new song goes ahead of the first same-or-later-round entry that ranks
		// no better than it.
		if (r > myRound || (r === myRound && rankOf(s) > myRank)) {
			at = i;
			break;
		}
	}
	return at;
}

/**
 * MANUAL: the room made no rule — a new song appends to the tail and stays wherever it is put.
 *
 * With the stored-list model every policy is "manual" for anything already in the queue (the list is
 * the truth). Manual is the policy that ALSO has no insert rule: it just appends. It is kept as a
 * distinct, selectable policy so a room can say "do not interleave my adds at all", which is a
 * different promise from fcfs only in name today but is the honest label for the stored-list model.
 */
function insertManual(queued: readonly QueueEntry[]): number {
	return queued.length;
}

/** FNV-1a, 32-bit. Small, dependency-free, and identical on both sides — all this needs to be. */
function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

const QUEUE_ORDER_POLICIES = [
	{
		id: 'fair',
		label: 'Fair rotation',
		queueLabel: 'rotation',
		note: "Everyone's first pick before anyone's second. New joiners slot into the next gap.",
		usesSingHistory: false,
		usesShuffleSeed: false,
		insertIndex: (queued, entry) => insertFair(queued, entry)
	},
	{
		id: 'fcfs',
		label: 'First come, first served',
		queueLabel: 'in order',
		note: 'Strict queue order. Queue three songs and you sing three in a row.',
		usesSingHistory: false,
		usesShuffleSeed: false,
		insertIndex: (queued) => insertFcfs(queued)
	},
	{
		id: 'shuffle',
		label: 'Shuffle',
		queueLabel: 'shuffled',
		note: 'Random order, fixed once a song is in.',
		usesSingHistory: false,
		usesShuffleSeed: true,
		insertIndex: (queued, entry, ordering) => insertShuffle(queued, entry, ordering)
	},
	{
		id: 'least-recently-sung',
		label: 'Whoever sang longest ago',
		queueLabel: 'longest ago first',
		note: 'Rotation that counts songs already sung. Anyone yet to sing goes first.',
		usesSingHistory: true,
		usesShuffleSeed: false,
		insertIndex: (queued, entry, ordering) => insertLeastRecentlySung(queued, entry, ordering)
	},
	{
		id: 'manual',
		label: 'Manual order',
		queueLabel: 'custom order',
		note: 'New songs go to the end. Nothing moves on its own — drag songs where you want them.',
		usesSingHistory: false,
		usesShuffleSeed: false,
		insertIndex: (queued) => insertManual(queued)
	}
] as const satisfies readonly QueueOrderPolicy[];

// One accessor + one guard from the shared registry helper, so this cannot drift into the
// guard-but-no-accessor shape a review already flagged across the other eleven registries.
const queueOrderRegistry = makeRegistry(QUEUE_ORDER_POLICIES);

/** The policies, in the order the settings picker should offer them. */
export const QUEUE_ORDERS: readonly QueueOrderPolicy[] = queueOrderRegistry.all;

/** Today's behaviour. Changing this changes what an un-configured room does — don't. */
export const DEFAULT_QUEUE_ORDER: QueueOrderId = 'fair';

export function getQueueOrder(id: string | null | undefined): QueueOrderPolicy | undefined {
	return typeof id === 'string' ? queueOrderRegistry.get(id) : undefined;
}

export function isQueueOrder(v: unknown): v is QueueOrderId {
	return queueOrderRegistry.isValid(v);
}

/**
 * The insert index for a NEW entry under the room's policy. An unknown or absent id falls back to the
 * default rather than throwing — a de-whitelisted setting must degrade to a running party. `queued`
 * is the current stored queued list in stored order and does NOT include `entry`.
 */
export function insertIndexFor(
	queued: readonly QueueEntry[],
	entry: QueueEntry,
	ordering: Ordering = {}
): number {
	const policy = getQueueOrder(ordering.order) ?? getQueueOrder(DEFAULT_QUEUE_ORDER)!;
	const at = policy.insertIndex(queued, entry, ordering);
	return Math.max(0, Math.min(at, queued.length)); // total: clamp a rule that returned out of range
}

/** The order's own name, for a heading. Falls back to the default policy's, never to a bare id. */
export function queueOrderLabel(order: QueueOrderId | null | undefined): string {
	return (getQueueOrder(order) ?? getQueueOrder(DEFAULT_QUEUE_ORDER)!).queueLabel;
}

/**
 * Build the sing-history map from a singer roster, on EITHER side of the wire.
 *
 * Shared so the phone and the server construct the identical map from the identical records: this is
 * the same "contract made physical" reason `applyAndReseq` is shared. A singer with no stamp is
 * omitted rather than zeroed, because absent means never sung.
 */
export function singHistoryFrom(
	singers: Iterable<{ id: string; lastSungAt?: number | null }>
): ReadonlyMap<string, number> {
	const map = new Map<string, number>();
	for (const s of singers) {
		if (typeof s.lastSungAt === 'number' && Number.isFinite(s.lastSungAt)) map.set(s.id, s.lastSungAt);
	}
	return map;
}
