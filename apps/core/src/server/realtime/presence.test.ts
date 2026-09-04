import { describe, expect, it } from 'bun:test';
import { PresenceTracker } from './presence';
import { syncEvent } from './hub';
import { AuthoritativeState } from '../state/store';
import { graceMsOf } from '@encore/shared';

const NOW = 1_000_000;
const GRACE = graceMsOf(90);
/** Nobody holds songs unless a test says so. */
const noSongs = (_id: string) => false;
const sweep = (
	p: PresenceTracker,
	now = NOW,
	hasPendingSongs: (singerId: string) => boolean = noSongs,
	graceMs = GRACE
) => p.evaluate({ now, graceMs, hasPendingSongs });

describe('PresenceTracker sockets', () => {
	it('a singer becomes here on their first socket and away on their last', () => {
		const p = new PresenceTracker();
		expect(p.isOnline('s1')).toBe(false);

		expect(p.connect('s1')).toBe(true); // newly here → broadcast
		expect(p.isOnline('s1')).toBe(true);
		expect(p.online()).toEqual(['s1']);
		expect(p.count()).toBe(1);

		expect(p.disconnect('s1', NOW)).toBe(true); // newly away → broadcast
		expect(p.isOnline('s1')).toBe(false);
		expect(p.online()).toEqual([]);
		expect(p.count()).toBe(0);
	});

	it('ref-counts multiple sockets: a second tab does not re-announce, one close does not remove', () => {
		const p = new PresenceTracker();
		expect(p.connect('s1')).toBe(true);
		expect(p.connect('s1')).toBe(false); // already here — nothing changed
		expect(p.sockets('s1')).toBe(2);

		// closing ONE of two sockets must keep them in the roster (the reconnect case)
		expect(p.disconnect('s1', NOW)).toBe(false);
		expect(p.isOnline('s1')).toBe(true);
		expect(p.sockets('s1')).toBe(1);

		expect(p.disconnect('s1', NOW)).toBe(true); // last one out
		expect(p.isOnline('s1')).toBe(false);
	});

	it('tracks singers independently and reports arrival order', () => {
		const p = new PresenceTracker();
		p.connect('angelo');
		p.connect('maya');
		p.connect('devon');
		expect(p.online()).toEqual(['angelo', 'maya', 'devon']);

		p.disconnect('maya', NOW);
		expect(p.online()).toEqual(['angelo', 'devon']);
		expect(p.count()).toBe(2);
	});

	it('disconnect for an unknown singer is a no-op, not a phantom entry', () => {
		const p = new PresenceTracker();
		expect(p.disconnect('never-connected', NOW)).toBe(false);
		expect(p.count()).toBe(0);
		expect(sweep(p).away).toEqual([]);
	});

	it('a double disconnect does not re-announce or go negative', () => {
		const p = new PresenceTracker();
		p.connect('s1');
		expect(p.disconnect('s1', NOW)).toBe(true);
		expect(p.disconnect('s1', NOW)).toBe(false); // already away
		expect(p.sockets('s1')).toBe(0);
	});

	it('re-joining after going away works (no stuck zero entry)', () => {
		const p = new PresenceTracker();
		p.connect('s1');
		p.disconnect('s1', NOW);
		expect(p.connect('s1')).toBe(true); // announced again
		expect(p.isOnline('s1')).toBe(true);
		expect(p.sockets('s1')).toBe(1);
	});
});

