// ONE HANDOFF MOMENT (UI-02, BE-04), in a real room. Maya is singing on the TV, Theo is next, Ana after him. Ana and
// Theo both tap skip, a human double-tap apart. The TV must put up the same "Now singing Theo" card a natural end
// gets, within half a second, Theo's phone must say "You're up" on whatever tab it is on, and only ONE song may go:
// Theo's turn must survive the second tap. The held-socket test below covers the other half: a tap that was still in
// flight when the song changed.
//
// Before this change the TV dropped Theo straight into his lyrics with no card (the sweep's `flow-03` frame), and the
// second skip — aimed at Maya's song — advanced past Theo to Ana.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import { serverPlayback } from './audio-probe-support';
import type { Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

async function readySong(world: World, phone: Page, query: string): Promise<void> {
	const track = await world.awaitDemoTrack(query);
	const res = await phone.request.post('/api/process', { data: { mediaId: track.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${track.title}": ${res.status()}`);
	await expect
		.poll(
			async () => {
				const body = (await phone.request.get('/api/library').then((r) => r.json())) as {
					library: { id: string; instrumentalRef?: string | null }[];
				};
				return body.library.some((m) => m.id === track.id && !!m.instrumentalRef);
			},
			{ timeout: 60_000, message: `"${track.title}" never reached ready` }
		)
		.toBe(true);
}

async function queueReady(phone: Page, query: string): Promise<void> {
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(query);
	await phone.locator(SEL.addTurn).first().click();
}

test('a double skip shows the handoff card for the next singer, tells their phone, and takes only one song', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		for (const q of ['caroline', 'believin', 'prayer']) await readySong(world, maya, q);

		const tv = await world.openTv();
		await queueReady(maya, 'caroline');
		// The evening's first song opens on its own card; wait until it has given way to the song.
		const intro = tv.locator(SEL.stateNext);
		await expect(intro).toBeVisible({ timeout: 30_000 });
		await expect(intro).toContainText('Maya');
		await expect(intro).toBeHidden({ timeout: 10_000 });
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/caroline/i);

		await expect(tv.locator('.upnext')).toContainText('Theo');
		const theoEntry = () => serverPlayback(world.baseURL).then(({ state }) => state.currentEntryId);
		// TWO REAL TAPS, the second 40-100 ms after the first and AFTER Theo's strip has already redrawn to his own
		// song: the case the server's stale guard alone could not catch (review r2, 974-M2), because by then the
		// tap named Theo's song. The settle window (`$lib/transport-target`) keeps it naming Maya's.
		// Theo is on another tab: "You're up" must reach him wherever he is.
		await theo.getByRole('link', { name: 'Library' }).click();
		// The live region is MOUNTED EMPTY before the change, and the same node carries the words after it: a region
		// inserted with its text already in it is one a screen reader often never announces.
		const live = theo.locator('[data-youre-up-live]');
		await expect(live).toHaveCount(1);
		await expect(live).toHaveText('');
		await live.evaluate((el) => ((el as HTMLElement).dataset.probeSame = 'yes'));
		const t0 = Date.now();
		await ana.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i, { timeout: 2_000 });
		const wait = 60 - (Date.now() - t0);
		if (wait > 0) await theo.waitForTimeout(wait);
		const gapMs = Date.now() - t0;
		await theo.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		expect(gapMs, 'the two taps must be a human double-tap apart, not seconds').toBeLessThan(1_000);

		// Within half a second of the taps, the same card a natural end gets.
		await expect(intro).toBeVisible({ timeout: 500 });
		await expect(intro).toContainText('Now singing');
		await expect(intro).toContainText('Theo');
		const theoId = await theoEntry();
		const youreUp = theo.locator('.youre-up');
		await expect(youreUp).toBeVisible({ timeout: 500 });
		await expect(youreUp).toContainText(/believin/i);
		// Announced as the words alone ("You're up, <song>"), from the SAME node; the OK button is not in it.
		await expect(live).toHaveText(/^You’re up, .*believin/i);
		await expect(live).toHaveAttribute('data-probe-same', 'yes');
		await expect(live).toHaveAttribute('role', 'status');
		await expect(live.getByRole('button')).toHaveCount(0);
		// What assistive tech is given: the words ONCE (the sheet's own copy is hidden from it), and the OK button.
		// The sheet itself gives assistive tech ONLY its button: its words are the live region's, and read once there.
		// The button's name carries the context the hidden words would have given it.
		expect(await youreUp.ariaSnapshot()).toBe('- button "OK, dismiss You’re up": OK');
		// Nobody else is told it is their turn.
		await expect(ana.getByText('You’re up')).toHaveCount(0);

		// One song went, not two: Theo is singing on every screen, and stays so past both round trips. The phone whose
		// tap was dropped is told why; the other is not.
		await expect(theo.getByText('Already skipped. Tap again to skip this one too.')).toBeVisible({ timeout: 2_000 });
		await expect(ana.getByText('Already skipped. Tap again to skip this one too.')).toHaveCount(0);
		await tv.waitForTimeout(1_000);
		expect(await theoEntry()).toBe(theoId);
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await expect(intro).toContainText('Theo');
		// It goes by itself, with the TV's card.
		await expect(youreUp).toHaveCount(0, { timeout: 5_000 });
	} finally {
		await worker.stop();
	}
});

