// The ordering rule is the whole point of this module, so it gets a test that fails if someone
// "simplifies" the two calls into the other order. Why priority survives process-first is pinned in
// reprioritize-process.test.ts.
import { test, expect } from 'bun:test';
import { processAndQueue, type ProcessAndQueueSteps } from '$lib/process-and-queue';

function steps(calls: string[], over: Partial<ProcessAndQueueSteps> = {}): ProcessAndQueueSteps {
	return {
		mediaId: 'm1',
		inFlight: new Set(),
		process: async () => {
			calls.push('process');
			return true;
		},
		queue: () => calls.push('queue'),
		...over
	};
}

test('process happens BEFORE queue, so every phone reads the new turn as being made from its first frame', async () => {
	const calls: string[] = [];
	await processAndQueue(steps(calls));
	expect(calls).toEqual(['process', 'queue']);
});

test('the queue step waits for the process to ANSWER, not just to be sent', async () => {
	// The POST marks the media `queued` before it answers; an add sent before that answer is the flash.
	const calls: string[] = [];
	let answer!: (v: boolean) => void;
	const done = processAndQueue(
		steps(calls, {
			process: () => {
				calls.push('process');
				return new Promise<boolean>((r) => (answer = r));
			}
		})
	);
	await Promise.resolve();
	expect(calls).toEqual(['process']); // still waiting on the POST: no turn yet
	answer(true);
	await done;
	expect(calls).toEqual(['process', 'queue']);
});

test('a refused process books NO turn: a turn nothing is working on is a dead end', async () => {
	const calls: string[] = [];
	await processAndQueue(
		steps(calls, {
			process: async () => {
				calls.push('process');
				return false;
			}
		})
	);
	expect(calls).toEqual(['process']);
});

// ── F1: the retry the app advertises must not book a SECOND turn ─────────────────────────────
// A terminally failed process keeps offering Sing ("tap Sing to try again"), and taking that advice ran
// BOTH steps — so the singer held two queued turns of one song and the room played it twice. With a
// turn already queued the queue step must be skipped and only the process run. Asserted against a
// hard-coded expected call list, not derived from the same branch the code takes.
test('a retry (hasQueuedTurn) PROCESSES but does NOT queue a second turn', async () => {
	const calls: string[] = [];
	await processAndQueue(steps(calls, { hasQueuedTurn: true }));
	expect(calls).toEqual(['process']);
	const explicit: string[] = [];
	await processAndQueue(steps(explicit, { hasQueuedTurn: false }));
	expect(explicit).toEqual(['process', 'queue']);
});

test('one turn per tap: a second Sing on the same song while its POST is out is ignored', async () => {
	const calls: string[] = [];
	const inFlight = new Set<string>();
	const answers: ((v: boolean) => void)[] = [];
	const slow = (): Promise<boolean> => {
		calls.push('process');
		return new Promise<boolean>((r) => answers.push(r));
	};
	const first = processAndQueue(steps(calls, { inFlight, process: slow }));
	const second = processAndQueue(steps(calls, { inFlight, process: slow })); // the double tap
	for (const a of answers) a(true);
	await Promise.all([first, second]);
	expect(calls).toEqual(['process', 'queue']);
	// A different song is not blocked by it.
	const other: string[] = [];
	await processAndQueue(steps(other, { inFlight, mediaId: 'm2' }));
	expect(other).toEqual(['process', 'queue']);
});

test('the guard clears once the POST answers, refused or not, so a later tap runs', async () => {
	const inFlight = new Set<string>();
	await processAndQueue(steps([], { inFlight, process: async () => false }));
	expect(inFlight.size).toBe(0);
	const calls: string[] = [];
	await processAndQueue(steps(calls, { inFlight }));
	expect(calls).toEqual(['process', 'queue']);
});
