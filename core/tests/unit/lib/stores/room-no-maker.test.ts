import { expect, test } from 'bun:test';
import { RoomLink } from '$lib/stores/room';
import type { Media, QueueEntry } from '$lib/contract';

/*
 * `room.noMaker` is what the Library's empty state reads before it promises "we'll make the karaoke track": the same
 * verdict the TV and the strip say as "Can't make new karaoke right now". Only a QUEUED turn the server condemned for
 * want of a worker makes it true; a plain failure does not, because a Try again can fix that one.
 */

const settled = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none'
});
const turn = (id: string, mediaId: string, status: QueueEntry['status'] = 'queued'): QueueEntry => ({
	id,
	mediaId,
	singerId: 's1',
	status,
	rotationSeq: 0,
	addedAt: 1
});

function room(entries: QueueEntry[]): RoomLink {
	const link = new RoomLink();
	link.mergeMedia([settled('dead')]);
	link.entries = entries;
	return link;
}

test('a queued turn the server says no worker can make is "no maker"', () => {
	const link = room([turn('e1', 'dead')]);
	link.seedNoMakerFailures(['dead']);
	expect(link.noMaker).toBe(true);
});

test('a plain failure is not "no maker": a Try again can fix it', () => {
	const link = room([turn('e1', 'dead')]);
	link.setMediaStatus('dead', { status: 'failed', pct: 0 });
	expect(link.noMaker).toBe(false);
});

test('a turn that is not waiting does not make the room "no maker"', () => {
	const link = room([turn('e1', 'dead', 'playing')]);
	link.seedNoMakerFailures(['dead']);
	expect(link.noMaker).toBe(false);
});
