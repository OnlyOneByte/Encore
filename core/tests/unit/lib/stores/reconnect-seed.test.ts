// A RE-connect's library re-read is what a reload would say, for a song that was being made too (round-7 review,
// R7-SEED-0..4, adopted). After a core restart the boot sweep says `unservable` once, before any socket is back, so
// the snapshot is the only place the phone and the TV can learn it; everything they held is from before the drop.
import { expect, test } from 'bun:test';
import { RoomLink } from '$lib/stores/room';
import { pruneLiveStatus, seedLiveStatus } from '$lib/tv/catalog';
import { queueCardKind, waitingTurns } from '$lib/readiness';
import type { Media, MediaStatus } from '$lib/contract';

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});
const cooking = (id: string): Media => media(id, { stemStatus: 'queued' });
// What /api/library answers after the restart: still processing, and no worker can run it.
const row = { media: cooking('m1'), status: 'separating' as MediaStatus, pct: 0, unservable: true };
const kind = (l: RoomLink) => queueCardKind(l.mediaCatalog.get('m1'), l.mediaStatus.get('m1'));

test('R7-SEED-0: a phone that RELOADS reads the stall', () => {
	const fresh = new RoomLink();
	fresh.mergeMedia([cooking('m1')]);
	fresh.seedMediaStatus([row]);
	expect(kind(fresh)).toBe('stalled');
});

test('R7-SEED-1: a phone that RE-CONNECTS after a core restart reads the same stall as a reload', () => {
	const live = new RoomLink();
	live.mergeMedia([cooking('m1')]);
	live.setMediaStatus('m1', { status: 'separating', pct: 40 }); // heard live before the restart
	live.seedMediaStatus([row], true);
	expect(kind(live)).toBe('stalled');
	// A FIRST load keeps the live word, as before: only a re-connect knows what it holds is stale.
	const first = new RoomLink();
	first.mergeMedia([cooking('m1')]);
	first.setMediaStatus('m1', { status: 'separating', pct: 40 });
	first.seedMediaStatus([row]);
	expect(kind(first)).toBe('processing');
});

test('R7-SEED-2: a phone mid-hold (optimistic queued) at a core restart reads the stall after re-connect', () => {
	const live = new RoomLink();
	live.mergeMedia([cooking('m1')]);
	live.setMediaStatus('m1', { status: 'queued', pct: 0 }); // Try again's optimistic mark
	live.seedMediaStatus([{ ...row, status: 'queued' }], true);
	expect(live.mediaStatus.get('m1')?.unservable).toBe(true);
});

test('R7-SEED-3: a TV that RE-CONNECTS after a core restart says what a reload says', () => {
	const heard = new Map([
		['m1', { type: 'media:status' as const, mediaId: 'm1', status: 'separating' as MediaStatus, pct: 40 }]
	]);
	const tv = seedLiveStatus(heard, [row], [], { reconnect: true });
	const reload = seedLiveStatus(new Map(), [row], []);
	const fold = (m: typeof tv) =>
		waitingTurns(
			[{ singerId: 's', mediaId: 'm1' }],
			() => cooking('m1'),
			(id) => m.get(id)
		);
	expect(fold(tv)).toEqual(fold(reload));
});

test('R7-SEED-4: a job that died while the socket was down: a re-connect reads what a reload reads', () => {
	const live = new RoomLink();
	live.mergeMedia([cooking('m1')]);
	live.setMediaStatus('m1', { status: 'separating', pct: 40 });
	// The socket drops; the job fails (no frame reaches this phone). Re-connect: the library says it settled back.
	live.mergeMedia([media('m1')]);
	live.seedMediaStatus([], true);
	live.seedNoMakerFailures([]);
	const reload = new RoomLink();
	reload.mergeMedia([media('m1')]);
	expect(kind(live)).toBe(kind(reload));
	// The TV, the same way.
	const tv = seedLiveStatus(
		new Map([['m1', { type: 'media:status' as const, mediaId: 'm1', status: 'separating' as MediaStatus, pct: 40 }]]),
		[],
		[],
		{ reconnect: true }
	);
	expect(tv.has('m1')).toBe(false);
});

test('a frame heard SINCE the re-connect is newer than the snapshot, and stays', () => {
	const heard = new Map([
		['m1', { type: 'media:status' as const, mediaId: 'm1', status: 'aligning' as MediaStatus, pct: 10 }]
	]);
	const tv = seedLiveStatus(heard, [row], [], { reconnect: true, heard: new Set(['m1']) });
	expect(tv.get('m1')).toMatchObject({ status: 'aligning', pct: 10 });
});

test('a queue sync prunes the lobby statuses to the songs the room still holds', () => {
	const s = (mediaId: string) => ({ type: 'media:status' as const, mediaId, status: 'failed' as MediaStatus, pct: 0 });
	const live = new Map([
		['kept', s('kept')],
		['gone', s('gone')]
	]);
	expect([...pruneLiveStatus(live, [{ mediaId: 'kept' }]).keys()]).toEqual(['kept']);
	// Nothing to drop: the same map, so the lobby does not re-render for nothing.
	expect(pruneLiveStatus(live, [{ mediaId: 'kept' }, { mediaId: 'gone' }])).toBe(live);
});
