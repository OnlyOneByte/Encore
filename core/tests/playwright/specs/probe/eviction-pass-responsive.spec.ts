/*
 * THE BOOT PASSES LET PHONES AND THE TV IN ON A LARGE LIBRARY (#1297).
 *
 * With a retention cap set, the boot eviction pass counts every ready song's bytes. Counted in one synchronous map,
 * 3,000 songs held the event loop for 28 s, and every request waited behind it. The sidecar restore and the browse
 * index sync before it write one SQLite row per song the same way. This boots core on 3,000 made songs under a cap
 * they overflow, asks /health every 50 ms from boot until the eviction pass logs what it evicted, and requires every
 * answer to come back quickly.
 */
import { test, expect } from '../../world/fixtures';

// One at a time: two 3,000-song boots side by side starve each other and the 500 ms bar fails on load, not on code.
test.describe.configure({ mode: 'serial' });

// About 1.5 MB of derived files (seedMadeLibrary), which the 0.001 GB cap overflows.
test.use({ madeSongs: [3000, { scope: 'test' }], coreEnv: { ENCORE_MEDIA_MAX_GB: '0.001' } });

test('a request is answered within 500 ms all through the boot eviction pass on 3,000 songs', async ({ world }) => {
	test.setTimeout(180_000);
	const evicted = /retention: evicted derived artifacts for (\d+) songs/;
	const waits: number[] = [];
	const deadline = Date.now() + 150_000;
	while (!evicted.test(world.core.log()) && Date.now() < deadline) {
		const t0 = Date.now();
		const res = await fetch(`${world.baseURL}/health`);
		expect(res.ok).toBe(true);
		waits.push(Date.now() - t0);
		await new Promise((r) => setTimeout(r, 50));
	}
	const done = evicted.exec(world.core.log());
	expect(done, 'the eviction pass never finished').not.toBeNull();
	expect(Number(done![1]), 'the cap evicted nothing, so the pass did not count the library').toBeGreaterThan(0);
	expect(waits.length, 'no request reached core while the pass ran').toBeGreaterThan(5);
	console.log(`[p-eviction] ${waits.length} answers through boot, slowest ${Math.max(...waits)} ms`);
	expect(Math.max(...waits), `slowest of ${waits.length} answers`).toBeLessThan(500);
});

test.describe('while the browse index sync yields', () => {
	// No cap: this is about the browse sync, which runs on every boot.
	test.use({ coreEnv: {} });

	test("a host's rename made mid-pass is not written back to the old name (#1305 review)", async ({ world }) => {
		test.setTimeout(240_000);
		const restored = /restored \d+ media from sidecars/;
		const synced = /browse index synced from \d+ sidecars/;
		const deadline = Date.now() + 150_000;
		while (!restored.test(world.core.log()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
		expect(restored.test(world.core.log()), 'the restore never logged').toBe(true);
		const phone = await world.openPhone('MidPassHost');
		await world.becomeHost(phone);
		// Rename songs across the library, as fast as the host can, until the sync says it is done: the renames that
		// land after it read its records and before it reaches the song are the ones a stale read would put back.
		const last = new Map<string, string>();
		let sent = 0;
		while (!synced.test(world.core.log()) && Date.now() < deadline) {
			const id = `01MADE${String((sent * 37) % 3000).padStart(8, '0')}`;
			const title = `Renamed ${id} #${sent++}`;
			const res = await phone.request.post('/api/library/manage/rename', {
				data: { mediaId: id, title, artist: 'Host' }
			});
			expect(res.ok(), `rename ${id}`).toBe(true);
			last.set(id, title);
		}
		expect(synced.test(world.core.log()), 'the browse sync never logged').toBe(true);
		expect(sent, 'too few renames landed while the sync ran to prove anything').toBeGreaterThan(50);
		const reverted: string[] = [];
		for (const [id, title] of last) {
			const m = (await (await phone.request.get(`/api/audit/${id}`)).json()).media;
			if (m?.titleCanonical !== title) reverted.push(id);
		}
		console.log(`[p-browse-sync] ${sent} renames before the sync ended, ${reverted.length} reverted`);
		expect(reverted, 'renames the browse sync put back').toEqual([]);
	});
});
