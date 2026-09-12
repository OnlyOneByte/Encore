// `queue:remove-any` / `queue:reorder-any` were asked for EVERY remove/move, including a
// singer's OWN entry. can() ignores the capability TODAY (Boolean(actor?.singerId)), so nothing breaks
// now — but capabilities.ts:9-11 exists precisely so can() can later be narrowed to a host role, and
// the moment it is, gating every remove through the -any capability would refuse a singer their OWN
// song (the capability is declared "remove/reorder SOMEONE ELSE'S entry"). The fix reaches can() ONLY
// when the target entry belongs to a DIFFERENT singer.
//
// This file proves the fix two ways, both WITHOUT mocking the capabilities module (a top-level
// mock.module replaces the process-global module registry for the whole `bun test` run and deadlocks
// the runner when a later file imports the real module — so it is deliberately avoided here):
//
//   (1) BEHAVIOURAL, against the REAL can(): with today's capability-ignoring can() every joined singer
//       may act on any entry, so own AND other remove/reorder both succeed and an unknown entry still
//       rejects — proving the fix is behaviour-preserving on the current policy and did not close the
//       door on removing someone else's entry.
//
//   (2) SOURCE-SCAN over hub.ts (the load-bearing narrowing proof): the whole point is that the
//       ownership check must SHORT-CIRCUIT BEFORE can(), so a future narrowed host-only can() cannot
//       refuse a singer their own song. Assert that in BOTH the remove and move arms an ownership
//       comparison (`<target>.singerId !== deps.actorSingerId`) guards the `can(...)` gate — i.e. can()
//       is unreachable for an owner. Reverting hub.ts to base (gate not wrapped) reds these.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { validateCommand, type HubDeps } from '$server/realtime/hub';
import { AuthoritativeState } from '$server/state/store';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry, type ClientCommand } from '$shared';

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

// (1) Behavioural, against the real can(): today every joined singer holds every capability, so both
// own and other remove/reorder are allowed. This pins that the fix preserves current behaviour and did
// NOT accidentally hide the removal of someone else's entry.
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

// step 4: move-to-index is the CROSS-SINGER reorder. Same ownership scope as `move` — own entry
// needs no capability, another singer's is gated on queue:reorder-any (reachable under today's can()).
test('with the current policy a singer may move-to-index their OWN entry', () => {
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'own1', toIdx: 0 }), harness())).toBeNull();
});

test('with the current policy a singer may move-to-index SOMEONE ELSE\u2019S entry across singers', () => {
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'other1', toIdx: 0 }), harness())).toBeNull();
});

test('move-to-index rejects a non-integer toIdx at the seam', () => {
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'own1', toIdx: 1.5 }), harness())).toBe('invalid toIdx: 1.5');
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'own1', toIdx: NaN as number }), harness())).toBe('invalid toIdx: NaN');
});

test('move-to-index on an unknown entry rejects before any ownership/capability check', () => {
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'ghost', toIdx: 0 }), harness())).toBe('unknown entry: ghost');
});

test('an unknown entry rejects before any ownership/capability check', () => {
	expect(validateCommand(cmd({ op: 'remove', id: 'ghost' }), harness())).toBe('unknown entry: ghost');
});

// (2) Source-scan: the ownership short-circuit must precede the can() gate in BOTH arms, so a future
// narrowed can() can never refuse an owner their own song. This is the load-bearing narrowing proof.
const hubSrc = read('apps/core/src/server/realtime/hub.ts');

