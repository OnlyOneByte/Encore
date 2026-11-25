// While Maya sings, only her phone tunes her song, on her own card (redesign step 5): Theo's Now row reads it as one
// line, and the server refuses his, the TV's and a cookieless socket's key and guide. See docs/FRONTEND.md § The Now card.
import { mkdirSync } from 'node:fs';
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { readySong, queueReady } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import { sendPlayerCommand, serverPlayback } from './audio-probe-support';

const OUT = process.env.P22_OUT;
if (OUT) mkdirSync(OUT, { recursive: true });
// The keycap's name carries the song: "Raise <title> by one semitone".
const RAISE = '[aria-label^="Raise "][aria-label$=" by one semitone"]';

/** A key or guide frame from a socket that carries no session cookie: what any device on the LAN can open. */
async function cookieless(baseURL: string, command: Record<string, unknown>): Promise<void> {
	const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws?role=phone`);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error('the cookieless socket would not open'));
	});
	ws.send(JSON.stringify({ type: 'player:command', command }));
	await new Promise((r) => setTimeout(r, 500));
	ws.close();
}

test('only the singer changes the playing song key and guide', async ({ world }) => {
	test.setTimeout(240_000);
	// A guide mix, so the song HAS a guide to change: a refused guide frame is then a real refusal, not a no-op.
	const worker = await startFakeWorker(world, { seconds: 60, guideMix: true });
	try {
		const tv = await world.openTv();
		const maya = await world.openPhone('Maya');
		await readySong(world, maya, 'caroline');
		await queueReady(maya, 'caroline');
		const theo = await world.openPhone('Theo');
		// Theo's OWN app socket, passed through, so a frame sent on it is what an old tab would send, and the server's
		// answer reaches Theo's app (and its toast) rather than a probe socket.
		let theoToServer: ((m: string) => void) | null = null;
		const theoHeard: string[] = [];
		await theo.routeWebSocket(/\/ws/, (ws) => {
			const server = ws.connectToServer();
			theoToServer = (m) => server.send(m);
			server.onMessage((m) => {
				if (String(m).includes('"player:stale"')) theoHeard.push(String(m));
				ws.send(m);
			});
			ws.onMessage((m) => server.send(m));
		});
		await maya.goto('/queue');
		await theo.goto('/queue');
		await expect(theo.locator(SEL.queueNowCard)).toBeVisible({ timeout: 30_000 });
		const entryId = (await serverPlayback(world.baseURL)).state.currentEntryId as string;
		expect(entryId).toBeTruthy();
		const fromTheo = (command: Record<string, unknown>) =>
			theoToServer!(JSON.stringify({ type: 'player:command', command }));

		// The transport is still everyone's: Theo pauses Maya's song, which also keeps it from ending mid-probe.
		fromTheo({ cmd: 'pause' });
		await expect.poll(async () => (await serverPlayback(world.baseURL)).state.isPlaying).toBe(false);

		// Theo's phone: no keycaps and no slider anywhere. Maya's card keeps them.
		await expect(theo.locator(RAISE)).toHaveCount(0);
		await expect(theo.locator(SEL.slider)).toHaveCount(0);
		await expect(maya.locator(`${SEL.queueMyCard} ${RAISE}`)).toBeVisible();
		await expect(maya.locator(`${SEL.queueMyCard} ${SEL.slider}`)).toBeVisible();
		await expect(maya.locator(`${SEL.queueMyCard} ${SEL.guidingTrackRoot}.disabled`)).toHaveCount(0);

		// Maya raises twice from her own phone: it lands, and Theo reads it as one line.
		const raise = maya.locator(`${SEL.queueMyCard} ${RAISE}`);
		await raise.click();
		await raise.click();
		await expect.poll(async () => (await serverPlayback(world.baseURL)).state.keyShift).toBe(2);
		await expect(theo.locator(SEL.queueNowTune)).toHaveText('Key +2 · Guide off');

		// Theo's app socket, by hand (an old tab that still shows the keycaps): refused, and only Theo is told whose it is.
		fromTheo({ cmd: 'key', semitones: 5, entryId });
		await expect
			.poll(() => theoHeard.map((m) => JSON.parse(m)))
			.toEqual([{ type: 'player:stale', cmd: 'key', singerOnly: true }]);
		await expect(theo.locator('[data-sonner-toast]', { hasText: 'Only Maya can change their key.' })).toBeVisible();
		fromTheo({ cmd: 'guide', level: 0.9, entryId });
		await expect(theo.locator('[data-sonner-toast]', { hasText: 'Only Maya can change their guide.' })).toBeVisible();
		// The TV's socket and a socket with no cookie: refused too.
		await sendPlayerCommand(tv, { cmd: 'key', semitones: -4, entryId });
		await sendPlayerCommand(tv, { cmd: 'guide', level: 0.9, entryId });
		await cookieless(world.baseURL, { cmd: 'key', semitones: 7, entryId });
		await cookieless(world.baseURL, { cmd: 'guide', level: 0.9, entryId });
		await theo.waitForTimeout(1_000);
		const after = (await serverPlayback(world.baseURL)).state;
		expect({ keyShift: after.keyShift, guideLevel: after.guideLevel }).toEqual({ keyShift: 2, guideLevel: null });
		await expect(maya.locator('[data-sonner-toast]', { hasText: 'Only' })).toHaveCount(0);

		if (OUT) {
			// Shots of the cards at rest, not of the notice over them.
			await expect(theo.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 10_000 });
			for (const [who, page] of [
				['fan', theo],
				['singer', maya]
			] as const) {
				for (const vp of [
					{ width: 390, height: 844 },
					{ width: 320, height: 568 }
				]) {
					await page.setViewportSize(vp);
					await page.waitForTimeout(400);
					await page.screenshot({ path: `${OUT}/phone-now-${who}-${vp.width}.png` });
				}
			}
			await tv.screenshot({ path: `${OUT}/tv-1920.png` });
		}
	} finally {
		await worker.stop();
	}
});

/** The names of the card's running animations, its children's included. */
const cardAnims = (p: import('@playwright/test').Page) =>
	p.evaluate(() =>
		(document.querySelector('.now')?.getAnimations({ subtree: true }) ?? []).map(
			(a) => (a as CSSAnimation).animationName ?? ''
		)
	);

// `quick`: the room empties right after your song starts (two skips back to back), so only the clear on a fresh
// arrival saves the next Now row; the slow case lets your song settle first.
for (const quick of [false, true])
	test(`after your song, the next song in an emptied room fades in${quick ? ' (emptied at once)' : ''}`, async ({
		world
	}) => {
		test.setTimeout(240_000);
		const worker = await startFakeWorker(world, { seconds: 60 });
		try {
			await world.openTv();
			const maya = await world.openPhone('Maya');
			const theo = await world.openPhone('Theo');
			for (const q of ['caroline', 'believin', 'prayer']) await readySong(world, maya, q);
			await queueReady(maya, 'caroline');
			await queueReady(theo, 'believin');
			await theo.goto('/queue');
			await expect(theo.locator(SEL.queueNowCard)).toContainText(/caroline/i, { timeout: 30_000 });
			// Theo's own song starts: his card turns You're up.
			await sendPlayerCommand(maya, { cmd: 'skip' });
			await expect(theo.locator(SEL.queueNowCard)).toContainText(/believin/i, { timeout: 15_000 });
			if (!quick) {
				await expect(theo.locator(`${SEL.queueMyCard} ${RAISE}`)).toBeEnabled({ timeout: 15_000 });
				await theo.waitForTimeout(1_000);
			}
			// The room empties, so the card goes.
			await sendPlayerCommand(maya, { cmd: 'skip' });
			await expect(theo.locator(SEL.queueNowCard)).toHaveCount(0, { timeout: 15_000 });
			await theo.waitForTimeout(1_000);
			// A new song arrives: the card fades in (`.arrive`), with no grow left on it.
			await queueReady(maya, 'prayer');
			await expect(theo.locator(SEL.queueNowCard)).toBeVisible({ timeout: 30_000 });
			await expect
				.poll(() => cardAnims(theo), { timeout: 2_000, intervals: [20] })
				.toContainEqual(expect.stringContaining('arrive'));
			expect(
				(await cardAnims(theo)).some((n) => n.includes('grow-')),
				'a stale grow ran on the arriving card'
			).toBe(false);
			await expect(theo.locator(`${SEL.queueNowCard}[data-grow]`)).toHaveCount(0);
		} finally {
			await worker.stop();
		}
	});

test('your song starts while the card is still arriving: the fade is not replayed', async ({ world }) => {
	// The card arrives from an empty room (the song before failed at once, say) and your own turn starts inside its fade.
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world, { seconds: 60 });
	try {
		await world.openTv();
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		for (const q of ['caroline', 'believin']) await readySong(world, maya, q);
		await queueReady(maya, 'caroline');
		await queueReady(theo, 'believin');
		// Theo's app socket, passed through, so the room can be shown to him as empty for a moment.
		let toTheo: ((m: string) => void) | null = null;
		let lastPlayback: Record<string, unknown> | null = null;
		await theo.routeWebSocket(/\/ws/, (ws) => {
			const server = ws.connectToServer();
			toTheo ??= (m) => ws.send(m);
			server.onMessage((m) => {
				const e = JSON.parse(String(m)) as { type: string };
				if (e.type === 'playback:state') lastPlayback = e;
				ws.send(m);
			});
			ws.onMessage((m) => server.send(m));
		});
		await theo.goto('/queue');
		await expect(theo.locator(SEL.queueNowCard)).toContainText(/caroline/i, { timeout: 30_000 });
		await sendPlayerCommand(maya, { cmd: 'pause' });
		// Wait for the pause's own frame to reach Theo, or it lands after the injected idle and puts the card back.
		const paused = () => (lastPlayback as { state?: { isPlaying?: boolean } } | null)?.state?.isPlaying === false;
		await expect.poll(paused).toBe(true);
		const s = lastPlayback as unknown as { state: Record<string, unknown> };
		toTheo!(JSON.stringify({ ...s, state: { ...s.state, currentEntryId: null } }));
		await expect(theo.locator(SEL.queueNowCard)).toHaveCount(0);
		await theo.waitForTimeout(800);
		// The card arrives again, and 120 ms into its fade Theo's own song starts.
		await theo.evaluate(() => {
			const w = window as unknown as { __arrives: number; __grows: number };
			w.__arrives = 0;
			w.__grows = 0;
			document.addEventListener('animationstart', (e) => {
				const n = (e as AnimationEvent).animationName;
				if (n.includes('arrive')) w.__arrives++;
				if (n.includes('grow-')) w.__grows++;
			});
		});
		toTheo!(JSON.stringify(s));
		await expect(theo.locator(SEL.queueNowCard)).toBeVisible();
		await theo.waitForTimeout(120);
		await sendPlayerCommand(maya, { cmd: 'skip' });
		await expect(theo.locator(`${SEL.queueMyCard} ${RAISE}`)).toBeEnabled({ timeout: 15_000 });
		// Once the card is drawn, it stays drawn: sample its opacity for 1.5 s.
		const dips = await theo.evaluate(
			() =>
				new Promise<number[]>((done) => {
					const seen: number[] = [];
					let shown = false;
					const t0 = performance.now();
					const tick = () => {
						const el = document.querySelector('.now');
						const o = el ? Number(getComputedStyle(el).opacity) : 0;
						if (o > 0.95) shown = true;
						else if (shown) seen.push(o);
						if (performance.now() - t0 < 1_500) requestAnimationFrame(tick);
						else done(seen);
					};
					requestAnimationFrame(tick);
				})
		);
		expect(dips, 'the card faded out again after it was drawn').toEqual([]);
		expect(await theo.evaluate(() => (window as unknown as { __arrives: number }).__arrives), 'arrives').toBe(1);
		// The fade already shows the card at its new size, so no grow runs on top of it.
		expect(await theo.evaluate(() => (window as unknown as { __grows: number }).__grows), 'grows').toBe(0);
	} finally {
		await worker.stop();
	}
});

test('the singer’s first key tap moves nothing on a fan’s phone', async ({ world }) => {
	// A song with no guide: the fan's line is blank until the key moves, and its slot must already be there.
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world, { seconds: 60 });
	try {
		await world.openTv();
		const maya = await world.openPhone('Maya');
		await readySong(world, maya, 'caroline');
		await queueReady(maya, 'caroline');
		const theo = await world.openPhone('Theo');
		await maya.goto('/queue');
		await theo.goto('/queue');
		await expect(theo.locator(SEL.queueNowCard)).toBeVisible({ timeout: 30_000 });
		await sendPlayerCommand(maya, { cmd: 'pause' });
		await expect(theo.locator(SEL.queueNowTune)).toHaveCount(1);
		await theo.evaluate(() => {
			const w = window as unknown as { __cls: number };
			w.__cls = 0;
			new PerformanceObserver((l) => {
				for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
					if (!e.hadRecentInput) w.__cls += e.value;
			}).observe({ type: 'layout-shift', buffered: false });
		});
		await maya.locator(`${SEL.queueMyCard} ${RAISE}`).click();
		await expect(theo.locator(SEL.queueNowTune)).toHaveText('Key +1');
		await theo.waitForTimeout(800);
		expect(await theo.evaluate(() => (window as unknown as { __cls: number }).__cls), 'CLS on the fan’s phone').toBe(0);
	} finally {
		await worker.stop();
	}
});
