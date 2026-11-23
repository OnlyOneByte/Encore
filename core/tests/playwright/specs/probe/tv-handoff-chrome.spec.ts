// The "Now singing" card is the whole stage (proposal 23): the rules are in docs/FRONTEND.md#the-full-screen-takeovers.
// Every rAF frame is read in the page, because a sampler from the test side lands a round trip late.
import { writeFileSync } from 'node:fs';
import { test, expect } from '../../world/fixtures';
import { readySong, queueReady } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import { tapStage } from './audio-probe-support';
import type { Page } from '@playwright/test';

interface Frame {
	at: number;
	/** The stage is on screen (its lower third is mounted), so its join QR must be. */
	stage: boolean;
	/** The layer has `shown` and its fade-in has finished. */
	up: boolean;
	shown: boolean;
	/** A takeover's dimmed join copy is mounted. */
	takeoverJoin: boolean;
	cardName: string;
	layerOpacity: number;
	/** The card's name, composited up the tree (the layer's fade included); 0 with no card mounted. */
	cardNameOpacity: number;
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
			const cardNameEl = document.querySelector('.state-next .up-name');
			const f: Frame = {
				at: Date.now(),
				stage: !!lt,
				up: shown && !!layer && getComputedStyle(layer).opacity === '1',
				shown,
				takeoverJoin: !!document.querySelector('.takeover-join'),
				cardName: shown ? words(document.querySelector('.state-next .up-name')) : '',
				layerOpacity: layer ? Number(getComputedStyle(layer).opacity) : 0,
				cardNameOpacity: cardNameEl ? composited(cardNameEl) : 0,
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

			// A TV reloaded 600 ms into the first card: the recorder starts again with the page, so each page's frames
			// are a segment of their own and an exit is never read across the reload.
			const segments: Frame[][] = [];
			await expect.poll(async () => (await frames(tv)).some((f) => f.up && f.cardName), { timeout: 60_000 }).toBe(true);
			await tv.waitForTimeout(600);
			segments.push(await frames(tv));
			await tv.reload();
			await tapStage(tv);
			const cardsSeen = async () =>
				new Set(
					[...segments, await frames(tv)]
						.flat()
						.filter((f) => f.up && f.cardName)
						.map((f) => f.cardName)
				).size;
			// Every singer's card has come and gone.
			await expect.poll(cardsSeen, { timeout: 120_000 }).toBe(3);
			await expect.poll(async () => (await frames(tv)).at(-1)?.shown, { timeout: 30_000 }).toBe(false);
			segments.push(await frames(tv));
			const all = segments.flat();
			writeFileSync(test.info().outputPath('frames.json'), JSON.stringify(segments, null, 1));

			const held = all.filter((f) => f.up && f.cardName);
			for (const f of held) {
				const at = `card "${f.cardName}" at ${f.at}`;
				expect(f.ltVisible, `${at}: the lower third repeats the card`).toBe(false);
				expect(f.progressVisible, `${at}: the progress line runs under the card`).toBe(0);
				expect(f.upnext[1], `${at}: "Up next" stays`).toBe(f.upnext[0]);
			}
			expect(
				held.some((f) => f.upnext[0] > 0),
				'no card was up with an "Up next" behind it'
			).toBe(true);
			// ONE QR on every stage frame, the exit fade and the reload included: never two stacked, never none, and
			// dimmed whenever a takeover's copy is the one up.
			const badCount = all.filter((f) => f.stage && f.corners.length !== 1).map((f) => [f.at, f.corners.length]);
			expect(badCount, 'stage frames without exactly one join QR [at, count]').toEqual([]);
			const undimmed = all.filter((f) => f.takeoverJoin && f.corners.some((o) => o > 0.72)).map((f) => f.at);
			expect(undimmed, 'frames with a takeover up and the join QR not dimmed').toEqual([]);

			// The layer's exit: the first frame each card's layer drops `shown`, within one page.
			const exits = segments.flatMap((seg) =>
				seg.flatMap((f, i) =>
					i > 0 && !f.shown && seg[i - 1]!.shown && seg[i - 1]!.cardName ? [[seg[i - 1]!, f]] : []
				)
			);
			// Theo's and Ana's: the reload ends Maya's page mid-card, and the reloaded TV does not put her card back (IN-P1).
			expect(exits.length, 'card exits seen').toBeGreaterThanOrEqual(2);
			// ONE copy of the name: no frame paints the card's name and the lower third together, the exit fade included.
			const twice = all.filter((f) => f.ltVisible && f.cardNameOpacity > 0.1).map((f) => [f.at, f.cardNameOpacity]);
			expect(twice, 'frames with the card name and the lower third both painted [at, name opacity]').toEqual([]);
			for (const [prev, f] of exits) {
				const at = `exit of "${prev!.cardName}" at ${f!.at}`;
				// The lower third CUTS back in once the layer's fade has ended (its first painted frame after the exit), at
				// full and with no transition, in both modes.
				const back = all.find((g) => g.at >= f!.at && g.ltVisible);
				expect(
					[back?.layerOpacity, back?.ltOpacity, back?.ltTransition],
					`${at}: the lower third cuts back in after the card's fade`
				).toEqual([0, 1, '0s']);
				// The edge line, on the exit's own frame: the style recalc that drops `under-card` starts its fade, so
				// under no-preference it is painted from below full; under reduce it is back at full. Read here, not
				// mid-fade: under load rAF frames land further apart than the fade.
				if (motion === 'reduce') expect(f!.edgeOpacity, `${at}: the edge line cuts back under reduce`).toBe(1);
				else expect(f!.edgeOpacity, `${at}: the edge line fades in`).toBeLessThan(1);
				// Within two seconds (a loaded host paints far apart) the stage names the singer the card named.
				const settled = all.filter((g) => g.at >= f!.at && g.at <= f!.at + 2_000 && g.ltName).at(-1);
				expect(settled?.ltName ?? '', `${at}: the lower third names the new singer`).toContain(prev!.cardName);
			}
		} finally {
			await worker.stop();
		}
	});
}