describe('membership: away is not gone', () => {
	it('losing the last socket makes a singer away, and the sweep keeps them there', () => {
		const p = new PresenceTracker();
		p.connect('dana');
		p.disconnect('dana', NOW);

		const snap = sweep(p, NOW + 1000);
		expect(snap.here).toEqual([]);
		expect(snap.away).toEqual(['dana']); // a locked phone is still in the room
		expect(snap.gone).toEqual([]);
	});

	it('a singer holding a queued song never starts a clock, however long they are away', () => {
		const p = new PresenceTracker();
		p.connect('dana');
		p.disconnect('dana', NOW);

		const withSongs = () => true;
		expect(sweep(p, NOW + GRACE * 5, withSongs).away).toEqual(['dana']);
		expect(sweep(p, NOW + GRACE * 50, withSongs).gone).toEqual([]);
	});

	it('the clock starts when their last song leaves the queue, and expiry follows from there', () => {
		const p = new PresenceTracker();
		p.connect('dana');
		p.disconnect('dana', NOW);

		// away with songs for an hour: no clock
		let pending = true;
		sweep(p, NOW + graceMsOf(60), () => pending);

		// her last song plays; the clock starts on the next sweep
		pending = false;
		const drained = NOW + graceMsOf(60);
		expect(sweep(p, drained, noSongs).away).toEqual(['dana']);

		// ...and it runs from the drain, NOT from when she disconnected an hour earlier
		expect(sweep(p, drained + GRACE - 1000, noSongs).away).toEqual(['dana']);
		expect(sweep(p, drained + GRACE, noSongs).gone).toEqual(['dana']);
	});

	it('re-queueing a song while away clears a running clock', () => {
		const p = new PresenceTracker();
		p.connect('dana');
		p.disconnect('dana', NOW);
		sweep(p, NOW, noSongs); // clock starts

		// somebody queues a song on her behalf, or she reconnects briefly and adds one
		let pending = true;
		expect(sweep(p, NOW + GRACE * 2, () => pending).away).toEqual(['dana']);

		// the clock restarts from the NEW drain, so the earlier elapsed time is not carried over
		pending = false;
		const redrained = NOW + GRACE * 2;
		expect(sweep(p, redrained, noSongs).away).toEqual(['dana']);
		expect(sweep(p, redrained + GRACE - 1, noSongs).away).toEqual(['dana']);
		expect(sweep(p, redrained + GRACE, noSongs).gone).toEqual(['dana']);
	});

	it('reconnecting cancels the clock outright rather than pausing it', () => {
		const p = new PresenceTracker();
		p.connect('dana');
		p.disconnect('dana', NOW);
		sweep(p, NOW, noSongs); // clock started

		// most of the window burns down, then she comes back
		sweep(p, NOW + GRACE - 1000, noSongs);
		p.connect('dana');
		expect(sweep(p, NOW + GRACE - 1000, noSongs).here).toEqual(['dana']);

		// dropping again gives a FULL window — a stale start time would expire her almost immediately
		const second = NOW + GRACE;
		p.disconnect('dana', second);
		sweep(p, second, noSongs);
		expect(sweep(p, second + GRACE - 1, noSongs).away).toEqual(['dana']);
		expect(sweep(p, second + GRACE, noSongs).gone).toEqual(['dana']);
	});

	it('a gone singer is forgotten, so the map stays bounded over a long night', () => {
		const p = new PresenceTracker();
		p.connect('dana');
		p.disconnect('dana', NOW);
		sweep(p, NOW, noSongs);
		expect(sweep(p, NOW + GRACE, noSongs).gone).toEqual(['dana']);

		// reported gone exactly once; afterwards she is simply not a member
		const after = sweep(p, NOW + GRACE * 2, noSongs);
		expect(after.gone).toEqual([]);
		expect(after.away).toEqual([]);
		expect(p.stateOf('dana', NOW + GRACE * 2, GRACE, false)).toBe('gone');
	});

	it('zero grace still keeps a singer while songs are pending, then drops them at the drain', () => {
		const p = new PresenceTracker();
		p.connect('dana');
		p.disconnect('dana', NOW);

		let pending = true;
		expect(sweep(p, NOW + 60_000, () => pending, 0).away).toEqual(['dana']);
		pending = false;
		expect(sweep(p, NOW + 60_000, noSongs, 0).gone).toEqual(['dana']);
	});

	it('here, away and gone are reported together for a mixed room', () => {
		const p = new PresenceTracker();
		p.connect('here-now');
		p.connect('has-songs');
		p.connect('expired');
		p.disconnect('has-songs', NOW);
		p.disconnect('expired', NOW);
		sweep(p, NOW, (id) => id === 'has-songs');

		const snap = sweep(p, NOW + GRACE, (id) => id === 'has-songs');
		expect(snap.here).toEqual(['here-now']);
		expect(snap.away).toEqual(['has-songs']);
		expect(snap.gone).toEqual(['expired']);
	});
});

describe('membership rides the sync handshake', () => {
	// A TV or phone connecting mid-party gets the roster from queue:sync, not from the next
	// membership change — otherwise a quiet room renders an empty roster until someone joins or leaves.
	it('syncEvent carries both the here and away snapshots', () => {
		const state = new AuthoritativeState();
		const ev = syncEvent(state, {
			mediaById: new Map(),
			listOnline: () => ['angelo', 'maya'],
			listAway: () => ['dana']
		});
		expect(ev.online).toEqual(['angelo', 'maya']);
		expect(ev.away).toEqual(['dana']);
	});

	it('omits both entirely when no membership dep is wired, so a client keeps what it has', () => {
		const ev = syncEvent(new AuthoritativeState(), { mediaById: new Map() });
		expect(ev.online).toBeUndefined();
		expect(ev.away).toBeUndefined();
	});
});
