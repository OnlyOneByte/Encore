// Proposal 11, PR 2: which held turn the singer's "Your song didn't play" sheet is for, and the wiring that puts it in
// the "You're up" slot on any tab, on that singer's phone alone. Source scans for the wiring: no unit test mounts the
// root layout (it binds geometry; see its --dock-h note).
import { expect, test } from 'bun:test';
import { read } from '$test';
import { didntPlayKey, didntPlayTurn } from '$lib/song-didnt-play';
import type { QueueEntry } from '$lib/contract';

const e = (id: string, singerId: string, rotationSeq: number, over: Partial<QueueEntry> = {}): QueueEntry => ({
	id,
	mediaId: 'm1',
	singerId,
	status: 'queued',
	rotationSeq,
	addedAt: rotationSeq,
	...over
});

test('only my held turn gets the sheet; nobody else is told', () => {
	const entries = [e('a', 'ana', 0), e('t', 'theo', 1, { playFailed: true, playFailures: 1 })];
	expect(didntPlayTurn(entries, 'theo', [])?.id).toBe('t');
	expect(didntPlayTurn(entries, 'ana', [])).toBeNull();
	expect(didntPlayTurn(entries, null, [])).toBeNull();
	// Not held: nothing to say.
	expect(didntPlayTurn([e('t', 'theo', 0)], 'theo', [])).toBeNull();
});

test('closed stays closed for that failure, and a second failure of the song brings it back', () => {
	const once = e('t', 'theo', 0, { playFailed: true, playFailures: 1 });
	const seen = [didntPlayKey(once)];
	expect(didntPlayTurn([once], 'theo', seen)).toBeNull();
	expect(didntPlayTurn([{ ...once, playFailures: 2 }], 'theo', seen)?.id).toBe('t');
});

test('with two held turns, the earliest in the rotation', () => {
	const entries = [
		e('t2', 'theo', 3, { playFailed: true, playFailures: 1 }),
		e('t1', 'theo', 1, { playFailed: true, playFailures: 1 })
	];
	expect(didntPlayTurn(entries, 'theo', [])?.id).toBe('t1');
});

const layout = read('src/routes/+layout.svelte');
const queuePage = read('src/routes/queue/+page.svelte');

test('the sheet takes the "You\'re up" slot and replaces it, and Try again is offered only while the hub allows it', () => {
	expect(layout).toMatch(
		/\{#if didntPlay\}\s*<SongDidntPlay[\s\S]*?\{:else if floodHere && youreUp && Flood\}\s*<Flood/
	);
	expect(layout).toContain('onretry={didntPlay.canRetry ? retryDidntPlay : undefined}');
	expect(layout).toContain('canRetry: canRetryPlay(failed)');
	expect(layout).toContain('room.queue?.retryPlay(id)');
	// Toasts stack above it for as long as it is up.
	expect(layout).toContain('if (didntPlay || (youreUp && transportToastOpen)) stacked = true;');
});

test('the queue row offers both ways back on MY held turn only', () => {
	expect(queuePage).toContain(
		'onretry={e.singerId === me?.id && canRetryPlay(e) ? () => store?.retryPlay(e.id) : undefined}'
	);
	expect(queuePage).toContain(
		"pickAnotherHref={e.playFailed && e.singerId === me?.id ? pickAnotherHref(resolve('/'), e.id) : undefined}"
	);
});

test('one Pick another link for the sheet, the held row and the dead card', () => {
	for (const src of [layout, queuePage]) expect(src).not.toMatch(/const pickAnotherHref\s*=/);
	expect(layout).toContain("pickAnotherHref={pickAnotherHref(resolve('/'), didntPlay.id)}");
});
