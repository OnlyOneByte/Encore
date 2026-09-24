// guard: `queue:remove-any` / `queue:reorder-any` mean "remove/reorder SOMEONE ELSE'S entry". can() ignores
// the capability today (it is `Boolean(actor?.singerId)`), so nothing breaks now — but the moment can() is
// narrowed to a host role, asking for the -any capability on a singer's OWN entry refuses them their own
// song. So the ownership check must SHORT-CIRCUIT BEFORE can(): a behavioural half against the REAL can()
// plus a source scan over hub.ts. The capabilities module is deliberately NOT mocked — a top-level
// mock.module replaces the process-global registry for the whole run and deadlocks the runner.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { validateCommand, type HubDeps } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry, type ClientCommand } from '$lib/contract';

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

// (2) Source-scan: the load-bearing narrowing proof. Comments are blanked because hub.ts's own prose mentions
// can() and the capability strings.
const hubSrc = read('src/lib/server/realtime/hub.ts');

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

// ENCLOSURE, not text order, is the property: a mere "ownership mention appears before can()" check passes when
// the comparison is hoisted into a const for an audit log while the owner still falls through to can(), and it
// reds on the early-return refactor, which actually strengthens the property. Two spellings must both pass:
//   (i)  ENCLOSING    — `if (<var>.singerId !== deps.actorSingerId) { … can(…) … }`
//   (ii) EARLY-RETURN — `if (<var>.singerId === deps.actorSingerId) return null;` before the gate

// Brace-match from the `{` after the ownership `if`. Returns [openIdx, closeIdx) or null.
function enclosingOwnershipBlock(arm: string, actorVar: string): [number, number] | null {
	// ENCLOSING form only — the `{` is required.
	const openRe = new RegExp(`if\\s*\\(\\s*${actorVar}\\.singerId\\s*!==\\s*deps\\.actorSingerId\\s*\\)\\s*\\{`);
	const m = openRe.exec(arm);
	if (!m) return null;
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

const ownerEarlyReturn = (v: string) =>
	new RegExp(`if\\s*\\(\\s*${v}\\.singerId\\s*===\\s*deps\\.actorSingerId\\s*\\)\\s*return\\s+null`);

// `\w+` matches whatever local the arm binds the target entry to (removeTarget / moveTarget).
function canGatedByOwnership(arm: string, canCall: string): boolean {
	const canIdx = arm.indexOf(canCall);
	if (canIdx < 0) return false;
	const block = enclosingOwnershipBlock(arm, '\\w+');
	if (block && canIdx > block[0] && canIdx < block[1]) return true;
	const er = ownerEarlyReturn('\\w+').exec(arm);
	if (er && er.index < canIdx) return true;
	return false;
}

test("the 'remove' arm reaches can('queue:remove-any') only for a NON-owner entry", () => {
	const arm = switchArm(hubSrc, 'remove');
	const canCall = "can({ singerId: deps.actorSingerId }, 'queue:remove-any')";
	expect(arm.indexOf(canCall)).toBeGreaterThan(-1); // non-vacuous: the gate must be present at all
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
