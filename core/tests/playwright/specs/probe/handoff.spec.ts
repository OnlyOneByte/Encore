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
import { openQueue, queueReady, readySong, transportTap } from '../../world/actors';
import { serverPlayback } from './audio-probe-support';
import type { Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

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
		// Theo is off Sing, on Queue where the transport is: "You're up" must reach him wherever he is.
		await openQueue(theo);
		await openQueue(ana);
		// The live region is MOUNTED EMPTY before the change, and the same node carries the words after it: a region
		// inserted with its text already in it is one a screen reader often never announces.
		const live = theo.locator('[data-youre-up-live]');
		await expect(live).toHaveCount(1);
		await expect(live).toHaveText('');
		await live.evaluate((el) => ((el as HTMLElement).dataset.probeSame = 'yes'));
		const t0 = Date.now();
		await transportTap(ana, 'skip');
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i, { timeout: 2_000 });
		const wait = 60 - (Date.now() - t0);
		if (wait > 0) await theo.waitForTimeout(wait);
		const gapMs = Date.now() - t0;
		await transportTap(theo, 'skip');
		expect(gapMs, 'the two taps must be a human double-tap apart, not seconds').toBeLessThan(1_000);

		// Within half a second of the taps, the same card a natural end gets.
		await expect(intro).toBeVisible({ timeout: 500 });
		await expect(intro).toContainText('Now singing');
		await expect(intro).toContainText('Theo');
		const theoId = await theoEntry();
		// On Queue his card says it (redesign step 6, an owner ruling): no flood over it, and the card's own status line
		// is the one announcement, so the layout's region stays empty here (the flood's is `youre-up-flood.spec.ts`).
		const card = theo.locator('section[aria-label="Your song"]');
		await expect(card.getByRole('status')).toHaveText('You’re up', { timeout: 500 });
		await expect(card).toContainText(/believin/i);
		await expect(theo.getByTestId('youre-up-flood')).toHaveCount(0);
		await expect(live).toHaveText('');
		await expect(live).toHaveAttribute('data-probe-same', 'yes');
		// Nobody else is told it is their turn.
		await expect(ana.getByText('You’re up')).toHaveCount(0);

		// One song went, not two: Theo is singing on every screen, and stays so past both round trips. Theo's dropped
		// tap landed on his OWN new turn, so "You're up" is all he is told (IN-02); nobody gets a stale notice.
		await tv.waitForTimeout(1_000);
		await expect(theo.locator('[data-sonner-toast]')).toHaveCount(0);
		await expect(ana.locator('[data-sonner-toast]')).toHaveCount(0);
		expect(await theoEntry()).toBe(theoId);
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await expect(intro).toContainText('Theo');
		// Still no flood on Queue once the TV's card has gone.
		await expect(theo.getByTestId('youre-up-flood')).toHaveCount(0);
	} finally {
		await worker.stop();
	}
});

test('a stale skip through the strip changes nothing and tells THAT phone the song just ended', async ({ world }) => {
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
		await transportTap(maya, 'skip');
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await transportTap(ana, 'skip');
		await ana.waitForTimeout(300);
		hold = false;
		for (const m of held.splice(0)) toAna!(m);

		await expect(ana.getByText('That song just ended. Tap again to skip this one.')).toBeVisible({ timeout: 3_000 });
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/believin/i);
		// Only the sender is told, and Theo keeps his song.
		await expect(theo.getByText('That song just ended. Tap again to skip this one.')).toHaveCount(0);
		await theo.waitForTimeout(1_000);
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
	} finally {
		await worker.stop();
	}
});

// The two draft probes below run on one singer's two turns in a row: only that phone tunes both songs. Theo skips,
// and his one line for the playing song is the room's level read on another phone.

test('a guide pick on the last song is not shown, or applied, on the next card', async ({ world }) => {
	// Maya picks Full on the song her phone still shows after Theo's skip. The pick names caroline, so the server
	// drops it as stale; believin's level may not move, and her believin card may not keep the pick.
	const worker = await startFakeWorker(world, { guideMix: true });
	try {
		const { maya, theo } = await keyGuideRoom(world, true);
		const full = maya.locator(`${SEL.queueMyCard} ${SEL.guideSegments}`).getByRole('radio', { name: 'Full' });
		await expect(full).toHaveAttribute('aria-checked', 'false');
		await hold!(true);
		await transportTap(theo, 'skip');
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
		const nextStart = (await serverPlayback(world.baseURL)).state;
		await full.click();
		await maya.waitForTimeout(300);
		await hold!(false);
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/believin/i);
		// Maya's checked segment is the ROOM's level for believin, the same as Theo's line shows.
		const checked = maya.locator(`${SEL.queueMyCard} [role="radio"][aria-checked="true"]`);
		await expect
			.poll(async () => ((await checked.count()) ? await checked.innerText() : null), {
				message: 'Maya’s dropped pick from caroline stayed on her believin card'
			})
			.toBe(await roomGuide(theo));
		const after = (await serverPlayback(world.baseURL)).state;
		expect(after.currentEntryId).toBe(nextStart.currentEntryId);
		expect(after.guideLevel, 'a pick made on caroline changed believin’s guide').toBe(nextStart.guideLevel);
		await expect(maya.getByText('That song already ended.')).toBeVisible({ timeout: 2_000 });
		await expect(theo.getByText('That song already ended.')).toHaveCount(0);
	} finally {
		await worker.stop();
	}
});

