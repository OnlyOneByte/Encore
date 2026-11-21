// How the room decides who sings next, as a registry rather than a hardcoded rule. An ordering algorithm is an
// INSERT-POSITION rule and not a sort, and every rule must be PURE, TOTAL and DETERMINISTIC because the same
// one runs on the phone to predict and on the server to commit. See docs/SERVER.md#queue-ordering-and-rotation.

import { makeRegistry } from '../core/registry';
import type { QueueEntry } from '../core/types';

export type QueueOrderId = 'fair' | 'fcfs' | 'shuffle' | 'least-recently-sung' | 'manual';

/** Everything an ordering rule may read beyond the queue. ONE object threaded through the call chain, so a
 *  future signal is one field here rather than a signature change everywhere. */
export interface Ordering {
	/** Which algorithm. Absent = `DEFAULT_QUEUE_ORDER`. */
	order?: QueueOrderId;
	/** When each singer last STARTED a song; ABSENT means never sung, which is not `0`. SERVER-OWNED and
	 *  broadcast — never derive it locally. See docs/SERVER.md#queue-ordering-and-rotation. */
	lastSungAt?: ReadonlyMap<string, number>;
	/** The room's shuffle seed, the only thing that varies the shuffle between rooms. SERVER-OWNED: a locally
	 *  rolled seed puts the same song at a different index on every device. */
	shuffleSeed?: string;
	/** The entry the On deck hold protects (`heldEntryId`), or absent. A new entry lands no higher than just after it,
	 *  under every policy, so an add cannot take On deck either (proposal 14). */
	heldId?: string | null;
}

/**
 * An ordering policy in the registry. The behaviour is `insertIndex`: where a NEW entry lands in the
 * current stored queue. The metadata fields drive the settings picker and the phone's list heading.
 */
export interface QueueOrderPolicy {
	id: QueueOrderId;
	label: string;
	/** Two or three words naming the order itself. A FIELD rather than a call-site string, so a new algorithm
	 *  cannot inherit another's noun. */
	queueLabel: string;
	/** What it does to the room, in one line, in the phone's voice. */
	note: string;
	/** Whether this rule reads `Ordering.lastSungAt`, so a caller knows it has to supply it. */
	usesSingHistory: boolean;
	/** Whether this rule reads `Ordering.shuffleSeed`, so a caller knows it has to supply it. */
	usesShuffleSeed: boolean;
	/** Where a NEW entry lands: an index into the stored queued list, which does NOT include the entry being
	 *  inserted. Pure, total, deterministic, and never mutates its input. */
	insertIndex: (queued: readonly QueueEntry[], entry: QueueEntry, ordering: Ordering) => number;
}

/** The fair round-robin slot: "everyone's Nth pick before anyone's (N+1)th". The new song's ROUND is how many
 *  queued picks its singer already has, so it lands after the last entry at or below that round. */
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

/** Deterministic shuffle: rank by `hash32(seed + id)`. HASHED rather than rolled, so a song's rank is fixed for
 *  its life and identical on every device. */
function insertShuffle(queued: readonly QueueEntry[], entry: QueueEntry, ordering: Ordering): number {
	const seed = ordering.shuffleSeed ?? '';
	const mine = hash32(seed + entry.id);
	for (let i = 0; i < queued.length; i++) {
		const h = hash32(seed + queued[i]!.id);
		if (h > mine || (h === mine && entry.id < queued[i]!.id)) return i; // id breaks a hash collision
	}
	return queued.length;
}

/** Fairness that counts songs already sung, never-sung ahead of everyone. With NO history it is exactly `fair`,
 *  which is what makes it safe to select mid-party. */
function insertLeastRecentlySung(queued: readonly QueueEntry[], entry: QueueEntry, ordering: Ordering): number {
	const sung = ordering.lastSungAt;
	// -Infinity and NOT 0: an unsung singer ranks before everyone, at any clock value.
	const rankOf = (singerId: string) => sung?.get(singerId) ?? -Infinity;
	const myRank = rankOf(entry.singerId);
	const myRound = queued.filter((e) => e.singerId === entry.singerId).length;
	const seen = new Map<string, number>();
	let at = queued.length;
	for (let i = 0; i < queued.length; i++) {
		const s = queued[i]!.singerId;
		const r = seen.get(s) ?? 0;
		seen.set(s, r + 1);
		// A later round always sorts after; within a round, a smaller rank sorts before.
		if (r > myRound || (r === myRound && rankOf(s) > myRank)) {
			at = i;
			break;
		}
	}
	return at;
}

