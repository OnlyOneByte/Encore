// Regression: "Next up" named a song that would NOT be played next.
//
// `nowplaying:changed` is what the TV's Up next strip, the full-screen Next up card and the gapless
// preload slot all read (routes/tv/+page.svelte: `applyNowPlaying` is its only writer). It had exactly
// two BROADCAST producers, both playback transitions in player.ts — `reconcileOnReady` and
// `handlePlayerCommand`. A QUEUE mutation produced none: `handleQueueCommand` publishes `queue:patch`
// alone (hub.ts), and apps/core/server.ts's `queue:command` arm only called `reconcileOnReady` when the
// current entry no longer RESOLVED — i.e. only when the room was idle or the playing entry had been
// pruned.
//
// So while a song plays, an add / remove / move changes WHO PLAYS NEXT and nothing re-broadcasts it.
// The TV keeps rendering the previous `upNext` until the song ends: it can name a song that has been
// removed from the queue, or one that reordering pushed behind another singer, and `syncSlots`
// pre-warms the hidden gapless slot from that same stale entry.
//
// This is taxonomy shape 3 (docs/loop/COMMON.md), "transitions handled where steady state was": the
// invariant "the advertised next equals the true next" was maintained across every PLAYBACK transition
// and across none of the QUEUE transitions.
//
// The fix is the `else emitNowPlaying(deps)` on that gate in apps/core/server.ts — the branch the `if`
// deliberately excludes, which is exactly the reported window (a song IS playing, so no recovery is
// due). Two halves are needed to pin it, and both are here:
//
//  1. BEHAVIOURAL (below): drive the real `handleQueueCommand` + `AuthoritativeState` + `emitNowPlaying`
//     and require the broadcast `upNext` to track the truth across three queue transitions. This pins
//     what `emitNowPlaying` at this seam must produce — including that a still-COOKING entry at the
//     head of the rotation is never advertised — but NOT that server.ts calls it, because server.ts is
//     the Bun.serve entry and has no unit harness (telemetry-frame-lean.test.ts:15). Taken alone this
//     half is vacuous with respect to the production line, which is why half 2 exists.
//  2. SOURCE SCAN (bottom): pin the `else emitNowPlaying(deps)` and its import on the live writer,
//     apps/core/server.ts. server.ts contains no `emitNowPlaying` on base, so this half is RED on base
//     and it is what makes the production hunks mutation-proven. Same technique as
//     dangling-current-entry.test.ts (the recovery gate on this very line) and
//     session-cookie-attributes.test.ts.
//
// EXPECTED VALUES ARE HARD-CODED entry ids ('q3', null, 'q4', never 'q2'), never re-derived by calling
// `upNextAfter` — a test that recomputed the projection with the same function the code uses could not
// detect a wrong projection at all.
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from '$server/realtime/hub';
import { reconcileOnReady, emitNowPlaying } from '$server/realtime/player';
import { AuthoritativeState } from '$server/state/store';
import { EMPTY_SONG_PROFILE } from '@encore/shared';
import { type ServerEvent, type Media, type QueueEntry, type ClientCommand } from '@encore/shared';

