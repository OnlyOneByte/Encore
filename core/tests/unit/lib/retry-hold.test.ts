import { expect, test } from 'bun:test';
import { retryHoldAfter, queueCardKind } from '$lib/readiness';
import { migratedDb } from '$lib/server/db/test-db';
import { JobRepository } from '$lib/server/jobs/repository';
import { mediaStatusFor } from '$lib/server/jobs/media-status';
import type { Media, MediaStatus } from '$lib/contract';

/*
 * "Trying again…" is a flat 1.5 s hold that only a VERDICT cuts short. Each case is the sequence of statuses the card
 * sees after the tap, starting from the status it was tapped over; the answer is where the hold ends.
 */
function endsAt(tappedOver: MediaStatus | undefined, seen: (MediaStatus | undefined)[]): number | 'timeout' {
	let held: MediaStatus | undefined | null = tappedOver;
	for (const [i, status] of seen.entries()) {
		held = retryHoldAfter(held as MediaStatus | undefined, status);
		if (held === null) return i;
	}
	return 'timeout';
}

test('no maker: the queued reply, at whatever stage it is parked on, never ends it', () => {
	expect(endsAt(undefined, ['queued', 'queued'])).toBe('timeout');
	expect(endsAt(undefined, ['queued', 'downloading'])).toBe('timeout');
});

test('a stage never ends it: the server synthesises one for a new job before any worker has it', () => {
	// After the TTL a new stems job's first frame is `separating`, with no worker in the room.
	expect(endsAt('failed', ['queued', 'separating'])).toBe('timeout');
});

test('a verdict ends it at once: a fresh failed, or ready', () => {
	expect(endsAt('failed', ['queued', 'separating', 'failed'])).toBe(2);
	expect(endsAt(undefined, ['queued', 'ready'])).toBe(1);
});

test("a failed card's own failed is not a verdict", () => {
	expect(endsAt('failed', ['failed'])).toBe('timeout');
});

test('a request that never started (status cleared) leaves the timeout to end it', () => {
	expect(endsAt('failed', ['queued', undefined])).toBe('timeout');
});

// R6-HOLD-1 (round-6 code review), adopted: the server's own first frame for a NEW stems job is its floor stage, with
// no worker and no `unservable` yet, and the card reads it as processing. It must not end the hold.
test('R6-HOLD-1: a server-synthesised floor stage does not end the hold', () => {
	const jobs = new JobRepository(migratedDb());
	const job = jobs.enqueue('s1', 'stems', 0, 1_700_000_000_000);
	const synth = mediaStatusFor(job);
	expect(job.status).toBe('queued');
	expect(synth).not.toBe('queued');
	const settled: Media = {
		id: 's1',
		source: 'youtube',
		sourceRef: 'v',
		title: 's1',
		durationSec: 200,
		stemStatus: 'none'
	};
	expect(queueCardKind(settled, { status: synth })).toBe('processing');
	expect(endsAt('failed', ['queued', synth])).toBe('timeout');
});
