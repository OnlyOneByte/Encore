// The room's ordering algorithm, end to end on the server side: it reaches the authoritative state,
// it survives persistence, changing it re-derives the live queue, and the sing-history stamp lands
// BEFORE the reseq that reads it.
import { test, expect } from 'bun:test';
import { migratedDb } from '../db/test-db';
import { SettingsRepository } from '../state/settings-repository';
import { SingerRepository } from '../singers/repository';
import { AuthoritativeState } from '../state/store';
import { handlePlayerCommand } from './player';
import { orderingOf, type HubDeps } from './hub';
import {
	singHistoryFrom,
	type Media,
	type QueueEntry,
	type QueueOrderId,
	type ServerEvent,
	EMPTY_SONG_PROFILE
} from '@encore/shared';

const media = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.flac`,
	songProfile: EMPTY_SONG_PROFILE
});

const entry = (id: string, singerId: string, addedAt: number, mediaId = 'm1'): QueueEntry => ({
	id,
	mediaId,
	singerId,
	status: 'queued',
	rotationSeq: -1,
	addedAt
});

// #656: singers are room-scoped; this wiring test exercises a single room, FK not enforced.
const ROOM = 'test-room';

/** A real DB + the same wiring app.ts builds, so this exercises the actual seam, not a mock of it. */
function harness(order: QueueOrderId = 'fair') {
	const db = migratedDb();
	const settings = new SettingsRepository(db);
	const singers = new SingerRepository(db);
	settings.setRoom({ queueOrder: order }, 'main');

	const state = new AuthoritativeState(undefined, 250, () => ({
		order: settings.getRoom('main').queueOrder,
		lastSungAt: singHistoryFrom(singers.listPublic(ROOM))
	}));
	const published: ServerEvent[] = [];
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([
			['m1', media('m1')],
			['m2', media('m2')]
		]),
		listSingers: () => singers.listPublic(ROOM),
		getSettings: () => settings.getEffective('main'),
		onSang: (singerId) => singers.markSang(singerId, ++clock)
	};
	let clock = 1000;
	return { db, settings, singers, state, deps, published, tick: () => ++clock };
}

const ids = (entries: QueueEntry[]) => entries.map((e) => e.id);

test('the room setting reaches the authoritative state', () => {
	const fair = harness('fair');
	const fcfs = harness('fcfs');
	// Ana queues two, Ben queues one in between.
	for (const h of [fair, fcfs]) {
		h.state.applyQueueOp({ op: 'add', entry: entry('a1', 'ana', 1) });
		h.state.applyQueueOp({ op: 'add', entry: entry('a2', 'ana', 2) });
		h.state.applyQueueOp({ op: 'add', entry: entry('b1', 'ben', 3) });
	}
	expect(ids(fair.state.entries)).toEqual(['a1', 'b1', 'a2']);
	expect(ids(fcfs.state.entries)).toEqual(['a1', 'a2', 'b1']);
});

test('an unwritten room defaults to fair rotation — the pre-setting behaviour', () => {
	const h = harness();
	expect(h.settings.getRoom('main').queueOrder).toBe('fair');
});

test('the chosen algorithm survives a write and a re-read', () => {
	const h = harness();
	expect(h.settings.setRoom({ queueOrder: 'shuffle' }, 'main').queueOrder).toBe('shuffle');
	expect(h.settings.getRoom('main').queueOrder).toBe('shuffle');
	// and an algorithm that does not exist leaves the room on the one it is running
	expect(h.settings.setRoom({ queueOrder: 'no-such-order' as QueueOrderId }, 'main').queueOrder).toBe('shuffle');
});

test('changing the algorithm leaves the standing queue alone — only later adds use the new rule', () => {
	// THE STORED-LIST MODEL (#856). The queue is the source of truth, so switching the algorithm can
	// no longer re-sort songs already queued: that would throw away every reorder anyone had made.
	// The new rule takes effect at the next INSERT.
	const h = harness('fair');
	h.state.applyQueueOp({ op: 'add', entry: entry('a1', 'ana', 1) });
	h.state.applyQueueOp({ op: 'add', entry: entry('a2', 'ana', 2) });
	h.state.applyQueueOp({ op: 'add', entry: entry('b1', 'ben', 3) });
	expect(ids(h.state.entries)).toEqual(['a1', 'b1', 'a2']);

	const revBefore = h.state.rev;
	h.settings.setRoom({ queueOrder: 'fcfs' }, 'main');
	// nothing to re-derive: the flip publishes no new snapshot and does not bump the rev
	expect(h.state.reorder()).toBeNull();
	expect(h.state.rev).toBe(revBefore);
	expect(ids(h.state.entries)).toEqual(['a1', 'b1', 'a2']);

	// but the NEXT add follows fcfs — it appends instead of interleaving into ana's round
	h.state.applyQueueOp({ op: 'add', entry: entry('b2', 'ben', 4) });
	expect(ids(h.state.entries)).toEqual(['a1', 'b1', 'a2', 'b2']);
	expect(h.state.entries.map((e) => e.rotationSeq)).toEqual([0, 1, 2, 3]);
});

test('reorder() is a true no-op when the order is unchanged — no rev bump, nothing to publish', () => {
	const h = harness('fair');
	h.state.applyQueueOp({ op: 'add', entry: entry('a1', 'ana', 1) });
	h.state.applyQueueOp({ op: 'add', entry: entry('b1', 'ben', 2) });
	const rev = h.state.rev;
	// re-picking the algorithm already in force changes nothing
	h.settings.setRoom({ queueOrder: 'fair' }, 'main');
	expect(h.state.reorder()).toBeNull();
	expect(h.state.rev).toBe(rev);
});

test('a mid-party flip does not touch the song already playing', () => {
	const h = harness('fair');
	h.state.applyQueueOp({ op: 'add', entry: entry('a1', 'ana', 1) });
	h.state.applyQueueOp({ op: 'add', entry: entry('a2', 'ana', 2) });
	h.state.applyQueueOp({ op: 'add', entry: entry('b1', 'ben', 3) });
	handlePlayerCommand({ cmd: 'play' }, h.deps);
	const singing = h.state.playback.currentEntryId;
	expect(singing).toBe('a1');

	h.settings.setRoom({ queueOrder: 'fcfs' }, 'main');
	h.state.reorder();
	expect(h.state.playback.currentEntryId).toBe(singing);
	expect(h.state.playback.isPlaying).toBe(true);
});

// ── least-recently-sung: the stamp must land before the reseq that reads it ──
test('starting a song stamps the singer, and the stamp steers the NEXT add, not the standing queue', () => {
	const h = harness('least-recently-sung');
	// Real singer rows, because the stamp is written BY ID: entries carrying a literal singerId would
	// update no row and this test would pass on fair rotation alone.
	const ana = h.singers.create('Ana', '#f00', 1, ROOM);
	const ben = h.singers.create('Ben', '#0f0', 2, ROOM);
	// Two songs EACH — with one song for Ben the two orderings agree, and the test proves nothing.
	h.state.applyQueueOp({ op: 'add', entry: entry('a1', ana.id, 1) });
	h.state.applyQueueOp({ op: 'add', entry: entry('a2', ana.id, 2) });
	h.state.applyQueueOp({ op: 'add', entry: entry('b1', ben.id, 3) });
	h.state.applyQueueOp({ op: 'add', entry: entry('b2', ben.id, 4) });
	// Nobody has sung yet, so this starts as fair: Ana leads each round.
	expect(ids(h.state.entries)).toEqual(['a1', 'b1', 'a2', 'b2']);

	handlePlayerCommand({ cmd: 'play' }, h.deps);
	expect(h.state.playback.currentEntryId).toBe('a1');
	expect(h.singers.byId(ana.id)!.lastSungAt).toBeGreaterThan(0);
	// THE STORED-LIST MODEL (#856): sing history moving does NOT re-sort songs already queued. The
	// queue everyone is looking at holds its order — it used to become ['b1','b2','a2'] here, which
	// silently rearranged rows nobody touched. The stamp is still load-bearing: it is an input to the
	// INSERT rule, which `queue-order.test.ts` pins directly (a never-sung singer is placed ahead of
	// one who just sang, within the same round).
	expect(ids(h.state.entries.filter((e) => e.status === 'queued'))).toEqual(['b1', 'a2', 'b2']);
});

test('a singer who has not sung is ordered ahead of one who has', () => {
	const h = harness('least-recently-sung');
	const ana = h.singers.create('Ana', '#f00', 1, ROOM);
	const ben = h.singers.create('Ben', '#0f0', 2, ROOM);
	h.singers.markSang(ana.id, 500); // Ana sang earlier tonight; Ben has not sung at all

	h.state.applyQueueOp({ op: 'add', entry: entry('ana1', ana.id, 1) });
	h.state.applyQueueOp({ op: 'add', entry: entry('ben1', ben.id, 9) });
	// Ana queued FIRST, which is what fair orders by; sing history reverses it.
	expect(ids(h.state.entries)).toEqual(['ben1', 'ana1']);
});

test('orderingOf carries both halves — the algorithm and the sing history', () => {
	const h = harness('least-recently-sung');
	const ana = h.singers.create('Ana', '#f00', 1, ROOM);
	h.singers.markSang(ana.id, 777);
	const ordering = orderingOf(h.deps);
	expect(ordering.order).toBe('least-recently-sung');
	expect(ordering.lastSungAt?.get(ana.id)).toBe(777);
});

test('the stamp records only THAT a singer sang, never what', () => {
	// The privacy line this feature must not cross: `plays` carries no singer id, so the ordering's
	// signal lives on the singer as a bare timestamp. If a media/entry id ever appears here, the
	// rotation has started keeping a per-singer song history nobody agreed to.
	const h = harness('least-recently-sung');
	const ana = h.singers.create('Ana', '#f00', 1, ROOM);
	h.singers.markSang(ana.id, 777);
	const row = h.singers.byId(ana.id)!;
	expect(row.lastSungAt).toBe(777);
	// roomId (#656) is a scoping key, not song history — its presence does not cross the privacy line
	// the test guards (no media/entry id on the singer row).
	expect(Object.keys(row).sort()).toEqual([
		'color',
		'displayName',
		'id',
		'joinedAt',
		'lastSungAt',
		'roomId',
		'sessionToken'
	]);
});

test('a fresh singer has no stamp — absent, not zero', () => {
	const h = harness();
	const ana = h.singers.create('Ana', '#f00', 1, ROOM);
	expect(h.singers.byId(ana.id)!.lastSungAt ?? null).toBeNull();
	expect(singHistoryFrom(h.singers.listPublic(ROOM)).has(ana.id)).toBe(false);
});
