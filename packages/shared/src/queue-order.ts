// How the room decides who sings next — the ordering algorithm as a registry, not a hardcoded rule.
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
// EVERY POLICY MUST BE PURE, TOTAL AND DETERMINISTIC. These functions run on the phone (optimistic
// prediction) and on the server (authority) and their outputs are compared by nothing but the fact
// that they agree — an ordering that reads a clock, a random source, or anything not in its
// arguments makes the client's prediction diverge from the server's commit, which is precisely the
// flicker the shared reducer exists to prevent. `ordering.lastSungAt` is how a policy gets state
// beyond the entries themselves: server-owned, broadcast to clients, never derived locally.

import { makeRegistry } from './registry';
import type { QueueEntry } from './types';

export type QueueOrderId = 'fair' | 'fcfs' | 'shuffle' | 'least-recently-sung';

/**
 * Everything an ordering policy is allowed to read beyond the entries themselves.
 *
 * One object threaded through `orderQueue` / `assignSeqs` / `applyAndReseq` rather than a growing
 * positional tail, so a future policy that needs another signal is one field here instead of a
 * signature change at every call site.
 */
export interface Ordering {
	/** Which algorithm. Absent = `DEFAULT_QUEUE_ORDER` (today's fair rotation). */
	order?: QueueOrderId;
	/**
	 * When each singer last STARTED a song, by singer id. A singer ABSENT from the map has not sung
	 * (which is not the same as `0`, and is why this is a map rather than a field on the entry).
	 *
	 * Server-owned and broadcast on the singer roster. A policy must never derive this locally: a
	 * phone that joined mid-party has no history of its own, so a locally-derived map would order the
	 * queue differently on every device.
	 */
	lastSungAt?: ReadonlyMap<string, number>;
}

export interface QueueOrderPolicy {
	id: QueueOrderId;
	label: string;
	/**
	 * Two or three words naming the order itself, for a heading like "Up next · in order". The phone
	 * used to say "rotation" unconditionally, which is a lie in three of these four — worth a field
	 * rather than a call site, because a new algorithm must not be able to inherit someone else's noun.
	 */
	queueLabel: string;
	/** What it does to the room, in one line, in the phone's voice. */
	note: string;
	/**
	 * Whether a singer reordering their own picks can change anything under this policy. False for
	 * `shuffle`, whose rank comes from the entry id — the phone hides the reorder arrows rather than
	 * offering a control that silently does nothing.
	 */
	respectsAddedAt: boolean;
	/** Whether the policy reads `Ordering.lastSungAt`, so a caller knows it has to supply it. */
	usesSingHistory: boolean;
	/** Pure, total, deterministic: queued entries in, ordered out. Never mutates its input. */
	order: (entries: QueueEntry[], ordering: Ordering) => QueueEntry[];
}

// ── the policies ────────────────────────────────────────────────────────────

/** Group entries by singer, each singer's picks in addedAt order. Insertion order = first appearance. */
function bySinger(entries: QueueEntry[]): Map<string, QueueEntry[]> {
	const map = new Map<string, QueueEntry[]>();
	for (const e of [...entries].sort((a, b) => a.addedAt - b.addedAt)) {
		const arr = map.get(e.singerId) ?? [];
		arr.push(e);
		map.set(e.singerId, arr);
	}
	return map;
}

/**
 * Interleave each singer's picks by pick index — everyone's Nth before anyone's (N+1)th.
 * `rank` decides the order singers take within a round; ties fall back to their first pick's
 * addedAt, so the whole ordering stays total even when the rank is a constant.
 */
function interleave(entries: QueueEntry[], rank: (singerId: string, firstAddedAt: number) => number): QueueEntry[] {
	const picks = bySinger(entries);
	// every key was created by pushing an entry, so [0] always exists
	const singers = [...picks.keys()].sort((a, b) => {
		const fa = picks.get(a)![0]!.addedAt;
		const fb = picks.get(b)![0]!.addedAt;
		return rank(a, fa) - rank(b, fb) || fa - fb;
	});

	const out: QueueEntry[] = [];
	let round = 0;
	let added = true;
	while (added) {
		added = false;
		for (const s of singers) {
			const mine = picks.get(s)!;
			if (round < mine.length) {
				out.push(mine[round]!); // bounds-checked by the line above
				added = true;
			}
		}
		round++;
	}
	return out;
}

