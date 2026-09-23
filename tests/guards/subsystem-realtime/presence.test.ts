import { expect, it } from 'bun:test';
import { read } from '@encore/test-support';
import { PresenceTracker } from '$lib/server/realtime/presence';
import { syncEvent } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { graceMsOf } from '$lib/contract';

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

it('PresenceTracker sockets: a singer becomes here on their first socket and away on their last', () => {
	const p = new PresenceTracker();
	expect(p.online()).toEqual([]);

	expect(p.connect('s1')).toBe(true); // newly here → broadcast
	expect(p.online()).toEqual(['s1']);

	expect(p.disconnect('s1', NOW)).toBe(true); // newly away → broadcast
	expect(p.online()).toEqual([]);
});

it('PresenceTracker sockets — ref-counts multiple sockets: a second tab does not re-announce, one close does not remove', () => {
	const p = new PresenceTracker();
	expect(p.connect('s1')).toBe(true);
	expect(p.connect('s1')).toBe(false); // already here — nothing changed
	expect(p.sockets('s1')).toBe(2);

	// closing ONE of two sockets must keep them in the roster (the reconnect case)
	expect(p.disconnect('s1', NOW)).toBe(false);
	expect(p.online()).toEqual(['s1']);
	expect(p.sockets('s1')).toBe(1);

	expect(p.disconnect('s1', NOW)).toBe(true); // last one out
	expect(p.online()).toEqual([]);
});

it('PresenceTracker sockets: tracks singers independently and reports arrival order', () => {
	const p = new PresenceTracker();
	p.connect('angelo');
	p.connect('maya');
	p.connect('devon');
	expect(p.online()).toEqual(['angelo', 'maya', 'devon']);

	p.disconnect('maya', NOW);
	expect(p.online()).toEqual(['angelo', 'devon']);
});

it('PresenceTracker sockets: disconnect for an unknown singer is a no-op, not a phantom entry', () => {
	const p = new PresenceTracker();
	expect(p.disconnect('never-connected', NOW)).toBe(false);
	expect(p.online()).toEqual([]);
	expect(sweep(p).away).toEqual([]);
});

it('PresenceTracker sockets: a double disconnect does not re-announce or go negative', () => {
	const p = new PresenceTracker();
	p.connect('s1');
	expect(p.disconnect('s1', NOW)).toBe(true);
	expect(p.disconnect('s1', NOW)).toBe(false); // already away
	expect(p.sockets('s1')).toBe(0);
});

it('PresenceTracker sockets: re-joining after going away works (no stuck zero entry)', () => {
	const p = new PresenceTracker();
	p.connect('s1');
	p.disconnect('s1', NOW);
	expect(p.connect('s1')).toBe(true); // announced again
	expect(p.online()).toEqual(['s1']);
	expect(p.sockets('s1')).toBe(1);
});

it('membership: away is not gone — losing the last socket makes a singer away, and the sweep keeps them there', () => {
	const p = new PresenceTracker();
	p.connect('dana');
	p.disconnect('dana', NOW);

	const snap = sweep(p, NOW + 1000);
	expect(snap.here).toEqual([]);
	expect(snap.away).toEqual(['dana']); // a locked phone is still in the room
	expect(snap.gone).toEqual([]);
});

it('membership: away is not gone — a singer holding a queued song never starts a clock, however long they are away', () => {
	const p = new PresenceTracker();
	p.connect('dana');
	p.disconnect('dana', NOW);

	const withSongs = () => true;
	expect(sweep(p, NOW + GRACE * 5, withSongs).away).toEqual(['dana']);
	expect(sweep(p, NOW + GRACE * 50, withSongs).gone).toEqual([]);
});

