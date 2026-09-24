// guard: `queue:remove-any` / `queue:reorder-any` mean "remove/reorder SOMEONE ELSE'S entry". can() ignores
// the capability today (it is `Boolean(actor?.singerId)`), so nothing breaks now — but the moment can() is
// narrowed to a host role, asking for the -any capability on a singer's OWN entry refuses them their own
// song. So the ownership check must SHORT-CIRCUIT BEFORE can(): a behavioural half against the REAL can()
// plus a source scan over hub.ts. The capabilities module is deliberately NOT mocked — a top-level
// mock.module replaces the process-global registry for the whole run and deadlocks the runner.
import { test, expect } from 'bun:test';
import { read } from '$test';
import { validateCommand, type HubDeps } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry, type ClientCommand } from '$lib/contract';
import { stripComments } from '$test';

const media = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: 'derived/stems/i-instrumental.flac',
	songProfile: EMPTY_SONG_PROFILE
});

const entry = (id: string, singerId: string): QueueEntry => ({
	id,
	mediaId: 'm1',
	singerId,
	status: 'queued',
	rotationSeq: 0,
	addedAt: 1
});

function harness(actorSingerId = 's-self') {
	const state = new AuthoritativeState();
	state.hydrate([entry('own1', actorSingerId), entry('other1', 's-other')], null);
	const deps: HubDeps = {
		state,
		publish: () => {},
		mediaById: new Map([['m1', media('m1')]]),
		actorSingerId
	};
	return deps;
}

const cmd = (op: ClientCommand['op']): ClientCommand => ({ clientOpId: 'c1', op });

// (1) Behavioural: today every joined singer holds every capability, so own AND other both succeed. This pins
// that the short-circuit did not accidentally hide the removal of someone else's entry.
test('with the current policy a singer may remove their OWN entry', () => {
	expect(validateCommand(cmd({ op: 'remove', id: 'own1' }), harness())).toBeNull();
});

test('with the current policy a singer may remove SOMEONE ELSE\u2019S entry (still reachable)', () => {
	expect(validateCommand(cmd({ op: 'remove', id: 'other1' }), harness())).toBeNull();
});

test('with the current policy a singer may reorder their OWN entry', () => {
	expect(validateCommand(cmd({ op: 'move', id: 'own1', toSeq: 0 }), harness())).toBeNull();
});

test('with the current policy a singer may reorder SOMEONE ELSE\u2019S entry (still reachable)', () => {
	expect(validateCommand(cmd({ op: 'move', id: 'other1', toSeq: 0 }), harness())).toBeNull();
});

// move-to-index is the CROSS-SINGER reorder, with the same ownership scope as `move`.
test('with the current policy a singer may move-to-index their OWN entry', () => {
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'own1', toIdx: 0 }), harness())).toBeNull();
});

test('with the current policy a singer may move-to-index SOMEONE ELSE\u2019S entry across singers', () => {
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'other1', toIdx: 0 }), harness())).toBeNull();
});

test('move-to-index rejects a non-integer toIdx at the seam', () => {
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'own1', toIdx: 1.5 }), harness())).toBe('invalid toIdx: 1.5');
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'own1', toIdx: NaN as number }), harness())).toBe(
		'invalid toIdx: NaN'
	);
});

test('move-to-index on an unknown entry rejects before any ownership/capability check', () => {
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'ghost', toIdx: 0 }), harness())).toBe('unknown entry: ghost');
});

test('an unknown entry rejects before any ownership/capability check', () => {
	expect(validateCommand(cmd({ op: 'remove', id: 'ghost' }), harness())).toBe('unknown entry: ghost');
});

// (2) Source-scan: the load-bearing narrowing proof, because can() ignores its capability today — an owner
// who wrongly falls through to can() is still allowed, so behaviour cannot tell the two apart until can() is
// narrowed to a host role, at which point a singer loses their own song.
//
// THIS NO LONGER SLICES SWITCH ARMS. It used to brace-match an ownership `if` inside each of three
// `case` arms, which pinned three copies of the check in place and blocked collapsing them into one gate.
// With a single gate the property is simpler AND stronger to state: in the one function that gates, the
// ownership answer is reached BEFORE can() is consulted.
const hubSrc = read('src/lib/server/realtime/hub.ts');

/** The body of the one function that gates every entry op. */
function gateBody(): string {
	const src = stripComments(hubSrc, { drop: true });
	const start = src.indexOf('function entryOpRefusal');
	expect(
		start,
		'entryOpRefusal not found — this guard asserts the ONE gate, so its absence is the finding'
	).toBeGreaterThan(-1);
	const rest = src.slice(start);
	const end = rest.indexOf('\n}');
	expect(end).toBeGreaterThan(-1);
	return rest.slice(0, end);
}

test('the ONE gate decides ownership before it consults can()', () => {
	const body = gateBody();
	const canIdx = body.search(/\bcan\(/);
	expect(canIdx, 'the gate does not consult can() at all').toBeGreaterThan(-1);
	// An owner must LEAVE before can(). Either spelling passes — an early `return null` on match, or a
	// `!==` block enclosing the call — because which one is used is not a property worth defending.
	const early = /if\s*\(\s*\w+\.singerId\s*===\s*deps\.actorSingerId\s*\)\s*return\s+null/.exec(body);
	const enclosing = /if\s*\(\s*\w+\.singerId\s*!==\s*deps\.actorSingerId\s*\)\s*\{/.exec(body);
	const ownershipIdx = early ? early.index : enclosing ? enclosing.index : -1;
	expect(
		ownershipIdx,
		'no ownership comparison against deps.actorSingerId in the gate — every singer would be asked for the ' +
			'-any capability on their OWN entry, and a narrowed can() would then refuse them their own song'
	).toBeGreaterThan(-1);
	expect(ownershipIdx, 'the ownership check does not precede can()').toBeLessThan(canIdx);
});

test('the unknown-entry refusal precedes both, so a ghost id is never a permission answer', () => {
	const body = gateBody();
	const unknown = body.indexOf('unknown entry');
	expect(unknown, 'the gate no longer refuses an unknown entry by name').toBeGreaterThan(-1);
	expect(unknown).toBeLessThan(body.search(/\bcan\(/));
	expect(unknown).toBeLessThan(body.search(/singerId\s*[!=]==\s*deps\.actorSingerId/));
});