test('a stale skip through the strip changes nothing and tells THAT phone it was already skipped', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		for (const q of ['caroline', 'believin']) await readySong(world, maya, q);
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');

		// Ana's socket is HELD from the moment Maya skips, so her strip still shows Maya's song when she taps.
		let hold = false;
		const held: (string | Buffer)[] = [];
		let toAna: ((m: string | Buffer) => void) | null = null;
		await ana.routeWebSocket(/\/ws/, (ws) => {
			const server = ws.connectToServer();
			toAna = (m) => ws.send(m);
			server.onMessage((m) => (hold ? held.push(m) : ws.send(m)));
			ws.onMessage((m) => server.send(m));
		});
		await ana.reload();
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 15_000 });

		hold = true;
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await ana.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await ana.waitForTimeout(300);
		hold = false;
		for (const m of held.splice(0)) toAna!(m);

		await expect(ana.getByText('Already skipped. Tap again to skip this one too.')).toBeVisible({ timeout: 3_000 });
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/believin/i);
		// Only the sender is told, and Theo keeps his song.
		await expect(theo.getByText('Already skipped. Tap again to skip this one too.')).toHaveCount(0);
		await theo.waitForTimeout(1_000);
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
	} finally {
		await worker.stop();
	}
});

test('a guide drag begun on the last song does not carry onto the next singer’s song', async ({ world }) => {
	// Review r2, 974-M1 (its R3). A skip goes straight from Maya's entry to Theo's, so `nowEntry` is never null in
	// between: the rest of Ana's drag was re-sent under Theo's id (0.6, then 0.9 on release).
	const worker = await startFakeWorker(world, { guideMix: true });
	try {
		const { maya, theo, ana } = await keyGuideRoom(world);
		await theo.getByRole('link', { name: 'Queue' }).click();
		const slider = ana.locator('.now [role="slider"]').first();
		await expect(slider).toBeVisible();
		const box = (await slider.boundingBox())!;
		const track = (await ana.locator('.now [data-slot="slider"]').first().boundingBox()) ?? box;
		const y = box.y + box.height / 2;
		await ana.mouse.move(box.x + box.width / 2, y);
		await ana.mouse.down();
		await ana.mouse.move(track.x + track.width * 0.6, y, { steps: 4 });

		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await ana.waitForTimeout(200);
		const theoStart = (await serverPlayback(world.baseURL)).state;
		// Ana's readout is the ROOM's level for Theo's song, the same as Theo's own phone shows: neither the draft from
		// Maya's song nor the rest of the stale drag may show on Theo's card.
		const theoSlider = theo.locator('.now [role="slider"]').first();
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
		const readouts = async () => [
			await slider.getAttribute('aria-valuenow'),
			await theoSlider.getAttribute('aria-valuenow')
		];
		const same = ([a, t]: (string | null)[]) => a !== null && a === t;
		await expect
			.poll(async () => same(await readouts()), { message: 'Ana kept the last song’s draft on Theo’s card' })
			.toBe(true);
		await ana.mouse.move(track.x + track.width * 0.9, y, { steps: 4 });
		await ana.waitForTimeout(300);
		expect(same(await readouts()), `the stale drag moved Theo’s card on Ana’s phone: ${await readouts()}`).toBe(true);
		await ana.mouse.up();
		await ana.waitForTimeout(800);
		const after = (await serverPlayback(world.baseURL)).state;
		expect(after.currentEntryId).toBe(theoStart.currentEntryId);
		expect(after.guideLevel, 'a drag begun on Maya’s song changed Theo’s guide').toBe(theoStart.guideLevel);
		// The rest of the drag named Maya's song, so the server dropped it and said so to Ana.
		await expect(ana.getByText('That song already ended.')).toBeVisible({ timeout: 2_000 });
		await expect(theo.getByText('That song already ended.')).toHaveCount(0);
	} finally {
		await worker.stop();
	}
});

