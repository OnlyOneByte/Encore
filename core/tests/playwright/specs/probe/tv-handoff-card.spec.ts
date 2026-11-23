// THE "NOW SINGING" CARD NAMES ONLY THE NEW SINGER, and only at a change of singer (integration sweep 1: IN-03, IN-P1).
//
// IN-03: at a natural end whose preload had not finished, the TV's `loading` card painted `current`, which is still
// the singer who just finished until the server's `nowplaying:changed` lands. Seen once in three runs under load, as
// "Up next Theo", then "Now singing Ana", then "Now singing Theo". Here the miss is FORCED: the TV's media requests
// are held from the moment the next song is queued until the last one has ended, on half the handoffs. With the
// intro on, #1001 raises the next singer's card at the miss; with it off, only the loading card's own guard holds.
//
// IN-P1: reloading the TV mid-song put the card back over the song for its whole hold (~2.6 s).
//
// #989: a TV opened onto a song already up showed its lyrics beside the loading card, then the card alone for the
// hold, then the lyrics again.
//
// All three read every render of the card, and whether lyrics are up, through a MutationObserver, because the flash lasts one server round trip and
// a sampler 150 ms apart misses it.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import { processTrack, sendPlayerCommand, serverPlayback, tapStage, TRACKS } from './audio-probe-support';
import type { Page } from '@playwright/test';

interface CardRender {
	at: number;
	text: string;
	/** A lyric line is on the stage. */
	lyrics: boolean;
}

/** Every text the `.state-next` card shows ('' when it is gone), and whether lyrics are up, stamped with `Date.now()`.
 *  Installed before the page's first script, and again on every reload. */
async function installRecorder(tv: Page): Promise<void> {
	await tv.addInitScript(() => {
		const w = window as unknown as { probeCards: CardRender[] };
		w.probeCards = [];
		let last = '';
		const read = () => {
			// A card is UP when it is mounted and, where a takeover layer fades cards out (#1018), that layer is shown:
			// a card on its way out stays mounted under a fading layer.
			const layer = document.querySelector('.takeover-layer');
			const up = !layer || layer.classList.contains('shown');
			const el = up ? document.querySelector<HTMLElement>('.state-next') : null;
			const text = el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
			const lyrics = !!document.querySelector('.lyrics .row');
			if (`${text}|${lyrics}` === last) return;
			last = `${text}|${lyrics}`;
			w.probeCards.push({ at: Date.now(), text, lyrics });
		};
		new MutationObserver(read).observe(document, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
			attributeFilter: ['class']
		});
	});
}

async function recordCards(tv: Page): Promise<void> {
	await installRecorder(tv);
	await tv.reload();
}

const cardsSince = (tv: Page, since: number) =>
	tv.evaluate((t) => (window as unknown as { probeCards: CardRender[] }).probeCards.filter((c) => c.at >= t), since);

/** Renders where the card and the lyrics were on screen at once: the card was covering a stage already up. */
const overLyrics = (renders: CardRender[]) => renders.filter((r) => r.text && r.lyrics).map((r) => r.text);

/** The TV's `ended` frame reaches the server `ms` late, so the server's confirm of the next singer lands late too. */
async function delayEnded(tv: Page, ms: number): Promise<void> {
	await tv.evaluate((hold) => {
		const send = WebSocket.prototype.send;
		WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
			if (typeof data === 'string' && data.includes('"status":"ended"')) {
				setTimeout(() => send.call(this, data), hold);
				return;
			}
			return send.call(this, data);
		};
	}, ms);
}

async function queueReady(phone: Page, q: string): Promise<void> {
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(q);
	await phone.locator(SEL.addTurn).first().click();
}

