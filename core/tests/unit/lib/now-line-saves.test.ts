// The now-line heart's saved set: one singer's alone, and a double tap ends where the guest left it.
import { test, expect } from 'bun:test';
import { NowLineSaves } from '$lib/now-line-saves';

type Call = { url: string; method: string; answer: (status: number, body?: unknown) => void };

/** A fetch whose every request waits until the test answers it, so the order on the wire is the test's to see. */
function harness() {
	const calls: Call[] = [];
	const refused: string[] = [];
	const fetch = ((url: string, init?: RequestInit) =>
		new Promise<Response>((resolve) =>
			calls.push({
				url,
				method: init?.method ?? 'GET',
				answer: (status, body = {}) => resolve(new Response(JSON.stringify(body), { status }))
			})
		)) as unknown as typeof globalThis.fetch;
	const saves = new NowLineSaves({ fetch, refused: (m) => void refused.push(m) });
	return { saves, calls, refused };
}
const songs = (...saved: string[]) => ({ songs: saved.map((mediaId) => ({ mediaId, saved: { id: 's' } })) });
const tick = () => new Promise((r) => setTimeout(r, 0));

test("Alice, then Leave, then Bob: Bob's heart never shows Alice's saves, even if her answer lands late", async () => {
	const { saves, calls } = harness();
	const alice = saves.setSinger('alice');
	calls[0]!.answer(200, songs('m1'));
	await alice;
	expect(saves.ids.has('m1')).toBe(true);

	// Leave: empty at once.
	await saves.setSinger(null);
	expect(saves.ids.size).toBe(0);

	// Alice again, then Bob before her answer lands: her late answer does not fill Bob's set.
	const late = saves.setSinger('alice');
	const bob = saves.setSinger('bob');
	expect(saves.ids.size).toBe(0);
	calls[1]!.answer(200, songs('m1'));
	await late;
	expect(saves.ids.has('m1')).toBe(false);
	calls[2]!.answer(200, songs('m2'));
	await bob;
	expect([...saves.ids]).toEqual(['m2']);
});

test('a double tap during a slow save sends PUT then DELETE, in order, and ends unsaved with no toast', async () => {
	const { saves, calls, refused } = harness();
	const load = saves.setSinger('theo');
	calls[0]!.answer(200, songs());
	await load;

	const first = saves.toggle('m1');
	// The fill is on the tap itself, before any answer.
	expect(saves.ids.has('m1')).toBe(true);
	const second = saves.toggle('m1');
	expect(saves.ids.has('m1')).toBe(false);
	await tick();
	// The unsave waits behind the save still in the air.
	expect(calls.slice(1).map((c) => c.method)).toEqual(['PUT']);
	calls[1]!.answer(200);
	await first;
	await tick();
	expect(calls.slice(1).map((c) => c.method)).toEqual(['PUT', 'DELETE']);
	calls[2]!.answer(200);
	await second;
	expect(saves.ids.has('m1')).toBe(false);
	expect(refused).toEqual([]);
});

test('a refused save rolls the mark back and says so; a refused tap that a later tap overrode stays quiet', async () => {
	const { saves, calls, refused } = harness();
	const load = saves.setSinger('theo');
	calls[0]!.answer(200, songs());
	await load;

	const one = saves.toggle('m1');
	await tick();
	calls[1]!.answer(500);
	await one;
	expect(saves.ids.has('m1')).toBe(false);
	expect(refused).toEqual(["Couldn't save it to your songs."]);

	// Save refused while an unsave is queued behind it: the guest's last word (out) stands, without a toast.
	const save = saves.toggle('m1');
	const unsave = saves.toggle('m1');
	await tick();
	calls[2]!.answer(500);
	await save;
	await tick();
	// Out already, so the server answers 404, which is what the guest asked for.
	calls[3]!.answer(404);
	await unsave;
	expect(saves.ids.has('m1')).toBe(false);
	expect(refused).toHaveLength(1);
});