test('a guide draft the room never agreed with is not shown on the next singer’s card', async ({ world }) => {
	// The song-change reset is the only thing that clears a guide draft the server dropped: Ana drags on the song
	// her phone still shows after Maya's skip, the server drops it as stale, so no echo ever agrees with her draft.
	const worker = await startFakeWorker(world, { guideMix: true });
	try {
		const { maya, theo, ana } = await keyGuideRoom(world, true);
		await theo.getByRole('link', { name: 'Queue' }).click();
		const slider = ana.locator('.now [role="slider"]').first();
		await expect(slider).toBeVisible();
		const box = (await slider.boundingBox())!;
		const track = (await ana.locator('.now [data-slot="slider"]').first().boundingBox()) ?? box;
		const y = box.y + box.height / 2;
		await hold!(true);
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await ana.mouse.move(box.x + box.width / 2, y);
		await ana.mouse.down();
		await ana.mouse.move(track.x + track.width * 0.7, y, { steps: 4 });
		await ana.mouse.up();
		await ana.waitForTimeout(300);
		await hold!(false);
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/believin/i);
		const theoSlider = theo.locator('.now [role="slider"]').first();
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
		const readouts = async () => [
			await slider.getAttribute('aria-valuenow'),
			await theoSlider.getAttribute('aria-valuenow')
		];
		await expect
			.poll(
				async () => {
					const [a, t] = await readouts();
					return a !== null && a === t;
				},
				{ message: 'Ana’s dropped draft from Maya’s song stayed on Theo’s card' }
			)
			.toBe(true);
		await expect(ana.getByText('That song already ended.')).toBeVisible({ timeout: 2_000 });
	} finally {
		await worker.stop();
	}
});

test('a key draft from the last song is not shown, or stepped from, on the next singer’s card', async ({ world }) => {
	// Review r2, 974-M1 (its R2). Ana's +1 on Maya's song is dropped as stale, so the room never agrees with her draft
	// and nothing cleared it: Theo's card read "+1" on Ana's phone, and her next "+" sent +2 over Theo's preset.
	const worker = await startFakeWorker(world);
	try {
		const { maya, theo, ana } = await keyGuideRoom(world, true);
		const keyLabel = (p: Page) => p.locator('.now .ctl .control-label').first().innerText();
		await hold!(true);
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await ana.getByRole('button', { name: 'Raise by one semitone' }).first().click();
		await ana.waitForTimeout(300);
		await hold!(false);
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await ana.waitForTimeout(300);
		const theoStart = (await serverPlayback(world.baseURL)).state;
		await theo.getByRole('link', { name: 'Queue' }).click();
		await expect(theo.locator('.now .ctl')).toBeVisible();
		expect(await keyLabel(ana)).toBe(await keyLabel(theo));
		// The next tap steps from the ROOM's key for Theo's song, not from the dead draft.
		await ana.getByRole('button', { name: 'Raise by one semitone' }).first().click();
		await expect.poll(async () => (await serverPlayback(world.baseURL)).state.keyShift).toBe(theoStart.keyShift + 1);
	} finally {
		await worker.stop();
	}
});

/** Holds or releases Ana's INCOMING socket frames; set up by `keyGuideRoom(world, true)`. */
let hold: ((on: boolean) => Promise<void>) | null = null;

/** Maya singing, Theo next, Ana on the Queue tab watching Maya's card. */
async function keyGuideRoom(world: World, holdable = false): Promise<{ maya: Page; theo: Page; ana: Page }> {
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	const ana = await world.openPhone('Ana');
	for (const q of ['caroline', 'believin']) await readySong(world, maya, q);
	const tv = await world.openTv();
	await queueReady(maya, 'caroline');
	await expect(tv.locator(SEL.stateNext)).toBeVisible({ timeout: 30_000 });
	await queueReady(theo, 'believin');
	if (holdable) {
		let held = false;
		const queue: (string | Buffer)[] = [];
		let toAna: ((m: string | Buffer) => void) | null = null;
		await ana.routeWebSocket(/\/ws/, (ws) => {
			const server = ws.connectToServer();
			toAna = (m) => ws.send(m);
			server.onMessage((m) => (held ? queue.push(m) : ws.send(m)));
			ws.onMessage((m) => server.send(m));
		});
		await ana.reload();
		hold = async (on) => {
			held = on;
			if (!on) for (const m of queue.splice(0)) toAna!(m);
		};
	}
	await ana.getByRole('link', { name: 'Queue' }).click();
	await expect(ana.locator('.now .ctl')).toBeVisible();
	return { maya, theo, ana };
}

test('a natural end hands over with no "won’t play" flash over the Now singing card', async ({ world }) => {
	// Review r2, 974-2. The slot's play() for the song being left rejected with AbortError once the next song's src
	// landed, and "This song won't play" flashed over the card on EVERY natural end, filed against the new song.
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		for (const q of ['caroline', 'believin']) await readySong(world, maya, q);
		const tv = await world.openTv();
		await tv.evaluate(() => {
			const w = window as unknown as { flashes: string[] };
			w.flashes = [];
			new MutationObserver(() => {
				if (document.querySelector('.silent-room'))
					w.flashes.push(document.querySelector('.state-next')?.textContent ?? '(no card)');
			}).observe(document.body, { subtree: true, childList: true });
		});
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');
		const intro = tv.locator(SEL.stateNext);
		// Maya's 8 s song runs out into Theo's: the natural-end card for Theo, then his song.
		await expect(intro).toContainText('Theo', { timeout: 30_000 });
		await expect(intro).toBeHidden({ timeout: 10_000 });
		expect(await tv.evaluate(() => (window as unknown as { flashes: string[] }).flashes)).toEqual([]);
	} finally {
		await worker.stop();
	}
});