// With the intro OFF there is no card at a gapless end, so every handoff there is a forced miss: the loading card is
// the only card left, and it must name the singer starting too.
for (const intro of [
	{ on: true, ends: 20, title: 'at 20 natural ends, half with a missed preload' },
	{ on: false, ends: 6, title: 'with the intro off, at 6 natural ends with a missed preload' }
]) {
	test(`${intro.title}, the card only ever names the singer who is starting`, async ({ world }) => {
		test.setTimeout(600_000);
		const worker = await startFakeWorker(world);
		try {
			const maya = await world.openPhone('Maya');
			const theo = await world.openPhone('Theo');
			const song = { Maya: TRACKS.caroline, Theo: TRACKS.believin };
			for (const t of Object.values(song)) await processTrack(maya, world.baseURL, t);
			if (!intro.on) {
				await world.becomeHost(maya);
				const res = await maya.request.put('/api/settings/room', { data: { songIntroEnabled: false } });
				expect(res.ok(), `could not turn the intro off: ${res.status()}`).toBe(true);
			}

			const tv = await world.openTv();
			// Held media requests wait here until the handoff is under way.
			let hold = false;
			const held: (() => void)[] = [];
			await tv.route(
				(u) => u.pathname.startsWith('/media/'),
				(route) => {
					if (hold) held.push(() => void route.continue().catch(() => {}));
					else void route.continue().catch(() => {});
				}
			);
			await recordCards(tv);
			await tapStage(tv);
			const card = tv.locator(SEL.stateNext);
			// Intro off: the confirm is held back, so the card must go up on the TV's own end, not on the server's word.
			if (!intro.on) await delayEnded(tv, 2_500);

			await queueReady(maya, song.Maya.q);
			if (intro.on) await expect(card).toContainText('Maya', { timeout: 30_000 });
			else await expect(tv.locator(SEL.lyricsRow).first()).toBeVisible({ timeout: 30_000 });
			await expect(card).toBeHidden({ timeout: 15_000 });

			const flashes: string[] = [];
			let singing: 'Maya' | 'Theo' = 'Maya';
			for (let i = 0; i < intro.ends; i++) {
				const next: 'Maya' | 'Theo' = singing === 'Maya' ? 'Theo' : 'Maya';
				// Two missed, two gapless, so each singer hands over both ways.
				const missed = !intro.on || Math.floor(i / 2) % 2 === 0;
				hold = missed;
				await queueReady(next === 'Maya' ? maya : theo, song[next].q);
				await expect(tv.locator('.upnext')).toContainText(next, { timeout: 10_000 });
				const before = (await serverPlayback(world.baseURL)).state.currentEntryId;
				const t0 = Date.now();
				// Near the end of an 8 s track, so the song ends by itself.
				await sendPlayerCommand(singing === 'Maya' ? maya : theo, { cmd: 'seek', positionSec: 7.2 });
				if (!intro.on) {
					// Up at the end, before the server confirms, and labelled "Up next" until it does. The seek above is the
					// mid-song command that once made the TV think it had been reloaded and hold the card back.
					await expect(card).toContainText(next, { timeout: 2_000 });
					await expect(card).toContainText(/up next/i);
					const now = (await serverPlayback(world.baseURL)).state.currentEntryId;
					expect(now, `handoff ${i + 1}: the card waited for the server's confirm`).toBe(before);
				}
				await expect
					.poll(async () => (await serverPlayback(world.baseURL)).state.currentEntryId, { timeout: 15_000 })
					.not.toBe(before);
				if (missed) await tv.waitForTimeout(300);
				// Intro off: the loading card is the only card, and it goes the moment the held audio lands.
				if (!intro.on) await expect(card).toContainText(next, { timeout: 10_000 });
				hold = false;
				for (const go of held.splice(0)) go();

				if (intro.on) await expect(card).toContainText(next, { timeout: 10_000 });
				await expect(card).toBeHidden({ timeout: 15_000 });
				const renders = await cardsSince(tv, t0);
				for (const text of overLyrics(renders)) flashes.push(`handoff ${i + 1}: card over lyrics: "${text}"`);
				const shown = renders.map((c) => c.text).filter(Boolean);
				expect(shown.length, `handoff ${i + 1}: no card was recorded at all`).toBeGreaterThan(0);
				for (const text of shown) {
					if (text.includes(singing) || !text.includes(next)) {
						flashes.push(`handoff ${i + 1} (${missed ? 'missed preload' : 'gapless'}) ${singing}→${next}: "${text}"`);
					}
				}
				singing = next;
			}
			expect(flashes, 'the card named someone other than the singer starting').toEqual([]);
		} finally {
			await worker.stop();
		}
	});
}

