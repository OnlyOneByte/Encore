// Regression for issue #636: "Next up" named a song that would NOT be played next.
//
// `nowplaying:changed` is what the TV's Up next strip, the full-screen Next up card and the gapless
// preload slot all read (routes/tv/+page.svelte: `applyNowPlaying` is its only writer). It had exactly
// two BROADCAST producers, both playback transitions in player.ts — `reconcileOnReady` and
// `handlePlayerCommand`. A QUEUE mutation produced none: `handleQueueCommand` publishes `queue:patch`
// alone (hub.ts), and apps/core/server.ts's `queue:command` arm only called `reconcileOnReady` when the
// current entry no longer RESOLVED — i.e. only when the room was idle or the playing entry had been
// pruned (#128).
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
//     dangling-current-entry.test.ts (the #128 gate on this very line) and
//     session-cookie-attributes.test.ts (#107).
//
// EXPECTED VALUES ARE HARD-CODED entry ids ('q3', null, 'q4', never 'q2'), never re-derived by calling
// `upNextAfter` — a test that recomputed the projection with the same function the code uses could not
// detect a wrong projection at all (#165).
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from './hub';
import { reconcileOnReady, emitNowPlaying } from './player';
import { AuthoritativeState } from '../state/store';
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
 * server.ts's `queue:command` arm as it stands AFTER the fix. The `if` line is byte-identical to
 * production's (and to dangling-current-entry.test.ts's mirror); the `else` is the #636 fix.
 */
function queueCommandArm(cmd: ClientCommand, deps: HubDeps) {
	handleQueueCommand(cmd, deps);
	if (!deps.state.entries.some((e) => e.id === deps.state.playback.currentEntryId)) reconcileOnReady(deps);
	else emitNowPlaying(deps);
}

/** The same arm BEFORE the fix — the recovery gate with no `else`. Used to characterise the defect. */
function queueCommandArmPreFix(cmd: ClientCommand, deps: HubDeps) {
	handleQueueCommand(cmd, deps);
	if (!deps.state.entries.some((e) => e.id === deps.state.playback.currentEntryId)) reconcileOnReady(deps);
}

test('a queue mutation mid-song re-broadcasts the TRUE next, and never the cooking entry holding the head slot (#636)', () => {
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

	// ── Transition 1: an ADD while a song plays. The current entry RESOLVES, so the recovery branch is
	// NOT taken — this is the `else`, and the reported window.
	deps.actorSingerId = 's3';
	const beforeAdd = published.length;
	queueCommandArm(addCmd('q3', 'm-ready-3', 's3'), deps);
	// The playing entry was untouched, which is what proves the emit came from the `else` and not from
	// a reconcile: reconcileOnReady only runs when the current id does not resolve.
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

test('without the else, a mid-song queue mutation leaves the advertised next naming a song that has left the queue (#636)', () => {
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
// MIRROR of its composition and cannot tell whether production has the `else`. On base, server.ts
// contains no `emitNowPlaying` at all — that is what makes this scan red there. Comments are blanked
// first so a commented-out call cannot satisfy it (the explanatory comment beside the fix names the
// call, so this is load-bearing here, not boilerplate).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/realtime → apps/core/server.ts is three levels up.
const SERVER = stripComments(readFileSync(join(import.meta.dir, '..', '..', '..', 'server.ts'), 'utf8'));

test('server.ts re-emits nowplaying after a queue:command that did NOT need recovery (#636)', () => {
	// Non-vacuous: the seam this fix hangs on must still be here. If the queue:command arm or the #128
	// recovery gate is renamed or moved, this reds rather than passing over nothing.
	expect(SERVER).toMatch(/handleQueueCommand\(evt\.command/);
	expect(SERVER).toMatch(/reconcileOnReady\(deps\)/);

	// The call must be IMPORTED from the player module — the broadcast producer — not re-implemented
	// locally. Reverting the import alone reds here.
	expect(SERVER).toMatch(/import\s*\{[^}]*\bemitNowPlaying\b[^}]*\}\s*from\s*'\.\/src\/server\/realtime\/player'/);

	// THE PINNED LINE: an `else` on the #128 recovery gate, calling emitNowPlaying. `else` is
	// load-bearing and is not interchangeable with an unconditional call — every reconcileOnReady
	// branch already emits, so an unconditional emit would double-broadcast on the recovery path.
	const caseIdx = SERVER.indexOf("case 'queue:command':");
	expect(caseIdx).toBeGreaterThanOrEqual(0);
	const breakIdx = SERVER.indexOf('break;', caseIdx);
	expect(breakIdx).toBeGreaterThan(caseIdx);
	const arm = SERVER.slice(caseIdx, breakIdx);

	// Reflow-tolerant (reviewer advisory on PR #774): a prettier/brace reflow can put the `else` on
	// its own line, wrap either branch in braces, or split the condition — so the OLD single regex
	// requiring `reconcileOnReady(deps); else emitNowPlaying(deps);` on adjacent statements with only
	// whitespace between was brittle and could red a legitimately-correct file. Pin the three facts
	// independently instead, each robust to whitespace/braces:
	//   (a) the recovery gate is present in this arm (condition may wrap across newlines),
	expect(arm).toMatch(
		/if\s*\(\s*!state\.entries\.some\(\s*\(e\)\s*=>\s*e\.id\s*===\s*state\.playback\.currentEntryId\s*\)\s*\)/
	);
	//   (b) it calls reconcileOnReady on the true branch,
	expect(arm).toMatch(/reconcileOnReady\(deps\)/);
	//   (c) there is an `else` whose body calls emitNowPlaying(deps) — `\s*` (which spans newlines)
	//       and an optional `{` between `else` and the call absorb any reflow. `\belse\b` requires the
	//       keyword, so an UNCONDITIONAL `emitNowPlaying(deps)` (the double-emit bug) does NOT match.
	expect(arm).toMatch(/\belse\b\s*\{?\s*emitNowPlaying\(deps\)/);

	// Prove arm (c) DISCRIMINATES rather than passing on anything: the same text with the `else`
	// keyword stripped (an unconditional emit) must NOT match — this is what pins "else", not just
	// "emitNowPlaying appears somewhere".
	const unconditional = arm.replace(/\belse\b(\s*\{?\s*emitNowPlaying\(deps\))/, '$1');
	expect(unconditional).not.toMatch(/\belse\b\s*\{?\s*emitNowPlaying\(deps\)/);

	// PINNED ORDER: the emit must run AFTER the mutation, or it re-derives the PRE-mutation queue and
	// re-broadcasts the same stale value the issue reports — green on every assertion above.
	const callIdx = arm.search(/handleQueueCommand\(evt\.command/);
	const emitIdx = arm.search(/\belse\b\s*\{?\s*emitNowPlaying\(deps\)/);
	expect(callIdx).toBeGreaterThanOrEqual(0);
	expect(emitIdx).toBeGreaterThanOrEqual(0);
	expect(emitIdx).toBeGreaterThan(callIdx);
});
