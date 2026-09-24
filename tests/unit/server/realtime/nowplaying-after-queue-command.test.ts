// `nowplaying:changed` feeds the TV's Up next strip, the Next up card and the gapless preload slot, and
// every BROADCAST producer of it was a PLAYBACK transition, so an add/remove/move mid-song changed WHO
// PLAYS NEXT with nothing re-broadcasting it. Expected values are HARD-CODED entry ids, never re-derived
// via `upNextAfter`: a test recomputing the projection with the code's own function could not detect a
// wrong projection at all.
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from '$lib/server/realtime/hub';
import { reconcileOnReady, emitNowPlaying } from '$lib/server/realtime/player';
import { AuthoritativeState } from '$lib/server/state/store';
import { EMPTY_SONG_PROFILE } from '$lib/contract';
import { type ServerEvent, type Media, type QueueEntry, type ClientCommand } from '$lib/contract';

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

/** A song still PROCESSING: `readyToSing` is false, so `upNextAfter` holds its rotation slot but walks
 *  past it, and it must never be advertised as the song that plays next. */
const processingMedia = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	// Gate is `stemStatus === 'ready' && !!instrumentalRef` (gates.ts); instrumentalRef is OPTIONAL, so omitted.
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
			['m-processing', processingMedia('m-processing')],
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

/** server.ts's `queue:command` arm: an UNCONDITIONAL reconcileOnReady. On the "current resolves" path it
 *  skips the recovery block and falls through to the single tail emit, so it never double-broadcasts. */
function queueCommandArm(cmd: ClientCommand, deps: HubDeps) {
	handleQueueCommand(cmd, deps);
	reconcileOnReady(deps);
}

/** The defect shape, kept deliberately: the recovery gate with no re-emit on the resolves path. NOT a
 *  mirror of production, which is why the single-source census scans production only. */
function queueCommandArmPreFix(cmd: ClientCommand, deps: HubDeps) {
	handleQueueCommand(cmd, deps);
	if (!deps.state.entries.some((e) => e.id === deps.state.playback.currentEntryId)) reconcileOnReady(deps);
}