/** Fair rotation: singers take their turn in order of first appearance. */
function orderFair(entries: QueueEntry[]): QueueEntry[] {
	return interleave(entries, (_id, firstAddedAt) => firstAddedAt);
}

/** Strict queue order. One line, and correct because the client mints addedAt monotonically. */
function orderFcfs(entries: QueueEntry[]): QueueEntry[] {
	return [...entries].sort((a, b) => a.addedAt - b.addedAt);
}

/**
 * Deterministic shuffle: rank by a hash of the entry id.
 *
 * Hashed rather than randomised because the order has to be STABLE. A policy that drew fresh random
 * numbers would reshuffle the whole queue on every add and would not agree between the phone and the
 * server for even one frame. Hashing an id the client minted gives a rank that is fixed for the life
 * of the entry and identical everywhere.
 */
function orderShuffle(entries: QueueEntry[]): QueueEntry[] {
	return [...entries]
		.map((e) => ({ e, h: hash32(e.id) }))
		.sort((a, b) => a.h - b.h || (a.e.id < b.e.id ? -1 : 1)) // id breaks a hash collision
		.map(({ e }) => e);
}

/**
 * Fairness that counts songs already sung: the singer who sang longest ago goes first, and anyone
 * who has not sung at all goes before anyone who has.
 *
 * This is the difference between it and `fair`. Fair ranks singers by when they first queued, so a
 * singer who has already had three turns and requeues sits in the same round as someone still
 * waiting for their first. Rotating on sing history instead is what most people mean by "fair" once
 * a party has been running for an hour.
 *
 * With no history it is EXACTLY `fair` (every singer is unsung, so the tie-break carries the whole
 * ordering), which is what makes it safe as a room default and trivial to reason about at the start
 * of a party.
 */
function orderLeastRecentlySung(entries: QueueEntry[], ordering: Ordering): QueueEntry[] {
	const sung = ordering.lastSungAt;
	// -Infinity, not 0: an unsung singer must sort before every singer who has sung, and a room whose
	// clock is at 0 in a test must behave the same as one at Date.now().
	return interleave(entries, (id) => sung?.get(id) ?? -Infinity);
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
		respectsAddedAt: true,
		usesSingHistory: false,
		order: orderFair
	},
	{
		id: 'fcfs',
		label: 'First come, first served',
		queueLabel: 'in order',
		note: 'Strict queue order. Queue three songs and you sing three in a row.',
		respectsAddedAt: true,
		usesSingHistory: false,
		order: orderFcfs
	},
	{
		id: 'shuffle',
		label: 'Shuffle',
		queueLabel: 'shuffled',
		note: 'Random order, fixed once a song is in. Reordering your own picks does nothing here.',
		respectsAddedAt: false,
		usesSingHistory: false,
		order: orderShuffle
	},
	{
		id: 'least-recently-sung',
		label: 'Whoever sang longest ago',
		queueLabel: 'longest ago first',
		note: 'Rotation that counts songs already sung. Anyone yet to sing goes first.',
		respectsAddedAt: true,
		usesSingHistory: true,
		order: orderLeastRecentlySung
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
 * THE entry point: queued entries in the room's chosen order. An unknown or absent id falls back to
 * the default rather than throwing — a de-whitelisted setting must degrade to a running party.
 */
export function orderQueue(entries: QueueEntry[], ordering: Ordering = {}): QueueEntry[] {
	const policy = getQueueOrder(ordering.order) ?? getQueueOrder(DEFAULT_QUEUE_ORDER)!;
	return policy.order(entries, ordering);
}

/** The order's own name, for a heading. Falls back to the default policy's, never to a bare id. */
export function queueOrderLabel(order: QueueOrderId | null | undefined): string {
	return (getQueueOrder(order) ?? getQueueOrder(DEFAULT_QUEUE_ORDER)!).queueLabel;
}

/** Whether the room's policy makes a singer's own reorder meaningful (drives the phone's arrows). */
export function reorderIsMeaningful(order: QueueOrderId | null | undefined): boolean {
	return getQueueOrder(order)?.respectsAddedAt ?? true;
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