// Strip comments so the explanatory prose (which mentions can() and the capability strings) can neither
// satisfy nor trip the checks.
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// Slice a single `case '<op>':` arm up to the next `case '`/`default:` label.
function switchArm(src: string, op: string): string {
	const body = stripComments(src);
	const label = `case '${op}':`;
	const start = body.indexOf(label);
	expect(start).toBeGreaterThan(-1); // non-vacuous: the arm must exist
	const after = body.slice(start + label.length);
	const next = after.search(/\n\s*(case '|default:)/);
	expect(next).toBeGreaterThan(-1); // arm must be bounded by a following label
	return after.slice(0, next);
}

// The ownership short-circuit that must GATE can(): can() is reachable ONLY for a NON-owner entry.
// Two behaviour-identical spellings both satisfy this and both must pass:
//   (i)  ENCLOSING form  — `if (<var>.singerId !== deps.actorSingerId) { ... can(...) ... }` — can()
//        lives INSIDE the "not my entry" block, so an owner never reaches it.
//   (ii) EARLY-RETURN form — `if (<var>.singerId === deps.actorSingerId) return null;` before the gate
//        — an owner short-circuits out, so can() is likewise unreachable for an owner.
// the previous assertion only required an ownership *substring* to appear EARLIER in the arm
// text than the can() substring. Text order is not enclosure: hoisting the comparison into a `const`
// used for an audit log (owner still falls through to can()) keeps "before" true while breaking the
// property, and rewriting the guard to the (ii) early-return form (which STRENGTHENS the property)
// reds the ordering check. Assert ENCLOSURE instead, so the (a) un-nesting reds and (b) the refactor
// passes.

// Find the char index at which the block opened by the ownership `if (...) {` on `openRe` closes,
// by brace-matching from the `{` that follows the match. Returns [openIdx, closeIdx) or null.
function enclosingOwnershipBlock(arm: string, actorVar: string): [number, number] | null {
	// `if (<var>.singerId !== deps.actorSingerId) {`  (ENCLOSING form only — the `{` is required)
	const openRe = new RegExp(`if\\s*\\(\\s*${actorVar}\\.singerId\\s*!==\\s*deps\\.actorSingerId\\s*\\)\\s*\\{`);
	const m = openRe.exec(arm);
	if (!m) return null;
	// The matched text ends with the opening brace; brace-match from there.
	let depth = 0;
	for (let i = m.index + m[0].length - 1; i < arm.length; i++) {
		if (arm[i] === '{') depth++;
		else if (arm[i] === '}') {
			depth--;
			if (depth === 0) return [m.index, i + 1];
		}
	}
	return null; // unbalanced — treated as no enclosure
}

// The (ii) owner early-return: `if (<var>.singerId === deps.actorSingerId) return null;`
const ownerEarlyReturn = (v: string) =>
	new RegExp(`if\\s*\\(\\s*${v}\\.singerId\\s*===\\s*deps\\.actorSingerId\\s*\\)\\s*return\\s+null`);

// can() is unreachable for an owner iff EITHER the can() call is enclosed by the "not my entry" block,
// OR an owner early-return precedes the can() call. `\w+` matches whatever local the arm binds the
// target entry to (removeTarget / moveTarget).
function canGatedByOwnership(arm: string, canCall: string): boolean {
	const canIdx = arm.indexOf(canCall);
	if (canIdx < 0) return false;
	// (i) enclosing block that contains the can() call
	const block = enclosingOwnershipBlock(arm, '\\w+');
	if (block && canIdx > block[0] && canIdx < block[1]) return true;
	// (ii) owner early-return before the can() call
	const er = ownerEarlyReturn('\\w+').exec(arm);
	if (er && er.index < canIdx) return true;
	return false;
}

test("the 'remove' arm reaches can('queue:remove-any') only for a NON-owner entry", () => {
	const arm = switchArm(hubSrc, 'remove');
	const canCall = "can({ singerId: deps.actorSingerId }, 'queue:remove-any')";
	// non-vacuous: the gate must be present at all
	expect(arm.indexOf(canCall)).toBeGreaterThan(-1);
	// load-bearing: an owner must never reach can() — the gate is enclosed by (or preceded by an
	// early-return from) the ownership short-circuit, not merely textually after an ownership mention.
	expect(canGatedByOwnership(arm, canCall)).toBe(true);
});

test("the 'move' arm reaches can('queue:reorder-any') only for a NON-owner entry", () => {
	const arm = switchArm(hubSrc, 'move');
	const canCall = "can({ singerId: deps.actorSingerId }, 'queue:reorder-any')";
	expect(arm.indexOf(canCall)).toBeGreaterThan(-1);
	expect(canGatedByOwnership(arm, canCall)).toBe(true);
});

test("the 'move-to-index' arm reaches can('queue:reorder-any') only for a NON-owner entry", () => {
	const arm = switchArm(hubSrc, 'move-to-index');
	const canCall = "can({ singerId: deps.actorSingerId }, 'queue:reorder-any')";
	expect(arm.indexOf(canCall)).toBeGreaterThan(-1); // non-vacuous: the gate must be present
	expect(canGatedByOwnership(arm, canCall)).toBe(true); // owner never reaches can()
});