test('a queue mutation mid-song re-broadcasts the TRUE next, and never the processing entry holding the head slot', () => {
	const { state, deps, published } = harness();

	// Queued FIRST but still processing, so it holds the rotation head and every "what plays next" walks past it.
	deps.actorSingerId = 's2';
	queueCommandArm(addCmd('q2', 'm-processing', 's2'), deps);
	expect(state.playback.currentEntryId).toBeNull();

	// s1's finished song arrives and auto-starts (room was idle → the recovery branch).
	deps.actorSingerId = 's1';
	queueCommandArm(addCmd('q1', 'm-ready-1', 's1'), deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.playback.isPlaying).toBe(true);
	// q2 keeps its slot but is not singable, so there is still no next.
	expect(advertisedUpNextId(published)).toBeNull();

	// Transition 1, the reported window: an ADD mid-song. The current entry RESOLVES, so only the tail emit runs.
	deps.actorSingerId = 's3';
	const beforeAdd = published.length;
	queueCommandArm(addCmd('q3', 'm-ready-3', 's3'), deps);
	// An untouched playing entry proves no recovery ran; EXACTLY ONE emit is what makes the unconditional call safe.
	expect(state.playback.currentEntryId).toBe('q1');
	expect(published.slice(beforeAdd).filter((e) => e.type === 'nowplaying:changed').length).toBe(1);
	// HARD-CODED: q3 is the true next. q2 sits ahead of it in the rotation and is skipped for now.
	expect(advertisedUpNextId(published)).toBe('q3');
	expect(advertisedUpNextId(published)).not.toBe('q2');

	// Transition 2: the advertised song is REMOVED mid-song. q2 is still processing, so truth is "no next".
	queueCommandArm(removeCmd('q3'), deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(advertisedUpNextId(published)).toBeNull();

	// Transition 3: a new finished song arrives and becomes the true next.
	queueCommandArm(addCmd('q4', 'm-ready-4', 's3'), deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(advertisedUpNextId(published)).toBe('q4');
	// The processing entry is STILL never advertised, across all three transitions.
	expect(published.filter((e) => e.type === 'nowplaying:changed').every((e) => e.upNext?.id !== 'q2')).toBe(true);
});

test('without the else, a mid-song queue mutation leaves the advertised next naming a song that has left the queue', () => {
	// With playback transitions as the only producer, a queue transition strands the value the TV pre-warms from.
	const { state, deps, published } = harness();

	deps.actorSingerId = 's1';
	queueCommandArmPreFix(addCmd('q1', 'm-ready-1', 's1'), deps); // auto-starts
	deps.actorSingerId = 's3';
	queueCommandArmPreFix(addCmd('q3', 'm-ready-3', 's3'), deps);
	// A playback-side event (a process completing, a play/pause) legitimately broadcasts q3 as next.
	reconcileOnReady(deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(advertisedUpNextId(published)).toBe('q3');

	// s3 pulls their song while q1 is still playing. Truth: there is no next.
	const beforeRemove = published.length;
	queueCommandArmPreFix(removeCmd('q3'), deps);
	expect(state.entries.some((e) => e.id === 'q3')).toBe(false);
	// THE DEFECT: no emit, so the last broadcast still names q3 — gone from the queue, yet still pre-warmed.
	expect(published.slice(beforeRemove).filter((e) => e.type === 'nowplaying:changed').length).toBe(0);
	expect(advertisedUpNextId(published)).toBe('q3');

	// The fixed arm corrects exactly that, on the same state, with no other change.
	emitNowPlaying(deps);
	expect(advertisedUpNextId(published)).toBeNull();
});

// server.ts is the Bun.serve entry with no unit harness, so the half above only mirrors its composition.
// Pinned below: after a queue:command needing no recovery, exactly one nowplaying:changed is published, by
// the unconditional `reconcileOnReady(deps)` whose single tail emit sits OUTSIDE `if (!currentResolves)`.
import { readFileSync } from 'node:fs';
import { at } from '$test';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const SERVER = stripComments(readFileSync(at('server.ts'), 'utf8'));
const PLAYER = stripComments(readFileSync(at('src/lib/server/realtime/player.ts'), 'utf8'));

test('server.ts re-emits nowplaying after a queue:command that did NOT need recovery', () => {
	// Non-vacuous: renaming or moving the queue:command arm reds here rather than passing over nothing.
	expect(SERVER).toMatch(/handleQueueCommand\(evt\.command/);

	const caseIdx = SERVER.indexOf("case 'queue:command':");
	expect(caseIdx).toBeGreaterThanOrEqual(0);
	const breakIdx = SERVER.indexOf('break;', caseIdx);
	expect(breakIdx).toBeGreaterThan(caseIdx);
	const arm = SERVER.slice(caseIdx, breakIdx);

	// (a) Reconcile on EVERY queue mutation: a conditional reconcile leaves the resolves path emitting nothing.
	expect(arm).toMatch(/reconcileOnReady\(deps\)/);
	expect(arm).not.toMatch(/\.some\(\s*\(e\)\s*=>\s*e\.id\s*===\s*[\w.]*playback\.currentEntryId/);
	expect(arm).not.toMatch(/\b(?:if|else)\b[^\n]*reconcileOnReady\(deps\)/);

	// (b) NOT an unconditional `emitNowPlaying`, which would fire a SECOND time on the recovery path.
	expect(arm).not.toMatch(/\bemitNowPlaying\b/);

	// (c) Prove (a)+(b) DISCRIMINATE: re-introducing either rejected shape into this same text must red.
	const withGate = arm.replace(
		/reconcileOnReady\(deps\)/,
		'if (!state.entries.some((e) => e.id === state.playback.currentEntryId)) reconcileOnReady(deps)'
	);
	expect(withGate).toMatch(/\.some\(\s*\(e\)\s*=>\s*e\.id\s*===\s*[\w.]*playback\.currentEntryId/);
	const withUnconditionalEmit = arm.replace(/reconcileOnReady\(deps\)/, 'emitNowPlaying(deps)');
	expect(withUnconditionalEmit).toMatch(/\bemitNowPlaying\b/);

	// (d) The single-emit property lives in the callee: reconcileOnReady's ONE emitNowPlaying must sit OUTSIDE
	//     its `if (!currentResolves)` block, or the unconditional call double-broadcasts on the recovery path.
	const fnIdx = PLAYER.indexOf('export function reconcileOnReady(');
	expect(fnIdx).toBeGreaterThanOrEqual(0);
	const body = PLAYER.slice(fnIdx, PLAYER.indexOf('\n}', fnIdx));
	const gateIdx = body.indexOf('if (!currentResolves)');
	expect(gateIdx).toBeGreaterThanOrEqual(0);
	const emits = [...body.matchAll(/\bemitNowPlaying\(deps\)/g)];
	expect(emits.length).toBe(1);
	expect(emits[0]!.index).toBeGreaterThan(gateIdx); // after the block, not inside a branch of it
	// Brace depth back to zero, so an emit textually "after" the `if` but still nested inside it reds.
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
