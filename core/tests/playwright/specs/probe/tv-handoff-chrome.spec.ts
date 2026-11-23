// THE "NOW SINGING" CARD IS THE WHOLE STAGE (proposal 23).
//
// The card's scrim is transparent past 62% of its radius, so the stage's chrome showed through it: the lower third
// named the singer a second time, the progress line ran along the edge, and the corner join QR was drawn twice in one
// box at full brightness. On every handoff with the layer fully up: the lower third and the progress line are hidden,
// exactly ONE join QR is visible, dimmed, and "Up next" stays. When the layer's exit starts, the lower third is back,
// naming the new singer, fading in with the layer under no-preference and cutting back under reduce.
//
// Every frame is read in the page (rAF), because the exit's first frame is the one that says whether the stage
// waited for the card, and a sampler from the test side lands a round trip late.
import { writeFileSync } from 'node:fs';
import { test, expect } from '../../world/fixtures';
import { readySong, queueReady } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import { tapStage } from './audio-probe-support';
import type { Page } from '@playwright/test';

interface Frame {
	at: number;
	/** The layer has `shown` and its fade-in has finished. */
	up: boolean;
	shown: boolean;
	cardName: string;
	ltVisible: boolean;
	ltName: string;
	ltOpacity: number;
	ltTransition: string;
	/** Progress elements (any style) that are painted. */
	progressVisible: number;
	/** The room's default `edge` progress line, composited. */
	edgeOpacity: number;
	/** Painted `.corner` join cards, with their opacity composited up the tree. */
	corners: number[];
	/** `.upnext` blocks: [present, painted]. */
	upnext: [number, number];
}

async function installRecorder(tv: Page): Promise<void> {
	await tv.addInitScript(() => {
		const w = window as unknown as { probeFrames: Frame[] };
		w.probeFrames = [];
		const painted = (el: Element) => getComputedStyle(el).visibility !== 'hidden';
		const composited = (el: Element | null) => {
			let o = 1;
			for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
			return Math.round(o * 100) / 100;
		};
		const words = (el: Element | null) => (el as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? '';
		let last = '';
		const tick = () => {
			const layer = document.querySelector('.takeover-layer');
			const lt = document.querySelector('.lower-third');
			const shown = !!layer?.classList.contains('shown');
			const progress = [...document.querySelectorAll('.edgebar, .topbar, .pill, .lower-third .card-row')];
			const upnext = [...document.querySelectorAll('.upnext')];
			const f: Frame = {
				at: Date.now(),
				up: shown && !!layer && getComputedStyle(layer).opacity === '1',
				shown,
				cardName: shown ? words(document.querySelector('.state-next .up-name')) : '',
				ltVisible: !!lt && painted(lt),
				ltName: words(lt?.querySelector('.ls-name') ?? null),
				ltOpacity: lt ? composited(lt) : 0,
				ltTransition: lt ? getComputedStyle(lt).transitionDuration : '',
				progressVisible: progress.filter(painted).length,
				edgeOpacity: composited(document.querySelector('.edgebar')),
				corners: [...document.querySelectorAll('.corner')].filter(painted).map(composited),
				upnext: [upnext.length, upnext.filter(painted).length]
			};
			const key = JSON.stringify({ ...f, at: 0 });
			if (key !== last) w.probeFrames.push(f);
			last = key;
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
}

const frames = (tv: Page) => tv.evaluate(() => (window as unknown as { probeFrames: Frame[] }).probeFrames);

for (const motion of ['no-preference', 'reduce'] as const) {
	test(`the handoff card is the only thing on the stage (${motion})`, async ({ world }) => {
		test.setTimeout(240_000);
		// The default 8 s tracks: a 2 s one ends under its own card, so the layer never leaves between singers.
		const worker = await startFakeWorker(world);
		try {
			const tv = await world.openTv();
			await tv.emulateMedia({ reducedMotion: motion });
			await installRecorder(tv);
			await tv.reload();
			const maya = await world.openPhone('Maya');
			const theo = await world.openPhone('Theo');
			const ana = await world.openPhone('Ana');
			await readySong(world, maya, 'caroline');
			await readySong(world, theo, 'believin');
			await readySong(world, ana, 'bohemian');
			await queueReady(maya, 'caroline');
			await tapStage(tv);
			await queueReady(theo, 'believin');
			await queueReady(ana, 'bohemian');

			// Every singer's card has come and gone.
			await expect
				.poll(async () => new Set((await frames(tv)).filter((f) => f.up && f.cardName).map((f) => f.cardName)).size, {
					timeout: 120_000
				})
				.toBe(3);
			await expect.poll(async () => (await frames(tv)).at(-1)?.shown, { timeout: 30_000 }).toBe(false);
			const all = await frames(tv);
			writeFileSync(test.info().outputPath('frames.json'), JSON.stringify(all, null, 1));

			const held = all.filter((f) => f.up && f.cardName);
			for (const f of held) {
				const at = `card "${f.cardName}" at ${f.at}`;
				expect(f.ltVisible, `${at}: the lower third repeats the card`).toBe(false);
				expect(f.progressVisible, `${at}: the progress line runs under the card`).toBe(0);
				expect(f.corners.length, `${at}: join QRs painted`).toBe(1);
				expect(f.corners[0]!, `${at}: the join QR is dimmed`).toBeLessThanOrEqual(0.72);
				expect(f.upnext[1], `${at}: "Up next" stays`).toBe(f.upnext[0]);
			}
			expect(held.some((f) => f.upnext[0] > 0), 'no card was up with an "Up next" behind it').toBe(true);

			// The layer's exit: the first frame each card's layer drops `shown`.
			const exits = all.filter((f, i) => i > 0 && !f.shown && all[i - 1]!.shown && all[i - 1]!.cardName);
			expect(exits.length, 'card exits seen').toBeGreaterThanOrEqual(3);
			for (const f of exits) {
				const prev = all[all.indexOf(f) - 1]!;
				const at = `exit of "${prev.cardName}" at ${f.at}`;
				expect(f.ltVisible, `${at}: the lower third is back as the card leaves`).toBe(true);
				// Mid-fade frames: under no-preference the lower third and the edge line pass through partial opacity
				// as the layer leaves; under reduce they cut straight back to full.
				const fade = all.filter((g) => g.at >= f.at && g.at <= f.at + 600);
				const lowerFading = fade.some((g) => g.ltVisible && g.ltOpacity > 0 && g.ltOpacity < 1);
				const edgeFading = fade.some((g) => g.edgeOpacity > 0 && g.edgeOpacity < 1);
				if (motion === 'reduce') {
					expect(f.ltTransition, `${at}: reduced motion cuts back`).toBe('0s');
					expect([lowerFading, edgeFading], `${at}: [lower third, edge line] fading under reduce`).toEqual([
						false,
						false
					]);
				} else {
					expect(f.ltTransition, `${at}: the lower third fades in with the layer`).not.toBe('0s');
					expect([lowerFading, edgeFading], `${at}: [lower third, edge line] seen mid-fade`).toEqual([true, true]);
				}
				// Within a second the stage names the singer the card named, at full strength.
				const settled = all.filter((g) => g.at >= f.at && g.at <= f.at + 1_000 && g.ltName).at(-1);
				expect(settled?.ltName ?? '', `${at}: the lower third names the new singer`).toContain(prev.cardName);
				expect(settled?.ltOpacity ?? 0, `${at}: the lower third is back at full strength`).toBe(1);
			}
		} finally {
			await worker.stop();
		}
	});
}
