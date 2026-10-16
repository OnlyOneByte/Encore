/*
 * THE DEAD TURN, as a policy rather than a rendering. A queued entry whose song can never become singable:
 * the rotation holds its slot and skips it on every pass. The behavioural half (a guest taps "make karaoke",
 * the queue add lands, the process half is refused) is pinned on the client in readiness.test.ts and
 * dead-turn-card.test.ts; this file pins the SERVER's side, which is the only side that can see the job
 * ledger and therefore the only one that can say "nothing can still close this gate".
 *
 * WHAT THESE ARMS ARE REALLY DEFENDING is the predicate's second half. A reader that only asked "is the
 * stems gate open?" matches exactly the SAME rows on the owner's library copy (measured 2026-10-15 — a
 * symmetric difference of ZERO in both directions) because that snapshot holds no non-terminal jobs at all.
 * So no test over that data could tell the loose predicate from the correct one, and the arms below are the
 * synthetic in-flight cases it would libel: a fetch mid-download, a stems job queued, an align running.
 */
import { expect, test } from 'bun:test';
import { read, stripComments } from '$test';
import { deadTurns, DeadTurnWatch } from '$lib/server/jobs/dead-turns';
import type { Media, QueueEntry } from '$lib/contract';

const T0 = 1_700_000_000_000;

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});

/** Karaoke-ready: both required gates closed. `readyToSing` reads the gate table, so this is what it wants. */
const readyMedia = (id: string): Media =>
	media(id, { stemStatus: 'ready', instrumentalRef: `${id}/instrumental.flac`, lyricsStatus: 'ready' });

const entry = (id: string, mediaId: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
	id,
	mediaId,
	singerId: 's1',
	status: 'queued',
	rotationSeq: 1,
	addedAt: T0,
	...over
});

const catalog = (...list: Media[]) => new Map(list.map((m) => [m.id, m]));
const noJobs = () => false;

test('a queued turn on an unacquired song with no job left is dead', () => {
	// The population: stems gate open, nothing in flight. Around a hundred of these on the owner's copy, every
	// one of them a turn a guest asked for and the rotation will skip forever.
	const dead = deadTurns([entry('e1', 'm1', { singerId: 'singer-7' })], catalog(media('m1')), noJobs);
	expect(dead).toEqual([{ entryId: 'e1', mediaId: 'm1', singerId: 'singer-7' }]);
});

test('an OUTSTANDING job protects the turn, which is the whole second half of the predicate', () => {
	// The arm the owner's snapshot cannot test, because it holds no non-terminal jobs: a separation genuinely
	// in flight. Delete this term and `deadTurns` calls every cooking song dead the moment a guest taps Sing.
	const inFlight = (mediaId: string) => mediaId === 'm1';
	expect(deadTurns([entry('e1', 'm1')], catalog(media('m1', { stemStatus: 'queued' })), inFlight)).toEqual([]);
	// And without the job — the crash window between `jobs.complete(fetch)` and the follow-up enqueue — the
	// SAME media is dead, which is the point of reading the ledger rather than the column: `stem_status` says
	// 'queued' in both cases and cannot tell them apart.
	expect(deadTurns([entry('e1', 'm1')], catalog(media('m1', { stemStatus: 'queued' })), noJobs)).toHaveLength(1);
});

test('a karaoke-ready song is never dead, job or no job', () => {
	expect(deadTurns([entry('e1', 'm1')], catalog(readyMedia('m1')), noJobs)).toEqual([]);
});

test('only QUEUED entries count — the playing turn and a finished one are not the rotation’s future', () => {
	const entries = [
		entry('e-playing', 'm1', { status: 'playing' }),
		entry('e-done', 'm1', { status: 'done' }),
		entry('e-queued', 'm1')
	];
	// A song can be mid-performance with its lyrics gate still open; calling THAT dead would libel the turn
	// currently on screen.
	expect(deadTurns(entries, catalog(media('m1')), noJobs).map((d) => d.entryId)).toEqual(['e-queued']);
});

test('a media missing from the catalog is not provably dead', () => {
	// Nothing to ask `readyToSing`, so the honest answer is silence — the same reasoning queueCardKind's
	// no-media arm gives. Counting it would make a torn sync look like a dead turn.
	expect(deadTurns([entry('e1', 'ghost')], catalog(), noJobs)).toEqual([]);
});

test('every holder is named, one row per TURN', () => {
	// A media can hold many turns — one holds ten on the owner's copy — and the operator line counts turns
	// while the watch dedupes songs. Rolling up to media here would lose the singers.
	const entries = [
		entry('e1', 'm1', { singerId: 'a' }),
		entry('e2', 'm1', { singerId: 'b' }),
		entry('e3', 'm2', { singerId: 'a' })
	];
	const dead = deadTurns(entries, catalog(media('m1'), media('m2')), noJobs);
	expect(dead.map((d) => `${d.entryId}/${d.singerId}`)).toEqual(['e1/a', 'e2/b', 'e3/a']);
});

