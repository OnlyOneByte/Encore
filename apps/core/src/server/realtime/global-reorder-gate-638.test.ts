// Issue #638: the HOST global reorder (`move-global` / `unpin`) is gated on `queue:reorder-any` in
// hub.ts validateCommand. Unlike the per-singer `move`, ownership of the target is IRRELEVANT: pinning
// ANY entry to a global slot rearranges the whole room's order and can jump other singers, which is
// exactly the power that capability names — so the arm consults can() unconditionally, never the owner
// short-circuit. Today can() is Boolean(actor?.singerId) (every joined singer is a host), so a joined
// singer may pin any entry and a socket that never joined may not.
//
// Proven two ways WITHOUT mocking the capabilities module (a top-level mock.module deadlocks the
// runner — see queue-own-entry-ownership.test.ts): (1) behavioural against the real can(); (2) a
// source-scan that the move-global/unpin arm reaches can() and does NOT gate itself behind an owner
// comparison. Reverting hub.ts to base reds both — base has no move-global arm at all, so the op falls
// to the default arm and returns "unknown op".
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateCommand, type HubDeps } from './hub';
import { AuthoritativeState } from '../state/store';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry, type ClientCommand } from '@encore/shared';

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

function harness({ joined = true }: { joined?: boolean } = {}): HubDeps {
	// `joined:false` models a socket that never joined — actorSingerId is genuinely undefined. A default
	// parameter would swallow an explicit `undefined` back into 's-self', so joining is a boolean flag.
	const actorSingerId = joined ? 's-self' : undefined;
	const state = new AuthoritativeState();
	state.hydrate([entry('own1', 's-self'), entry('other1', 's-other')], null);
	const deps: HubDeps = {
		state,
		publish: () => {},
		mediaById: new Map([['m1', media('m1')]]),
		actorSingerId
	};
	return deps;
}

const cmd = (op: ClientCommand['op']): ClientCommand => ({ clientOpId: 'c1', op });

// (1) Behavioural — real can()
test('a joined singer may move-global SOMEONE ELSE\u2019S entry (the cross-singer power)', () => {
	expect(validateCommand(cmd({ op: 'move-global', id: 'other1', toSeq: 0 }), harness())).toBeNull();
});

test('a joined singer may move-global their OWN entry to a global slot', () => {
	expect(validateCommand(cmd({ op: 'move-global', id: 'own1', toSeq: 2 }), harness())).toBeNull();
});

test('a joined singer may unpin any entry', () => {
	expect(validateCommand(cmd({ op: 'unpin', id: 'other1' }), harness())).toBeNull();
});

test('a socket that never joined (no singerId) may NOT move-global — rejected at the identity gate', () => {
	// The top-level `if (!deps.actorSingerId) return 'join the room first'` fires before the arm, which
	// is the pre-existing "you must be a person in the room" gate (capabilities.ts). That is the seam a
	// future host-only can() narrows; today the reorder-any check inside the arm only becomes reachable
	// once a JOINED singer is refused, which no policy does yet.
	expect(validateCommand(cmd({ op: 'move-global', id: 'own1', toSeq: 0 }), harness({ joined: false }))).toBe(
		'join the room first'
	);
});

test('a socket that never joined may NOT unpin', () => {
	expect(validateCommand(cmd({ op: 'unpin', id: 'own1' }), harness({ joined: false }))).toBe('join the room first');
});

test('an unknown entry rejects before the capability check', () => {
	expect(validateCommand(cmd({ op: 'move-global', id: 'ghost', toSeq: 0 }), harness())).toBe('unknown entry: ghost');
});

// (2) Source-scan: the move-global/unpin arm must consult can() with the reorder-any capability, and
// must NOT be guarded by an owner short-circuit (its scope is global, not "someone else's entry"). This
// is the load-bearing distinction from the per-singer `move` arm above it.
const hubSrc = readFileSync(fileURLToPath(new URL('./hub.ts', import.meta.url)), 'utf-8');

test('SOURCE: the move-global/unpin arm consults can(...,"queue:reorder-any")', () => {
	// slice the combined case arm out of the file, comment-agnostic enough for this assertion
	const armStart = hubSrc.indexOf("case 'move-global':");
	expect(armStart).toBeGreaterThan(-1);
	const armEnd = hubSrc.indexOf("case 'status':", armStart);
	expect(armEnd).toBeGreaterThan(armStart);
	const arm = hubSrc.slice(armStart, armEnd);
	expect(arm).toMatch(/can\(\s*\{\s*singerId:\s*deps\.actorSingerId\s*\}\s*,\s*'queue:reorder-any'\s*\)/);
	// and it is NOT gated behind an owner comparison — no `.singerId !== deps.actorSingerId` short-circuit
	// in this arm, unlike the per-singer `move` arm.
	expect(arm).not.toMatch(/singerId\s*!==\s*deps\.actorSingerId/);
});
