// The play log exists for the one question a counter cannot answer: WHEN.
import { expect, it } from 'bun:test';
import { migratedDb } from '../db/test-db';
import { PlayLog } from './play-log';
import { PlayTracker } from './plays';

const T0 = Date.UTC(2026, 8, 4, 12, 0, 0); // 2026-09-04T12:00:00Z
const DAY = 86_400_000;

function log(): PlayLog {
	const db = migratedDb();
	return new PlayLog(db);
}

it('play log counts plays within a window, which the sidecar counter cannot — the time axis', () => {
	const l = log();
	l.record('m1', 'e1', T0 - 10 * DAY);
	l.record('m1', 'e2', T0 - 1 * DAY);
	l.record('m2', 'e3', T0);

	expect(l.total()).toBe(3);
	expect(l.totalSince(T0 - 2 * DAY)).toBe(2); // "this week" is now answerable
});

it('play log buckets plays per UTC day for the trend line — the time axis', () => {
	const l = log();
	l.record('m1', 'e1', T0);
	l.record('m2', 'e2', T0 + 3_600_000); // same day
	l.record('m3', 'e3', T0 + DAY);

	expect(l.perDay(T0 - DAY)).toEqual([
		{ day: '2026-09-04', plays: 2 },
		{ day: '2026-09-05', plays: 1 }
	]);
});

it('play log omits days with no plays instead of zero-filling them — the time axis', () => {
	// The log cannot tell "nobody sang" from "the server was off", so a fabricated zero would draw
	// a quiet night and an outage identically. The gap is the honest answer.
	const l = log();
	l.record('m1', 'e1', T0);
	l.record('m2', 'e2', T0 + 3 * DAY);

	expect(l.perDay(T0 - DAY).map((d) => d.day)).toEqual(['2026-09-04', '2026-09-07']);
});

it('play log ranks top songs, and can rank them within a window — the time axis', () => {
	const l = log();
	// m1 was huge last month; m2 is tonight's favourite.
	l.record('m1', 'a1', T0 - 30 * DAY);
	l.record('m1', 'a2', T0 - 29 * DAY);
	l.record('m1', 'a3', T0 - 28 * DAY);
	l.record('m2', 'b1', T0);
	l.record('m2', 'b2', T0 + 1_000);

	expect(l.topSongs(5)[0]).toEqual({ mediaId: 'm1', plays: 3 }); // all time
	expect(l.topSongs(5, T0 - DAY)[0]).toEqual({ mediaId: 'm2', plays: 2 }); // tonight
});

it('play log counts the same song queued twice as two plays — the time axis', () => {
	const l = log();
	l.record('m1', 'entry-1', T0);
	l.record('m1', 'entry-2', T0 + 60_000);
	expect(l.total()).toBe(2);
	expect(l.distinctSongs()).toBe(1);
});

it('play log refuses a second row for the same queue entry — dedup survives a restart', () => {
	// PlayTracker dedupes re-emits in memory, but its state resets on restart while the DB's does
	// not. Replaying the entry that was on screen when the server went down would otherwise be
	// counted twice. The unique index makes it impossible.
	const l = log();
	l.record('m1', 'e1', T0);
	l.record('m1', 'e1', T0 + 5_000); // same entry, e.g. after a reboot re-emit
	expect(l.total()).toBe(1);
});

it('play log does not throw into the playback path on a duplicate — dedup survives a restart', () => {
	const l = log();
	l.record('m1', 'e1', T0);
	expect(() => l.record('m1', 'e1', T0 + 1)).not.toThrow();
});

it('play log records one play per genuinely-new entry, not per emit — wired to the tracker that already dedupes emits', () => {
	const l = log();
	let now = T0;
	const tracker = new PlayTracker((mediaId, entryId) => l.record(mediaId, entryId, now));

	tracker.onNowPlaying({ id: 'e1', mediaId: 'm1' });
	tracker.onNowPlaying({ id: 'e1', mediaId: 'm1' }); // a finished cook re-broadcast nowplaying
	tracker.onNowPlaying({ id: 'e1', mediaId: 'm1' });
	now = T0 + 60_000;
	tracker.onNowPlaying({ id: 'e2', mediaId: 'm2' });

	expect(l.total()).toBe(2);
});

it('play log records nothing when playback stops — wired to the tracker that already dedupes emits', () => {
	const l = log();
	const tracker = new PlayTracker((mediaId, entryId) => l.record(mediaId, entryId, T0));
	tracker.onNowPlaying(null);
	expect(l.total()).toBe(0);
});

it("play log returns one song's plays newest first — per-song history", () => {
	const l = log();
	l.record('m1', 'e1', T0);
	l.record('m1', 'e2', T0 + DAY);
	l.record('m2', 'e3', T0 + 2 * DAY);

	const hist = l.forMedia('m1');
	expect(hist.map((h) => h.entryId)).toEqual(['e2', 'e1']);
});
