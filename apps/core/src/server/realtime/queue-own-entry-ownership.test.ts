// Issue #241: `queue:remove-any` / `queue:reorder-any` were asked for EVERY remove/move, including a
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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateCommand, type HubDeps } from './hub';
import { AuthoritativeState } from '../state/store';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry, type ClientCommand } from '@encore/shared';

const media = (id: string): Media => ({
	id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100,
	stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac',
	songProfile: EMPTY_SONG_PROFILE
});

const entry = (id: string, singerId: string): QueueEntry => ({
	id, mediaId: 'm1', singerId, status: 'queued', rotationSeq: 0, addedAt: 1
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

test('an unknown entry rejects before any ownership/capability check', () => {
	expect(validateCommand(cmd({ op: 'remove', id: 'ghost' }), harness())).toBe('unknown entry: ghost');
});

// (2) Source-scan: the ownership short-circuit must precede the can() gate in BOTH arms, so a future
// narrowed can() can never refuse an owner their own song. This is the load-bearing narrowing proof.
const hubSrc = readFileSync(fileURLToPath(new URL('./hub.ts', import.meta.url)), 'utf-8');

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

// The ownership short-circuit: an inequality between the target entry's singerId and the actor's.
const ownershipGuard = (v: string) =>
	new RegExp(`${v}\\.singerId\\s*!==\\s*deps\\.actorSingerId`);

test("the 'remove' arm reaches can('queue:remove-any') only for a NON-owner entry", () => {
	const arm = switchArm(hubSrc, 'remove');
	// ownership comparison present, and it appears BEFORE the can() gate (guards it)
	const ownerIdx = arm.search(ownershipGuard('\\w+'));
	const canIdx = arm.indexOf("can({ singerId: deps.actorSingerId }, 'queue:remove-any')");
	expect(ownerIdx).toBeGreaterThan(-1);
	expect(canIdx).toBeGreaterThan(-1);
	expect(ownerIdx).toBeLessThan(canIdx);
});

test("the 'move' arm reaches can('queue:reorder-any') only for a NON-owner entry", () => {
	const arm = switchArm(hubSrc, 'move');
	const ownerIdx = arm.search(ownershipGuard('\\w+'));
	const canIdx = arm.indexOf("can({ singerId: deps.actorSingerId }, 'queue:reorder-any')");
	expect(ownerIdx).toBeGreaterThan(-1);
	expect(canIdx).toBeGreaterThan(-1);
	expect(ownerIdx).toBeLessThan(canIdx);
});