test('rotation order is preserved, because the caller’s order is the room’s order', () => {
	const entries = [entry('e3', 'm3'), entry('e1', 'm1'), entry('e2', 'm2')];
	const dead = deadTurns(entries, catalog(media('m1'), media('m2'), media('m3')), noJobs);
	expect(dead.map((d) => d.entryId)).toEqual(['e3', 'e1', 'e2']);
});

// ── the watch: two passes, announce once, no clock ────────────────────────────────────────────────

test('the first pass is adopted silently — the standing population is not news', () => {
	const watch = new DeadTurnWatch();
	expect(watch.step(['m1', 'm2'])).toEqual([]);
	// Still dead on the next pass, and still not news: a turn that was already dead when this process
	// started did not die while anyone was watching. The boot census is what reports those.
	expect(watch.step(['m1', 'm2'])).toEqual([]);
});

test('a newly dead song needs TWO consecutive passes, which is the queue()→process() window', () => {
	const watch = new DeadTurnWatch();
	watch.step([]); // adopt an empty room
	// Pass 1: the tap landed its queue add and has not reached /api/process yet (measured at 3–21ms).
	expect(watch.step(['m1'])).toEqual([]);
	// Pass 2, 3 seconds later: still no job, so it is not a window, it is a dead turn.
	expect(watch.step(['m1'])).toEqual(['m1']);
});

test('the window closes without ever being announced', () => {
	const watch = new DeadTurnWatch();
	watch.step([]);
	expect(watch.step(['m1'])).toEqual([]); // mid-tap
	expect(watch.step([])).toEqual([]); // the process POST landed; a job exists
	// And nothing is left over: the next genuine death still needs its two passes rather than inheriting
	// the aborted one.
	expect(watch.step(['m1'])).toEqual([]);
	expect(watch.step(['m1'])).toEqual(['m1']);
});

test('announce-once: a 3s tick does not reprint the same song forever', () => {
	const watch = new DeadTurnWatch();
	watch.step([]);
	watch.step(['m1']);
	expect(watch.step(['m1'])).toEqual(['m1']);
	for (let i = 0; i < 100; i++) expect(watch.step(['m1'])).toEqual([]);
});

test('a retry that lands and then dies again announces again', () => {
	// The prune is one rule covering every way a turn stops being dead — a job enqueued, the entry removed,
	// the media deleted — and it must not make the SECOND death invisible.
	const watch = new DeadTurnWatch();
	watch.step([]);
	watch.step(['m1']);
	expect(watch.step(['m1'])).toEqual(['m1']);
	expect(watch.step([])).toEqual([]); // the retry's job exists
	expect(watch.step(['m1'])).toEqual([]); // it died again: pass 1
	expect(watch.step(['m1'])).toEqual(['m1']); // pass 2
});

test('songs are tracked independently, so one noisy song cannot mask another', () => {
	const watch = new DeadTurnWatch();
	watch.step([]);
	expect(watch.step(['m1'])).toEqual([]);
	expect(watch.step(['m1', 'm2'])).toEqual(['m1']);
	expect(watch.step(['m1', 'm2'])).toEqual(['m2']);
	expect(watch.step(['m1', 'm2'])).toEqual([]);
});

test('an EMPTY pass still prunes, which is the whole reason the caller may not skip one', () => {
	// The three arms above all lean on `step([])` doing the pruning. Stated once, on its own, because the
	// sweep in app.ts returns early on an empty queue to save the query and MUST NOT return early past this:
	// frozen sets mean a song that dies, drains and dies again is silently never announced a second time.
	const watch = new DeadTurnWatch();
	watch.step([]);
	watch.step(['m1']);
	expect(watch.step(['m1'])).toEqual(['m1']); // announced
	expect(watch.step([])).toEqual([]); // the queue drained entirely — the only thing that prunes it
	expect(watch.step(['m1'])).toEqual([]); // re-queued and still dead: pass 1, from scratch
	expect(watch.step(['m1'])).toEqual(['m1']); // pass 2 — news again, because the empty pass pruned
});

// ── the app.ts wiring, as a source scan: `getApp()` has no unit harness (same reason, and same technique,
// as the boot-maintenance guard in tests/unit/server/boot-maintenance.test.ts) ─────────────────────────────

const APP = stripComments(read('src/lib/server/app.ts'));

test('the sweep saves the QUERY on an empty queue, never the watch step', () => {
	// What the saving may look like: the `mediaWithOutstandingJob` call guarded by the entry count.
	expect(APP).toMatch(/entries\.length\s*>\s*0/);
	// What it may NOT look like: a bare `return` before `deadTurnWatch.step`, which is how this was first
	// written and what silently disabled the prune. Pinned on the SHAPE rather than the absence of the word
	// `return`, since the arms after `step` legitimately return.
	const sweep = APP.slice(APP.indexOf('const sweepDeadTurns'));
	const body = sweep.slice(0, sweep.indexOf('deadTurnWatch.step'));
	expect(body).not.toMatch(/\breturn\b/);
	// And the step is reached with whatever this pass found, including nothing.
	expect(APP).toMatch(/deadTurnWatch\.step\(\s*new Set\(dead\.map/);
});