test('a key draft from the last song is not shown, or stepped from, on the next card', async ({ world }) => {
	// A +1 on the last song is dropped as stale, so the room never agrees with the draft
	// and nothing cleared it: the next card read "+1", and the next "+" sent +2 over that song's preset.
	const worker = await startFakeWorker(world);
	try {
		const { maya, theo } = await keyGuideRoom(world, true);
		const keyLabel = (p: Page) => p.locator('.deck .ctl .control-label').first().innerText();
		await hold!(true);
		await transportTap(theo, 'skip');
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await maya
			.getByRole('button', { name: /^Raise .+ by one semitone$/ })
			.first()
			.click();
		await maya.waitForTimeout(300);
		await hold!(false);
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await maya.waitForTimeout(300);
		const nextStart = (await serverPlayback(world.baseURL)).state;
		await expect(maya.locator('.deck .ctl')).toBeVisible();
		expect(shiftOf(await keyLabel(maya))).toBe(nextStart.keyShift);
		expect(shiftOf(await roomTune(theo))).toBe(nextStart.keyShift);
		// The next tap steps from the ROOM's key for believin, not from the dead draft.
		await maya
			.getByRole('button', { name: /^Raise .+ by one semitone$/ })
			.first()
			.click();
		await expect.poll(async () => (await serverPlayback(world.baseURL)).state.keyShift).toBe(nextStart.keyShift + 1);
	} finally {
		await worker.stop();
	}
});

/** Holds or releases Maya's INCOMING socket frames; set up by `keyGuideRoom(world, true)`. */
let hold: ((on: boolean) => Promise<void>) | null = null;

/** Theo's one line for the playing song, or '' when it names nothing. */
const roomTune = async (p: Page) =>
	(await p.locator(SEL.queueNowTune).count()) ? await p.locator(SEL.queueNowTune).innerText() : '';
/** The room's guide level as Theo's line names it, as the Guide segment that matches it: "Guide off" is "Off". */
const roomGuide = async (p: Page) => {
	const m = /Guide (off|(\d+)%)/.exec(await roomTune(p));
	if (!m) return null;
	return ({ '0': 'Off', '30': 'Low', '100': 'Full' } as Record<string, string>)[m[2] ?? '0'] ?? null;
};
/** The shift a key label or line names, `Key · +1`, `Key +1` or `Key −2`; 0 when it names none. */
const shiftOf = (s: string) => {
	const m = /Key(?: ·)? ([+−-])(\d+)/.exec(s);
	return m ? (m[1] === '+' ? 1 : -1) * Number(m[2]) : 0;
};

/** Maya singing caroline with her believin next, both on Maya's Queue tab; Theo, a guest, on his. */
async function keyGuideRoom(world: World, holdable = false): Promise<{ maya: Page; theo: Page }> {
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	for (const q of ['caroline', 'believin']) await readySong(world, maya, q);
	const tv = await world.openTv();
	await queueReady(maya, 'caroline');
	await expect(tv.locator(SEL.stateNext)).toBeVisible({ timeout: 30_000 });
	await queueReady(maya, 'believin');
	if (holdable) {
		let held = false;
		const queue: (string | Buffer)[] = [];
		let toMaya: ((m: string | Buffer) => void) | null = null;
		await maya.routeWebSocket(/\/ws/, (ws) => {
			const server = ws.connectToServer();
			toMaya = (m) => ws.send(m);
			server.onMessage((m) => (held ? queue.push(m) : ws.send(m)));
			ws.onMessage((m) => server.send(m));
		});
		await maya.reload();
		hold = async (on) => {
			held = on;
			if (!on) for (const m of queue.splice(0)) toMaya!(m);
		};
	}
	await maya.getByRole('link', { name: 'Queue' }).click();
	await expect(maya.locator('.deck .ctl')).toBeVisible();
	await theo.getByRole('link', { name: 'Queue' }).click();
	await expect(theo.locator(SEL.queueNowCard)).toBeVisible();
	return { maya, theo };
}

