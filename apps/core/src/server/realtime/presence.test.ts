import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
		expect(p.online()).toEqual([]);

		expect(p.connect('s1')).toBe(true); // newly here → broadcast
		expect(p.online()).toEqual(['s1']);

		expect(p.disconnect('s1', NOW)).toBe(true); // newly away → broadcast
		expect(p.online()).toEqual([]);
	});

	it('ref-counts multiple sockets: a second tab does not re-announce, one close does not remove', () => {
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

	it('tracks singers independently and reports arrival order', () => {
		const p = new PresenceTracker();
		p.connect('angelo');
		p.connect('maya');
		p.connect('devon');
		expect(p.online()).toEqual(['angelo', 'maya', 'devon']);

		p.disconnect('maya', NOW);
		expect(p.online()).toEqual(['angelo', 'devon']);
	});

	it('disconnect for an unknown singer is a no-op, not a phantom entry', () => {
		const p = new PresenceTracker();
		expect(p.disconnect('never-connected', NOW)).toBe(false);
		expect(p.online()).toEqual([]);
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
		expect(p.online()).toEqual(['s1']);
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

	it('a reconnect that re-drops inside one sweep interval still gets a full fresh window', () => {
		// The pocket case connect() must handle: a phone wakes on a notification and re-locks before the
		// next 20s membership sweep, so no sweep runs between the reconnect and the re-drop. connect()
		// clears the running clock outright (awaySince + clockStartedAt), so the re-drop starts a fresh
		// window. If connect() only paused (or did nothing), the stale start time would carry over and
		// the next sweep would expire her a full grace window early — the exact bug this pins.
		const p = new PresenceTracker();
		p.connect('dana');
		p.disconnect('dana', NOW);
		sweep(p, NOW, noSongs); // clock starts at NOW

		// she reconnects most of the way through the window, then re-drops WITHOUT any sweep in between
		const back = NOW + GRACE - 1000;
		p.connect('dana');
		const redrop = back; // re-locks immediately; no sweep has cleared the stale clock
		p.disconnect('dana', redrop);

		// She is observed away right after the re-drop (redrop is GRACE - 1000, so even a carried-over
		// clock reads below grace here — this sweep is the fixture, not the discriminator).
		expect(sweep(p, redrop, noSongs).away).toEqual(['dana']);
		// THE DISCRIMINATOR: one tick before a fresh window would expire, she must still be away. A
		// carried-over clockStartedAt of NOW reads elapsed 2*GRACE - 1001 >= grace here and would have
		// already expired her — a full window early. This is the assertion the connect() cancel pins.
		expect(sweep(p, redrop + GRACE - 1, noSongs).away).toEqual(['dana']);
		// ...and she does expire once the fresh window is fully spent (so the test also demands that a
		// clock exists at all, not merely that no expiry happened).
		expect(sweep(p, redrop + GRACE, noSongs).gone).toEqual(['dana']);
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

describe('membership: the discredited socket-count predicate stays deleted', () => {
	// #126: PresenceTracker.isOnline() and .count() were dead (zero non-test callers) AND isOnline()
	// returned exactly the `sockets > 0` predicate this file's header documents as the ORIGINAL BUG —
	// the locked-phone eviction the three-state here/away/gone policy exists to replace. They were the
	// cheapest-to-reach presence check and were wrong, so their re-introduction is the trap this pins.
	// Deletion has no runtime-observable regression (nothing called them), so guard the SOURCE.
	const stripComments = (src: string) =>
		src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
	const source = stripComments(readFileSync(join(import.meta.dir, 'presence.ts'), 'utf-8'));

	it('does not re-expose isOnline() or count() on PresenceTracker', () => {
		expect(source).not.toMatch(/\bisOnline\s*\(/);
		expect(source).not.toMatch(/\bcount\s*\(\s*\)/);
	});

	// The public surface of PresenceTracker, name-for-name. This is the invariant #281 pins: membership
	// is answered ONLY through stateOf()/evaluate() (which route through memberState/the three-state
	// policy), never by a method that hands back a raw socket-count boolean. The previous guard pinned
	// the DELETED BODY TEXT of isOnline() (`?? 0) > 0;`), so the same predicate re-added under a new
	// name with a delegating body survived it (see #281's mutation table). These two checks are
	// name-independent: an allowlist reddens on ANY new public method, and a shape ban reddens on the
	// discredited comparison under ANY spelling.
	const CLASS_START = 'class PresenceTracker';
	const classBody = source.slice(source.indexOf(CLASS_START));
	// Class-member declarations are indented one tab; a name is harvested whether it is followed by
	// `(` (method shorthand) OR `=` (an arrow class property — `isHere = (id) => …`), which is the form
	// #347's blocking review proved escaped a `(`-only collector. A leading access/declaration modifier
	// (`public`/`private`/`protected`/`readonly`/`static`) is SKIPPED before the name capture — without
	// that skip the collector harvests the modifier itself as the member name (`public sockets(…)` →
	// `public`), a false RED unrelated to any membership predicate (#417). Interface fields and private
	// #members are not matched (# prefix, and the interface lives above the class start). Reads names off
	// the source so the test cannot derive its expectation the way the class does.
	const MEMBER_MODIFIERS = /(?:public|private|protected|readonly|static)\s+/.source;
	const publicMethods = [
		...classBody.matchAll(new RegExp(`\\n\\t(?:${MEMBER_MODIFIERS})*([A-Za-z_$][\\w$]*)\\s*(?:\\(|=)`, 'g'))
	]
		.map((m) => m[1])
		.sort();

	it('exposes ONLY the allowlisted public methods (a rename cannot slip a membership predicate in)', () => {
		// Add a method here ONLY after deciding it belongs on the presence surface. A `sockets > 0`
		// membership boolean under any name (isHere, present, active, …) reddens this by construction —
		// which is exactly the copy-paste-and-rename trap #126's deleted isOnline() left open.
		const ALLOWED = ['connect', 'disconnect', 'evaluate', 'forget', 'online', 'sockets', 'stateOf'];
		expect([...publicMethods]).toEqual([...ALLOWED].sort());
	});

	it('no method RETURNS a bare sockets-based membership predicate, under any name', () => {
		// Ban the SHAPE, not the deleted literal: a value that IS `<…sockets…> > 0` (or >= 1, !== 0,
		// != 0, or Boolean(<…sockets…>)), reached via `return …` OR an arrow expression body `=> …`
		// (#347's review proved a `return`-only ban is blind to `isHere = (id) => (…sockets…) > 0`).
		// The negative lookahead exempts online()'s honest `.filter(([, r]) => r.sockets > 0)` — that
		// returns the ID LIST, not a per-singer boolean. A getter/static/computed-key membership
		// predicate is not name-collected (its name is not in method/arrow position) but is caught here.
		const BARE_MEMBERSHIP_BOOL =
			/(?:return\s+|=>\s*)(?!.*\.(?:filter|map|some|every|reduce|find)\s*\()[^\n;]*\bsockets\b[^\n;]*(?:>\s*0|>=\s*1|!==?\s*0)/;
		const BOOLEAN_WRAP = /(?:return\s+|=>\s*)Boolean\s*\([^\n;]*\bsockets\b/;
		// Const-indirection hop (#417): the single-line bans above cannot span a newline, so a membership
		// bool smuggled into an ALREADY-ALLOWLISTED bool-returner via a local const —
		// `const n = …sockets…;` then `return n > 0;` (or `>= 1`, `!== 0`) — evaded both the shape ban
		// (name allowed, comparison text on a different line from `sockets`) and the allowlist (the name is
		// legitimate). Bind the local to the `sockets` read, then require a return/arrow comparison on that
		// SAME identifier; `[\s\S]*?` (lazy) lets the two sit on different lines within the method body.
		const CONST_INDIRECTION_BOOL =
			/const\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n;]*\bsockets\b[^\n;]*;[\s\S]*?(?:return\s+|=>\s*)\1\s*(?:>\s*0|>=\s*1|!==?\s*0)/;
		expect(source).not.toMatch(BARE_MEMBERSHIP_BOOL);
		expect(source).not.toMatch(BOOLEAN_WRAP);
		expect(source).not.toMatch(CONST_INDIRECTION_BOOL);
	});

	it('only the three change-report methods return a boolean at all (a membership predicate cannot be spelled around the shape ban)', () => {
		// The shape ban above pins the sockets>0 COMPARISON TEXT after return/=>, so the same predicate
		// written in an `if (…) return true; return false;` or behind a `const n = …; return n > 0;` (see
		// #353's M1/M2) — or on a method declared with a leading modifier the name-collector misses (M3/M4,
		// `public`/`async`) — slips through. Pin the INVARIANT by RETURN TYPE instead of by comparison text:
		// a membership answer is a boolean, and only connect/disconnect/forget legitimately hand one back
		// (they report "did this change" / "was it there"; membership itself is answered via stateOf/evaluate,
		// which route through the three-state here/away/gone policy). Any new boolean-returning method reddens
		// this REGARDLESS of body spelling or method-declaration modifier, so it needs no #-of-positions chase.
		// The `(?:[a-z]+\s+)*` prefix is modifier-proof (public/async/static/override); `Promise<` covers an
		// async predicate. Non-boolean returners are exempt by their return type: online(): string[],
		// sockets(): number, stateOf(): MemberState, evaluate(): MembershipSnapshot. evaluate's `=> boolean`
		// appears only inside its PARAMETER object, so `[^)]*` (which stops at the first `)`) never reaches it.
		const BOOL_RETURNERS = ['connect', 'disconnect', 'forget'];
		const boolReturners = [
			...classBody.matchAll(/\n\t(?:[a-z]+\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*:\s*(?:Promise<\s*)?boolean/g)
		]
			.map((m) => m[1])
			.sort();
		// Not-vacuous sentinel: the collector must actually find the honest boolean returners — a broken
		// regex that matched nothing would pass the equality below only if BOOL_RETURNERS were also empty.
		expect(boolReturners.length).toBe(BOOL_RETURNERS.length);
		expect(boolReturners).toEqual([...BOOL_RETURNERS].sort());
	});

	it('the honest membership API is intact', () => {
		expect(source).toMatch(/\bonline\s*\(\s*\)\s*:\s*string\[\]/);
		expect(source).toMatch(/\bsockets\s*\(\s*singerId\s*:\s*string\s*\)\s*:\s*number/);
		expect(source).toMatch(/\bstateOf\s*\(/);
	});
});