/** MANUAL: no insert rule at all. Under the stored-list model every policy is already manual for anything IN
 *  the queue, so this is the honest label for "do not interleave my adds". */
function insertManual(queued: readonly QueueEntry[]): number {
	return queued.length;
}

/** FNV-1a, 32-bit. Dependency-free and identical on both sides, which is all it has to be. */
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
		insertIndex: insertFair
	},
	{
		id: 'fcfs',
		label: 'First come, first served',
		queueLabel: 'in order',
		note: 'Strict queue order. Queue three songs and you sing three in a row.',
		usesSingHistory: false,
		usesShuffleSeed: false,
		insertIndex: insertFcfs
	},
	{
		id: 'shuffle',
		label: 'Shuffle',
		queueLabel: 'shuffled',
		note: 'Random order, fixed once a song is in.',
		usesSingHistory: false,
		usesShuffleSeed: true,
		insertIndex: insertShuffle
	},
	{
		id: 'least-recently-sung',
		label: 'Whoever sang longest ago',
		queueLabel: 'longest ago first',
		note: 'Rotation that counts songs already sung. Anyone yet to sing goes first.',
		usesSingHistory: true,
		usesShuffleSeed: false,
		insertIndex: insertLeastRecentlySung
	},
	{
		id: 'manual',
		label: 'Manual order',
		queueLabel: 'custom order',
		note: 'New songs go to the end. Nothing moves on its own — drag songs where you want them.',
		usesSingHistory: false,
		usesShuffleSeed: false,
		insertIndex: insertManual
	}
] as const satisfies readonly QueueOrderPolicy[];

const queueOrderRegistry = makeRegistry(QUEUE_ORDER_POLICIES);

/** The policies, in the order the settings picker should offer them. */
export const QUEUE_ORDERS: readonly QueueOrderPolicy[] = queueOrderRegistry.all;

/** What an un-configured room does. Changing this re-orders every existing room that never chose. */
export const DEFAULT_QUEUE_ORDER: QueueOrderId = 'fair';

export function getQueueOrder(id: string | null | undefined): QueueOrderPolicy | undefined {
	return typeof id === 'string' ? queueOrderRegistry.get(id) : undefined;
}

export function isQueueOrder(v: unknown): v is QueueOrderId {
	return queueOrderRegistry.isValid(v);
}

/** The insert index for a NEW entry under the room's policy. An unknown id falls back to the default rather
 *  than throwing, and the result is clamped so the rule stays total. */
export function insertIndexFor(queued: readonly QueueEntry[], entry: QueueEntry, ordering: Ordering = {}): number {
	const policy = getQueueOrder(ordering.order) ?? getQueueOrder(DEFAULT_QUEUE_ORDER)!;
	const at = policy.insertIndex(queued, entry, ordering);
	return Math.max(0, Math.min(at, queued.length)); // total: clamp a rule that returned out of range
}

/** The order's own name, for a heading. Falls back to the default policy's, never to a bare id. */
export function queueOrderLabel(order: QueueOrderId | null | undefined): string {
	return (getQueueOrder(order) ?? getQueueOrder(DEFAULT_QUEUE_ORDER)!).queueLabel;
}

/** Build the sing-history map, on EITHER side of the wire, so phone and server construct the identical map. A
 *  singer with no stamp is OMITTED rather than zeroed. */
export function singHistoryFrom(
	singers: Iterable<{ id: string; lastSungAt?: number | null }>
): ReadonlyMap<string, number> {
	const map = new Map<string, number>();
	for (const s of singers) {
		if (typeof s.lastSungAt === 'number' && Number.isFinite(s.lastSungAt)) map.set(s.id, s.lastSungAt);
	}
	return map;
}