test('a natural end hands over with no failure flash over the Now singing card', async ({ world }) => {
	// Review r2, 974-2. The slot's play() for the song being left rejected with AbortError once the next song's src
	// landed, and "This song won't play" flashed over the card on EVERY natural end, filed against the new song. That
	// overlay is gone (proposal 11); its successor is the Skipped takeover, which a natural end must never raise.
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
				if (document.querySelector('.state-error'))
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

test('a stale restart on your own new turn: its notice shows on top of the "You’re up" flood and never moves', async ({
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
		await transportTap(maya, 'skip');
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/believin/i);
		// A RESTART, not a skip: a stale skip on your own new turn says nothing (the IN-02 probe below), but a stale
		// restart still gets its notice, and that one must stack.
		await transportTap(theo, 'restart');
		await theo.waitForTimeout(300);
		hold = false;
		for (const m of held.splice(0)) toTheo!(m);

		const sheet = theo.getByTestId('youre-up-flood');
		const toast = theo
			.locator('[data-sonner-toast]')
			.filter({ hasText: 'A new song just started. Tap again to restart it.' });
		// The tap was on Queue, where the card says it; on Sing the same turn is a flood, and the notice must show on it.
		await theo.locator(SEL.tab).filter({ hasText: 'Sing' }).first().click();
		await expect(sheet).toBeVisible({ timeout: 2_000 });
		await expect(toast).toBeVisible({ timeout: 2_000 });
		// Let the toast's own entrance settle before measuring.
		await theo.waitForTimeout(600);
		// The flood covers the phone, so the notice is drawn ON it: a tap at its centre reaches the toast, not the flood.
		const t = (await toast.boundingBox())!;
		const onTop = await theo.evaluate(
			([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-sonner-toast]'),
			[t.x + t.width / 2, t.y + t.height / 2]
		);
		expect(onTop, `toast ${JSON.stringify(t)} under the flood`).toBe(true);
		// The toaster's phone sides are `--sheet-gutter`, the same token "didn't play" uses.
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

test('a double skip onto your OWN turn shows only "You’re up", no stale notice', async ({ world }) => {
	// integration-1, IN-02. Theo taps skip on Maya's song after Ana already has: his tap is dropped as stale, but it
	// landed on his own new turn, so it got what it asked for. "You're up" says so; a notice beside it read as if his
	// skip had failed. His socket is held, so his tap names Maya's song whatever the timing.
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const ana = await world.openPhone('Ana');
		for (const q of ['caroline', 'believin', 'prayer']) await readySong(world, maya, q);
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');

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
		// Every toast that ever appears on Theo's phone, so a notice that comes and goes is caught too.
		await theo.evaluate(() => {
			const w = window as unknown as { toasts: string[] };
			w.toasts = [];
			new MutationObserver(() => {
				for (const n of document.querySelectorAll('[data-sonner-toast]')) w.toasts.push(n.textContent ?? '');
			}).observe(document.body, { subtree: true, childList: true });
		});

		hold = true;
		await transportTap(ana, 'skip');
		await expect(ana.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await transportTap(theo, 'skip');
		await theo.waitForTimeout(300);
		hold = false;
		for (const m of held.splice(0)) toTheo!(m);

		// He tapped on Queue, so his card is what says it there (no flood over it).
		await expect(theo.locator('section[aria-label="Your song"]').getByRole('status')).toHaveText('You’re up', {
			timeout: 2_000
		});
		await expect(theo.getByTestId('youre-up-flood')).toHaveCount(0);
		await theo.waitForTimeout(1_500);
		expect(await theo.evaluate(() => (window as unknown as { toasts: string[] }).toasts)).toEqual([]);
		// One song went: Theo's turn survived his own dropped tap.
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
	} finally {
		await worker.stop();
	}
});

test('a stale skip in a room gone idle says the song already ended, as information', async ({ world }) => {
	// Review of #985, must-fix 1. Maya skips the only song while Ana's socket is held, so Ana's tap names a song in a
	// room where nothing plays now. "Tap again to skip this one" would name a song that is not there.
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const ana = await world.openPhone('Ana');
		await readySong(world, maya, 'caroline');
		await queueReady(maya, 'caroline');

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
		await transportTap(maya, 'skip');
		await expect.poll(() => serverPlayback(world.baseURL).then(({ state }) => state.currentEntryId)).toBeNull();
		await transportTap(ana, 'skip');
		await ana.waitForTimeout(300);
		hold = false;
		for (const m of held.splice(0)) toAna!(m);

		const toast = ana.locator('[data-sonner-toast].transport-notice');
		await expect(toast).toHaveText('That song already ended.', { timeout: 3_000 });
		// Nothing went wrong, the tap just named a song that had gone: the info glyph, not the error one. A short timeout,
		// well inside the toast's 4 s life, so a regression fails on the TYPE ("unexpected value") and not "not found".
		await expect(toast).toHaveAttribute('data-type', 'info', { timeout: 2_000 });
	} finally {
		await worker.stop();
	}
});