it('membership: away is not gone — the clock starts when their last song leaves the queue, and expiry follows from there', () => {
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

it('membership: away is not gone — re-queueing a song while away clears a running clock', () => {
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

it('membership: away is not gone — reconnecting cancels the clock outright rather than pausing it', () => {
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

it('membership: away is not gone — a reconnect that re-drops inside one sweep interval still gets a full fresh window', () => {
	// The pocket case: a phone wakes on a notification and re-locks before the next 20s sweep, so no sweep
	// runs between the reconnect and the re-drop. connect() must clear the running clock outright (awaySince
	// AND clockStartedAt) — merely pausing carries the stale start over and expires her a full window early.
	const p = new PresenceTracker();
	p.connect('dana');
	p.disconnect('dana', NOW);
	sweep(p, NOW, noSongs); // clock starts at NOW

	// she reconnects most of the way through the window, then re-drops WITHOUT any sweep in between
	const back = NOW + GRACE - 1000;
	p.connect('dana');
	const redrop = back; // re-locks immediately; no sweep has cleared the stale clock
	p.disconnect('dana', redrop);

	// Fixture, not the discriminator: at GRACE - 1000 even a carried-over clock still reads below grace.
	expect(sweep(p, redrop, noSongs).away).toEqual(['dana']);
	// THE DISCRIMINATOR: a carried-over clockStartedAt of NOW reads elapsed 2*GRACE - 1001 >= grace here and
	// would already have expired her, a full window early.
	expect(sweep(p, redrop + GRACE - 1, noSongs).away).toEqual(['dana']);
	// ...and she does expire once the fresh window is spent, so a clock must exist at all.
	expect(sweep(p, redrop + GRACE, noSongs).gone).toEqual(['dana']);
});

it('membership: away is not gone — a gone singer is forgotten, so the map stays bounded over a long night', () => {
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

it('membership: away is not gone — zero grace still keeps a singer while songs are pending, then drops them at the drain', () => {
	const p = new PresenceTracker();
	p.connect('dana');
	p.disconnect('dana', NOW);

	let pending = true;
	expect(sweep(p, NOW + 60_000, () => pending, 0).away).toEqual(['dana']);
	pending = false;
	expect(sweep(p, NOW + 60_000, noSongs, 0).gone).toEqual(['dana']);
});

it('membership: away is not gone — here, away and gone are reported together for a mixed room', () => {
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

// A TV or phone connecting mid-party gets the roster from queue:sync, not from the next membership change —
// otherwise a quiet room renders an empty roster until someone joins or leaves.
it('membership rides the sync handshake: syncEvent carries both the here and away snapshots', () => {
	const state = new AuthoritativeState();
	const ev = syncEvent(state, {
		mediaById: new Map(),
		listOnline: () => ['angelo', 'maya'],
		listAway: () => ['dana']
	});
	expect(ev.online).toEqual(['angelo', 'maya']);
	expect(ev.away).toEqual(['dana']);
});

it('membership rides the sync handshake: omits both entirely when no membership dep is wired, so a client keeps what it has', () => {
	const ev = syncEvent(new AuthoritativeState(), { mediaById: new Map() });
	expect(ev.online).toBeUndefined();
	expect(ev.away).toBeUndefined();
});

// The deleted isOnline()/count() returned exactly the `sockets > 0` predicate that IS the locked-phone
// eviction bug the three-state here/away/gone policy replaces — and they were the cheapest presence check
// to reach for. Nothing called them, so deleting them has no runtime-observable regression: guard the SOURCE.
const stripComments = (src: string) =>
	src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
const source = stripComments(read('src/lib/server/realtime/presence.ts'));

it('membership: the discredited socket-count predicate stays deleted — does not re-expose isOnline() or count() on PresenceTracker', () => {
	expect(source).not.toMatch(/\bisOnline\s*\(/);
	expect(source).not.toMatch(/\bcount\s*\(\s*\)/);
});

// THE INVARIANT: membership is answered ONLY through stateOf()/evaluate(), never by a method handing back a raw
// socket-count boolean. Pinning isOnline()'s deleted BODY TEXT was not enough — the same predicate re-added under
// a new name survived it — so the checks below are name-independent: an allowlist plus a shape ban.
const CLASS_START = 'class PresenceTracker';
const classBody = source.slice(source.indexOf(CLASS_START));
// Harvest a one-tab-indented name followed by `(` (method) OR `=` (arrow property — `isHere = (id) => …`). A
// leading `public`/`private`/... modifier MUST be skipped before the name capture, or the candidate becomes the
// modifier and the member drops out of the set entirely — a false EXEMPT past the allowlist, not a false RED.
const MEMBER_MODIFIERS = /(?:public|private|protected|readonly|static)\s+/.source;
const publicMethods = [
	...classBody.matchAll(new RegExp(`\\n\\t(?:${MEMBER_MODIFIERS})*([A-Za-z_$][\\w$]*)\\s*(?:\\(|=)`, 'g'))
]
	.map((m) => m[1])
	.sort();

it('membership: the discredited socket-count predicate stays deleted — exposes ONLY the allowlisted public methods (a rename cannot slip a membership predicate in)', () => {
	// Add a name here ONLY after deciding it belongs on the presence surface: a `sockets > 0` membership
	// boolean under any name (isHere, present, active, …) reds this by construction.
	const ALLOWED = ['connect', 'disconnect', 'evaluate', 'forget', 'online', 'sockets', 'stateOf'];
	expect([...publicMethods]).toEqual([...ALLOWED].sort());
});

it('membership: the discredited socket-count predicate stays deleted — no method RETURNS a bare sockets-based membership predicate, under any name', () => {
	// Ban the SHAPE, not the deleted literal, and cover arrow bodies too: a `return`-only ban is blind to
	// `isHere = (id) => (…sockets…) > 0`. The negative lookahead exempts online()'s honest
	// `.filter(([, r]) => r.sockets > 0)`, which returns the ID LIST rather than a per-singer boolean.
	const BARE_MEMBERSHIP_BOOL =
		/(?:return\s+|=>\s*)(?!.*\.(?:filter|map|some|every|reduce|find)\s*\()[^\n;]*\bsockets\b[^\n;]*(?:>\s*0|>=\s*1|!==?\s*0)/;
	const BOOLEAN_WRAP = /(?:return\s+|=>\s*)Boolean\s*\([^\n;]*\bsockets\b/;
	// The single-line bans above cannot span a newline, so `const n = …sockets…;` then `return n > 0;` inside an
	// ALREADY-ALLOWLISTED method evades both them and the allowlist. Bind the local to the `sockets` read, then
	// require the comparison on that SAME identifier across lines, following one optional `const b = a;` rebind.
	// The lookahead on the binding RHS exempts list-returning combinators, as BARE_MEMBERSHIP_BOOL does.
	const CONST_INDIRECTION_BOOL =
		/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?![^\n;]*\.(?:filter|map|some|every|reduce|find)\s*\()[^\n;]*\bsockets\b[^\n;]*;(?:[\s\S]*?const\s+([A-Za-z_$][\w$]*)\s*=\s*\1\s*;)?[\s\S]*?(?:return\s+|=>\s*)(?:\2|\1)\s*(?:>\s*0|>=\s*1|!==?\s*0)/;
	expect(source).not.toMatch(BARE_MEMBERSHIP_BOOL);
	expect(source).not.toMatch(BOOLEAN_WRAP);
	expect(source).not.toMatch(CONST_INDIRECTION_BOOL);
});

it('membership: the discredited socket-count predicate stays deleted — only the three change-report methods return a boolean at all (a membership predicate cannot be spelled around the shape ban)', () => {
	// A comparison-text ban is still escapable by `if (…) return true; return false;`, so pin by RETURN TYPE
	// instead: only connect/disconnect/forget legitimately hand back a boolean ("did this change" / "was it
	// there"). Any new boolean returner reds this regardless of body spelling or modifier. evaluate's
	// `=> boolean` sits inside its PARAMETER object and `[^)]*` stops at the first `)`, so it never matches.
	const BOOL_RETURNERS = ['connect', 'disconnect', 'forget'];
	const boolReturners = [
		...classBody.matchAll(/\n\t(?:[a-z]+\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*:\s*(?:Promise<\s*)?boolean/g)
	]
		.map((m) => m[1])
		.sort();
	// Sentinel: a collector regex that matched nothing would otherwise pass the equality below.
	expect(boolReturners.length).toBe(BOOL_RETURNERS.length);
	expect(boolReturners).toEqual([...BOOL_RETURNERS].sort());
});

it('membership: the discredited socket-count predicate stays deleted — the honest membership API is intact', () => {
	expect(source).toMatch(/\bonline\s*\(\s*\)\s*:\s*string\[\]/);
	expect(source).toMatch(/\bsockets\s*\(\s*singerId\s*:\s*string\s*\)\s*:\s*number/);
	expect(source).toMatch(/\bstateOf\s*\(/);
});