/** A finished song: both required gates done (readyToSing → true), so rotation will play it. */
const readyMedia = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.flac`,
	songProfile: EMPTY_SONG_PROFILE
});

/**
 * A song still COOKING: no instrumental yet, so the stems gate is open and `readyToSing` is false.
 * An entry on this media is SKIP-DESTINED — `upNextAfter` holds its slot and walks past it — which is
 * the queue head this issue is about: it must never be advertised as the song that plays next.
 */
const cookingMedia = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	// 'queued' = the stems job is filed but has not produced an instrumental, so the stems gate is
	// open (gates.ts: `stemStatus === 'ready' && !!instrumentalRef`). instrumentalRef is OPTIONAL on
	// Media, so a cooking song simply has none — omitted rather than null.
	stemStatus: 'queued',
	lyricsStatus: 'queued',
	songProfile: EMPTY_SONG_PROFILE
});

let _s = 0;
const addCmd = (id: string, mediaId: string, singerId: string): ClientCommand => ({
	clientOpId: 'add-' + id + '-' + ++_s,
	op: {
		op: 'add',
		entry: { id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: ++_s } as QueueEntry
	}
});
const removeCmd = (id: string): ClientCommand => ({ clientOpId: 'rm-' + id + '-' + ++_s, op: { op: 'remove', id } });

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([
			['m-ready-1', readyMedia('m-ready-1')],
			['m-cooking', cookingMedia('m-cooking')],
			['m-ready-3', readyMedia('m-ready-3')],
			['m-ready-4', readyMedia('m-ready-4')]
		]),
		actorSingerId: 's1'
	};
	return { published, state, deps };
}

/** The advertised next: the `upNext` of the LAST `nowplaying:changed` a client would have received. */
function advertisedUpNextId(published: ServerEvent[]): string | null | undefined {
	const np = published.filter((e) => e.type === 'nowplaying:changed').at(-1) as
		Extract<ServerEvent, { type: 'nowplaying:changed' }> | undefined;
	if (!np) return undefined; // nothing was ever broadcast — the client holds whatever it had
	return np.current === null && np.upNext === null ? null : (np.upNext?.id ?? null);
}

/**
 * server.ts's `queue:command` arm as it stands AFTER the consolidation: an UNCONDITIONAL reconcileOnReady. The
 * re-emit still happens on the "current resolves" path — reconcileOnReady skips its recovery
 * block and falls through to the single emitNowPlaying at its tail (player.ts) — which is why the
 * hand-written `else emitNowPlaying(deps)` this arm used to carry was redundant, and why the
 * unconditional call cannot double-broadcast. The recovery predicate is no longer copied here.
 */
function queueCommandArm(cmd: ClientCommand, deps: HubDeps) {
	handleQueueCommand(cmd, deps);
	reconcileOnReady(deps);
}

/**
 * The arm as it stood BEFORE the fix — the recovery gate with no re-emit on the resolves path.
 * A deliberate HISTORICAL characterisation of the defect, not a mirror of production: it keeps the
 * old gate spelling on purpose, which is why the single-source census (nowplaying-single-source.test.ts)
 * scans production files only. `nowplaying-after-queue-command.test.ts` discloses itself here.
 */
function queueCommandArmPreFix(cmd: ClientCommand, deps: HubDeps) {
	handleQueueCommand(cmd, deps);
	if (!deps.state.entries.some((e) => e.id === deps.state.playback.currentEntryId)) reconcileOnReady(deps);
}

test('a queue mutation mid-song re-broadcasts the TRUE next, and never the cooking entry holding the head slot', () => {
	const { state, deps, published } = harness();

	// s2's song is queued FIRST but is still cooking, so it holds the head of the rotation and every
	// "what plays next" answer must walk past it.
	deps.actorSingerId = 's2';
	queueCommandArm(addCmd('q2', 'm-cooking', 's2'), deps);
	// Nothing is playable yet, so the room is idle and there is no next.
	expect(state.playback.currentEntryId).toBeNull();

	// s1's finished song arrives and auto-starts (the room was idle → the recovery branch).
	deps.actorSingerId = 's1';
	queueCommandArm(addCmd('q1', 'm-ready-1', 's1'), deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.playback.isPlaying).toBe(true);
	// q2 keeps its slot but is not singable, so there is still no next.
	expect(advertisedUpNextId(published)).toBeNull();

	// ── Transition 1: an ADD while a song plays. The current entry RESOLVES, so reconcileOnReady's
	// recovery block is NOT entered — only its tail emit runs. This is the reported window.
	deps.actorSingerId = 's3';
	const beforeAdd = published.length;
	queueCommandArm(addCmd('q3', 'm-ready-3', 's3'), deps);
	// The playing entry was untouched, which is what proves no recovery ran: reconcileOnReady only
	// mutates playback when the current id does not resolve. EXACTLY ONE nowplaying:changed — the
	// property that makes the unconditional call safe, since reconcileOnReady's single emit sits
	// outside its recovery block rather than inside each branch.
	expect(state.playback.currentEntryId).toBe('q1');
	expect(published.slice(beforeAdd).filter((e) => e.type === 'nowplaying:changed').length).toBe(1);
	// HARD-CODED: q3 is the true next. q2 sits ahead of it in the rotation and is skipped for now.
	expect(advertisedUpNextId(published)).toBe('q3');
	expect(advertisedUpNextId(published)).not.toBe('q2');

	// ── Transition 2: the advertised song is REMOVED while the same song still plays. Truth becomes
	// "no next" — q2 is still cooking — so the advertised value must not stay q3.
	queueCommandArm(removeCmd('q3'), deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(advertisedUpNextId(published)).toBeNull();

	// ── Transition 3: a new finished song arrives and becomes the true next.
	queueCommandArm(addCmd('q4', 'm-ready-4', 's3'), deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(advertisedUpNextId(published)).toBe('q4');
	// The cooking entry is STILL never advertised, across all three transitions.
	expect(published.filter((e) => e.type === 'nowplaying:changed').every((e) => e.upNext?.id !== 'q2')).toBe(true);
});

test('without the else, a mid-song queue mutation leaves the advertised next naming a song that has left the queue', () => {
	// The defect itself, with the pre-fix arm. This is why the fix belongs at THIS seam: the only
	// producer of a `nowplaying:changed` broadcast is a playback transition, so a queue transition
	// silently strands the value the TV renders and pre-warms.
	const { state, deps, published } = harness();

	deps.actorSingerId = 's1';
	queueCommandArmPreFix(addCmd('q1', 'm-ready-1', 's1'), deps); // auto-starts
	deps.actorSingerId = 's3';
	queueCommandArmPreFix(addCmd('q3', 'm-ready-3', 's3'), deps);
	// A playback-side event (a cook completing, a play/pause) legitimately broadcasts q3 as next.
	reconcileOnReady(deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(advertisedUpNextId(published)).toBe('q3');

	// s3 pulls their song while q1 is still playing. Truth: there is no next.
	const beforeRemove = published.length;
	queueCommandArmPreFix(removeCmd('q3'), deps);
	expect(state.entries.some((e) => e.id === 'q3')).toBe(false);
	// THE DEFECT: not one nowplaying:changed, so the last broadcast still names q3 — a song that is no
	// longer in the queue, and the entry `syncSlots` pre-warms the gapless slot from.
	expect(published.slice(beforeRemove).filter((e) => e.type === 'nowplaying:changed').length).toBe(0);
	expect(advertisedUpNextId(published)).toBe('q3');

	// The fixed arm corrects exactly that, on the same state, with no other change.
	emitNowPlaying(deps);
	expect(advertisedUpNextId(published)).toBeNull();
});

// ── SOURCE-SCAN GUARD for the production line (apps/core/server.ts) ───────────────────────────────
// apps/core/server.ts is the Bun.serve entry: no unit harness, so the behavioural half above drives a
// MIRROR of its composition and cannot tell whether production actually re-emits. Comments are
// blanked first so a commented-out call cannot satisfy it (the explanatory comment beside the fix
// names the call, so this is load-bearing here, not boilerplate).
//
// RETARGETED this guard. The re-emit used to be an `else emitNowPlaying(deps)` hanging off a
// second hand-written copy of the recovery predicate; the copy was the defect, so the `else`
// went with it. The stale-upNext PROPERTY is unchanged and is what is pinned below — after a queue:command
// that needed no recovery, exactly one nowplaying:changed is still published — but it is now carried
// by the unconditional `reconcileOnReady(deps)`, whose single tail emit (player.ts, OUTSIDE the
// `if (!currentResolves)` block) runs on all three paths. That is why the unconditional call is not
// the double-emit bug the fix rejected: the rejected shape was an unconditional `emitNowPlaying`, which
// would emit a SECOND time on the recovery path.
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// Anchored on the repo root. `player.ts` was a SIBLING READ — this guard used to live in
// apps/core/src/server/realtime/, so `at('apps/core/src/server/realtime/player.ts')` meant "the player module next
// to me"; both subjects are named explicitly now and were confirmed present before re-anchoring.
const SERVER = stripComments(read('apps/core/server.ts'));
const PLAYER = stripComments(read('apps/core/src/server/realtime/player.ts'));

test('server.ts re-emits nowplaying after a queue:command that did NOT need recovery', () => {
	// Non-vacuous: the seam this property hangs on must still be here. If the queue:command arm is
	// renamed or moved, this reds rather than passing over nothing.
	expect(SERVER).toMatch(/handleQueueCommand\(evt\.command/);

	const caseIdx = SERVER.indexOf("case 'queue:command':");
	expect(caseIdx).toBeGreaterThanOrEqual(0);
	const breakIdx = SERVER.indexOf('break;', caseIdx);
	expect(breakIdx).toBeGreaterThan(caseIdx);
	const arm = SERVER.slice(caseIdx, breakIdx);

	// (a) The arm reconciles on EVERY queue mutation, not only when recovery is due. A conditional
	//     reconcile is the pre-fix shape: the resolves path would publish queue:patch alone, leaving
	//     the TV holding the last broadcast upNext — a song since removed, or one reordering pushed
	//     behind another singer, with syncSlots pre-warming the gapless slot from that stale entry.
	expect(arm).toMatch(/reconcileOnReady\(deps\)/);
	expect(arm).not.toMatch(/\.some\(\s*\(e\)\s*=>\s*e\.id\s*===\s*[\w.]*playback\.currentEntryId/);
	expect(arm).not.toMatch(/\b(?:if|else)\b[^\n]*reconcileOnReady\(deps\)/);

	// (b) It must NOT be an unconditional `emitNowPlaying` — that is the double-emit shape the fix
	//     weighed and rejected, since it would fire a second time on the recovery path.
	expect(arm).not.toMatch(/\bemitNowPlaying\b/);

	// (c) Prove (a)+(b) DISCRIMINATE rather than passing on anything: re-introducing either rejected
	//     shape into this same text must red. Both mutants are applied to the real arm.
	const withGate = arm.replace(
		/reconcileOnReady\(deps\)/,
		'if (!state.entries.some((e) => e.id === state.playback.currentEntryId)) reconcileOnReady(deps)'
	);
	expect(withGate).toMatch(/\.some\(\s*\(e\)\s*=>\s*e\.id\s*===\s*[\w.]*playback\.currentEntryId/);
	const withUnconditionalEmit = arm.replace(/reconcileOnReady\(deps\)/, 'emitNowPlaying(deps)');
	expect(withUnconditionalEmit).toMatch(/\bemitNowPlaying\b/);

	// (d) The single-emit property lives in the callee, so pin it there: reconcileOnReady's ONE
	//     emitNowPlaying call must sit OUTSIDE its `if (!currentResolves)` block. Moving it inside
	//     (or adding a second) is exactly what would make the unconditional call double-broadcast on
	//     the recovery path, and no behavioural test of the mirror above would notice.
	const fnIdx = PLAYER.indexOf('export function reconcileOnReady(');
	expect(fnIdx).toBeGreaterThanOrEqual(0);
	const body = PLAYER.slice(fnIdx, PLAYER.indexOf('\n}', fnIdx));
	const gateIdx = body.indexOf('if (!currentResolves)');
	expect(gateIdx).toBeGreaterThanOrEqual(0);
	const emits = [...body.matchAll(/\bemitNowPlaying\(deps\)/g)];
	expect(emits.length).toBe(1);
	expect(emits[0]!.index).toBeGreaterThan(gateIdx); // after the block, not inside a branch of it
	// The block must be CLOSED before the emit — count braces from the gate to the emit and require
	// the depth to be back to zero, so an emit textually "after" the `if` but still nested reds.
	const between = body.slice(gateIdx, emits[0]!.index);
	const opens = (between.match(/\{/g) ?? []).length;
	const closes = (between.match(/\}/g) ?? []).length;
	expect(opens).toBe(closes);

	// PINNED ORDER: the reconcile must run AFTER the mutation, or it re-derives the PRE-mutation queue
	// and re-broadcasts the same stale value the issue reports — green on every assertion above.
	const callIdx = arm.search(/handleQueueCommand\(evt\.command/);
	const reconcileIdx = arm.search(/reconcileOnReady\(deps\)/);
	expect(callIdx).toBeGreaterThanOrEqual(0);
	expect(reconcileIdx).toBeGreaterThanOrEqual(0);
	expect(reconcileIdx).toBeGreaterThan(callIdx);
});