test('when your own stale skip makes it your turn, the toast stacks above "You’re up" instead of over it', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		for (const q of ['caroline', 'believin']) await readySong(world, maya, q);
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');

		// Theo's socket is held, so his strip still shows Maya's song when he taps skip on it.
		let hold = false;
		const held: (string | Buffer)[] = [];
		let toTheo: ((m: string | Buffer) => void) | null = null;
		await theo.routeWebSocket(/\/ws/, (ws) => {
			const server = ws.connectToServer();
			toTheo = (m) => ws.send(m);
			server.onMessage((m) => (hold ? held.push(m) : ws.send(m)));
			ws.onMessage((m) => server.send(m));
		});
		await theo.reload();
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/caroline/i, { timeout: 15_000 });

		hold = true;
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await theo.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await theo.waitForTimeout(300);
		hold = false;
		for (const m of held.splice(0)) toTheo!(m);

		const sheet = theo.locator('.youre-up');
		const toast = theo
			.locator('[data-sonner-toast]')
			.filter({ hasText: 'Already skipped. Tap again to skip this one too.' });
		await expect(sheet).toBeVisible({ timeout: 2_000 });
		await expect(toast).toBeVisible({ timeout: 2_000 });
		// Let the toast's own entrance settle before measuring.
		await theo.waitForTimeout(600);
		const s = (await sheet.boundingBox())!;
		const t = (await toast.boundingBox())!;
		expect(t.y + t.height, `toast ${JSON.stringify(t)} vs sheet ${JSON.stringify(s)}`).toBeLessThanOrEqual(s.y);
		// The two stacked notices share one gutter token, so their edges line up (review r3, 976-3).
		expect(Math.abs(t.x - s.x), `left edges: toast ${t.x}, sheet ${s.x}`).toBeLessThanOrEqual(1);
		expect(Math.abs(t.x + t.width - (s.x + s.width)), 'right edges').toBeLessThanOrEqual(1);
		// ...because both read the SAME token, not because sonner's default happens to equal it today: the toaster's
		// phone sides are `--sheet-gutter`, as the sheet's are.
		const toasterSides = await theo
			.locator('[data-sonner-toaster]')
			.first()
			.evaluate((el) => [
				(el as HTMLElement).style.getPropertyValue('--mobile-offset-left').trim(),
				(el as HTMLElement).style.getPropertyValue('--mobile-offset-right').trim()
			]);
		expect(toasterSides).toEqual(['var(--sheet-gutter)', 'var(--sheet-gutter)']);

		// The sheet goes at the TV's 2.5 s and the toast lives 4 s. Sampled EVERY frame until the toast's node has
		// left the page, its closing frames included: it may not move while it is up, and it may never jump. The
		// round-2 fix held the offset only until sonner said "closing", and the toast dropped 143 px at full opacity
		// on the first frame of its exit (review r3, 976-M1); sonner's own exit slide moves a few px a frame.
		const frames = await theo.evaluate(
			() =>
				new Promise<{ y: number; removed: boolean }[]>((resolve) => {
					const out: { y: number; removed: boolean }[] = [];
					const t0 = performance.now();
					const tick = () => {
						const el = document.querySelector('[data-sonner-toast].transport-notice') as HTMLElement | null;
						if (el) out.push({ y: el.getBoundingClientRect().y, removed: el.dataset.removed === 'true' });
						if ((!el && out.length > 0) || performance.now() - t0 > 8_000) return resolve(out);
						requestAnimationFrame(tick);
					};
					tick();
				})
		);
		await expect(sheet).toHaveCount(0);
		await expect(toast).toHaveCount(0);
		const open = frames.filter((f) => !f.removed).map((f) => f.y);
		expect(
			frames.some((f) => f.removed),
			'sampled through the toast’s exit'
		).toBe(true);
		expect(
			Math.max(...open) - Math.min(...open),
			`toast y while open: ${open.slice(0, 2)}…${open.slice(-2)}`
		).toBeLessThan(2);
		const steps = frames.slice(1).map((f, i) => Math.abs(f.y - frames[i]!.y));
		expect(
			Math.max(...steps),
			`largest one-frame move of the toast: ${JSON.stringify(frames.filter((f) => f.removed).slice(0, 4))}`
		).toBeLessThan(24);
	} finally {
		await worker.stop();
	}
});