test('on a slow round trip one handoff is one card: no gap of lyrics, no second hold', async ({ world }) => {
	// From the #1018 review: with the server's confirm 3.5 s late and a missed preload, the hold ended at 2.5 s, the
	// stage showed the finished song's lyrics for ~1 s, and the late confirm raised a second card with a second hold.
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		for (const t of [TRACKS.caroline, TRACKS.believin]) await processTrack(maya, world.baseURL, t);
		const tv = await world.openTv();
		let hold = false;
		const held: (() => void)[] = [];
		await tv.route(
			(u) => u.pathname.startsWith('/media/'),
			(route) => {
				if (hold) held.push(() => void route.continue().catch(() => {}));
				else void route.continue().catch(() => {});
			}
		);
		await recordCards(tv);
		await tapStage(tv);
		const card = tv.locator(SEL.stateNext);
		await queueReady(maya, TRACKS.caroline.q);
		await expect(card).toContainText('Maya', { timeout: 30_000 });
		await expect(card).toBeHidden({ timeout: 15_000 });

		hold = true;
		await queueReady(theo, TRACKS.believin.q);
		await expect(tv.locator('.upnext')).toContainText('Theo', { timeout: 10_000 });
		// The TV's `ended` reaches the server 3.5 s late, so its confirm lands after the 2.5 s hold.
		await delayEnded(tv, 3_500);
		const t0 = Date.now();
		await sendPlayerCommand(maya, { cmd: 'seek', positionSec: 7.2 });
		await expect(card).toContainText('Theo', { timeout: 10_000 });
		// The card goes up at the end. The audio lands 3.8 s later, just after the late confirm (3.5 s), so the card
		// should go with it, well before a second 2.5 s hold started at the confirm would end (6.0 s).
		const tEnd = (await cardsSince(tv, t0)).find((r) => r.text)!.at;
		await expect.poll(() => Date.now() - tEnd, { timeout: 15_000 }).toBeGreaterThan(3_800);
		hold = false;
		for (const go of held.splice(0)) go();
		await expect(card).toBeHidden({ timeout: 15_000 });
		await expect(tv.locator(SEL.lyricsRow).first()).toBeVisible({ timeout: 10_000 });

		const renders = await cardsSince(tv, t0);
		const timeline = JSON.stringify(renders.map((r) => ({ ...r, at: r.at - t0 })));
		const firstCard = renders.findIndex((r) => r.text);
		const lastCard = renders.findLastIndex((r) => r.text);
		const appearances = renders.filter((r, i) => r.text && !renders[i - 1]?.text).length;
		expect(appearances, `the card went up more than once: ${timeline}`).toBe(1);
		expect(
			renders.slice(firstCard, lastCard + 1).some((r) => r.lyrics),
			`lyrics showed in the middle of the handoff: ${timeline}`
		).toBe(false);
		const wrong = renders.filter((r) => r.text && (r.text.includes('Maya') || !r.text.includes('Theo')));
		expect(wrong, `the card named someone other than Theo: ${timeline}`).toEqual([]);
		// "Up next" until the server confirms (3.5 s), "Now singing" after: through the hold AND the loading card after it.
		expect(renders[firstCard]!.text, `the card did not open on "Up next": ${timeline}`).toMatch(/^up next/i);
		const nowSinging = renders.find((r) => /^now singing/i.test(r.text));
		expect(nowSinging, `the card never said "Now singing": ${timeline}`).toBeTruthy();
		expect(nowSinging!.at - tEnd, `"Now singing" before the server confirmed: ${timeline}`).toBeGreaterThan(3_000);
		const down = renders[lastCard + 1]?.at ?? Infinity;
		expect(down - tEnd, `the card outlived its audio by a second hold: ${timeline}`).toBeLessThan(5_300);
	} finally {
		await worker.stop();
	}
});

test('reloading the TV mid-song does not put the "Now singing" card back over the song', async ({ world }) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		await processTrack(maya, world.baseURL, TRACKS.caroline);
		const tv = await world.openTv();
		await recordCards(tv);
		await tapStage(tv);
		const card = tv.locator(SEL.stateNext);

		await queueReady(maya, TRACKS.caroline.q);
		// The evening's first song still opens on its card: the recorder sees it, so its silence below means something.
		await expect(card).toContainText('Maya', { timeout: 30_000 });
		await expect(card).toBeHidden({ timeout: 15_000 });
		// About 2 s into an 8 s track: still playing well past the card's 2.5 s hold after the reload.
		await tv.waitForTimeout(2_000);
		await tv.reload();
		await tapStage(tv);
		// Playing again means the slot reported ready, which is where the replayed card went up; the card would be
		// up by now, and the recorder keeps it even if it has gone again.
		const audio = () =>
			tv
				.locator('.slot.visible audio')
				.first()
				.evaluate((el) => ({ t: (el as HTMLAudioElement).currentTime, paused: (el as HTMLAudioElement).paused }))
				.catch(() => null);
		await expect.poll(async () => (await audio())?.paused, { timeout: 30_000 }).toBe(false);
		expect((await audio())!.t, 'the song restarted instead of resuming').toBeGreaterThan(1.5);
		await tv.waitForTimeout(500);
		const shown = (await cardsSince(tv, 0)).map((c) => c.text).filter(Boolean);
		expect(shown, 'a card showed after the reload').toEqual([]);
	} finally {
		await worker.stop();
	}
});

test('a TV opened onto a song that is already up never puts the card over its lyrics', async ({ world, browser }) => {
	// From the #989 flake investigation: lyrics, then the "Now singing" card over them, then the lyrics again.
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		await processTrack(maya, world.baseURL, TRACKS.caroline);
		await queueReady(maya, TRACKS.caroline.q);
		await expect.poll(async () => (await serverPlayback(world.baseURL)).state.currentEntryId).not.toBeNull();

		// No TV until now, so the room's playhead is still 0. The recorder must be in before the page's first script.
		const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: world.baseURL });
		const tv = await ctx.newPage();
		await installRecorder(tv);
		await tv.goto(`/tv?room=${encodeURIComponent(world.code)}`);
		await tapStage(tv);
		await expect(tv.locator(SEL.lyricsRow).first()).toBeVisible({ timeout: 30_000 });
		await tv.waitForTimeout(3_000);

		const renders = await cardsSince(tv, 0);
		const timeline = JSON.stringify(renders);
		expect(overLyrics(renders), `the card was up with the lyrics: ${timeline}`).toEqual([]);
		// Once the lyrics are up they stay up: nothing takes the stage back from a song already showing.
		const firstLyrics = renders.findIndex((r) => r.lyrics);
		expect(firstLyrics, `the lyrics never showed: ${timeline}`).toBeGreaterThanOrEqual(0);
		expect(
			renders.slice(firstLyrics).every((r) => r.lyrics),
			`the lyrics went away again: ${timeline}`
		).toBe(true);
		await ctx.close();
	} finally {
		await worker.stop();
	}
});
