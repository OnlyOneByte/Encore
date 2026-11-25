// THE HANDOFF CARD SETTLES IN AND OUT (proposal 15). The TV's "Now singing" card used to be its own `{#if}` branch, so
// it cut in over the old song and cut out over the new one in a single frame. It now lives in one mounted
// `.takeover-layer` that fades in (the lines rising into place) and fades out; the song's lyrics come in after it.
//
// Every animation frame on the TV is logged (the layer's opacity and `shown` class, the card's name and the name
// line's opacity, the reel's opacity, and how deep the card's text and the lyrics' text intersect), so the probe
// reads the motion itself rather than a screenshot of it. The songs have real-length lyric lines (`longLyricLines`):
// one word a line can never meet the card, so "no text on text" would mean nothing without them.
//   0. in every test, no frame draws the card's words over the lyrics' words;
//   1. at a skip and at a natural end, no frame takes the card from nothing to (almost) full, and the exit has frames
//      in between, with the reel held back; it then fades in; the hold is as long as it was;
//   2. a change of singer while the card is coming up never dips the layer: only the new lines rise in;
//   3. under `prefers-reduced-motion: reduce` it is a cut both ways, with nothing moving;
//   4. a missed-preload card, which leaves from inside the player's update rather than on the hold's timer, still fades
//      out with its words;
//   5. "Up next" turning "Now singing" is a change of words: the lines rise again and the layer stays up.
// On main the first and third fail at the first frame (there is no layer, so the card is 0 or 1).
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, queueReady, readySong, returnHomeFromBrowse } from '../../world/actors';
import {
	armMediaLog,
	processTrack,
	queueReadyTrack,
	readMediaLog,
	sendPlayerCommand,
	tapStage,
	TRACKS
} from './audio-probe-support';
import type { Page } from '@playwright/test';
import type { World } from '../../world/fixtures';
import { DEFAULT_ROOM_SETTINGS } from '$lib/contract';
import { putRoom } from '../../world/reactions';

/** The room's intro hold, as the TV runs it in these tests (the default). */
const SONG_INTRO_MS = DEFAULT_ROOM_SETTINGS.songIntroMs;

interface Frame {
	t: number;
	/** The layer's computed opacity; 1 or 0 for a card with no layer (main). */
	layer: number;
	shown: boolean;
	name: string | null;
	/** The card's eyebrow: "Up next" in the beat before the server confirms the swap, then "Now singing". */
	label: string | null;
	nameOpacity: number | null;
	nameTransform: string | null;
	/** When the name line's rise started (its CSS animation's `startTime`), null with none running. */
	riseStart: number | null;
	lyrics: boolean;
	/** The reel's computed opacity, null with no reel. */
	lyricsOpacity: number | null;
	/** Which `.lyrics` element is on the page (a counter per new element), null with none: a change is a remount. */
	reelNode: number | null;
	/** The reel's arrival animation (`lyrics-arrive`): its `startTime` on the page's clock and its duration, ms. */
	reelArriveStart: number | null;
	reelArriveMs: number | null;
	/** The deepest intersection, in px, of a card line's text with any lyric row's text, both visible (effective
	 *  opacity over 0.05); 0 when none meet. Text boxes come from a Range over each row, so a full-width row's empty
	 *  margins do not count, and every row is measured, not only the sung one. */
	textOverlapPx: number;
	/** The layer's `aria-hidden` and computed `pointer-events`: a card on its way out is neither read nor tapped. */
	ariaHidden: string | null;
	pointerEvents: string | null;
}

/** A `.lyrics` reel appearing, and whether it did so in the task of the layer's fade-out `transitionend`. */
interface ReelMount {
	t: number;
	onFadeOut: boolean;
}

/** One of the layer's opacity transitions: when it really started on the page's clock, and its own delay + duration. */
interface LayerFade {
	start: number;
	endTime: number;
	/** The opacity it runs to. */
	to: number;
	shown: boolean;
}

/** One row per animation frame, from before the page's first script. Also stamps the HOLD'S END: every firing of a
 *  `setTimeout` whose delay is the room's intro hold, which is the page's own `interstitialTimer`; and every EXIT: the
 *  layer's opacity read the moment it drops `shown`, on the transition's own clock rather than a sampled frame. */
async function logFrames(tv: Page, holdMs = SONG_INTRO_MS): Promise<void> {
	await tv.addInitScript((hold) => {
		const w = window as unknown as {
			handoffFrames: unknown[];
			holdEnds: number[];
			exits: { t: number; opacity: number }[];
			fadeOuts: number[];
			reelMounts: ReelMount[];
			shows: number[];
			layerFades: LayerFade[];
		};
		w.handoffFrames = [];
		w.holdEnds = [];
		w.exits = [];
		w.fadeOuts = [];
		w.reelMounts = [];
		w.shows = [];
		w.layerFades = [];
		// The layer's fade-out ending, and whether the reel mounted inside that same event's task: captured on the
		// document, so this runs before the page's own handler, and cleared by the next task.
		let inFadeOut = false;
		document.addEventListener(
			'transitionend',
			(e) => {
				const el = e.target as HTMLElement;
				if (!el.classList?.contains('takeover-layer') || el.classList.contains('shown')) return;
				w.fadeOuts.push(performance.now());
				inFadeOut = true;
				const ch = new MessageChannel();
				ch.port1.onmessage = () => (inFadeOut = false);
				ch.port2.postMessage(0);
			},
			true
		);
		let reelUp = false;
		new MutationObserver(() => {
			const up = !!document.querySelector('.lyrics');
			if (up && !reelUp) w.reelMounts.push({ t: performance.now(), onFadeOut: inFadeOut });
			reelUp = up;
		}).observe(document, { subtree: true, childList: true });
		new MutationObserver((records) => {
			for (const r of records) {
				const el = r.target as HTMLElement;
				if (!el.classList.contains('takeover-layer')) continue;
				const was = /\bshown\b/.test(r.oldValue ?? '');
				if (!was && el.classList.contains('shown')) w.shows.push(performance.now());
				if (was && !el.classList.contains('shown'))
					w.exits.push({ t: performance.now(), opacity: Number(getComputedStyle(el).opacity) });
			}
		}).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
		const set = window.setTimeout;
		window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
			ms === hold && typeof fn === 'function'
				? set(() => {
						w.holdEnds.push(performance.now());
						(fn as (...a: unknown[]) => void)(...rest);
					}, ms)
				: set(fn, ms, ...rest)) as typeof window.setTimeout;
		/** The product of `opacity` up the ancestor chain. */
		const shownOpacity = (el: Element | null) => {
			let o = 1;
			for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
			return o;
		};
		const textRects = (el: Element) => {
			const r = document.createRange();
			r.selectNodeContents(el);
			return [...r.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
		};
		const depth = (a: DOMRect, b: DOMRect) =>
			Math.min(a.right - b.left, b.right - a.left, a.bottom - b.top, b.bottom - a.top);
		const textOverlap = () => {
			const lines = [...document.querySelectorAll('.state-next > *')].filter((e) => shownOpacity(e) > 0.05);
			const rows = [...document.querySelectorAll('.lyrics .row')].filter((e) => shownOpacity(e) > 0.05);
			let worst = 0;
			for (const a of lines.flatMap(textRects))
				for (const b of rows.flatMap(textRects)) worst = Math.max(worst, depth(a, b));
			return worst;
		};
		let reels = 0;
		const tick = () => {
			const layer = document.querySelector<HTMLElement>('.takeover-layer');
			const card = document.querySelector<HTMLElement>('.state-next');
			const nameEl = card?.querySelector<HTMLElement>('.up-name') ?? null;
			const ns = nameEl ? getComputedStyle(nameEl) : null;
			const reel = document.querySelector<HTMLElement>('.lyrics');
			for (const a of layer?.getAnimations() ?? [])
				if (a instanceof CSSTransition && a.transitionProperty === 'opacity' && a.startTime !== null)
					if (!w.layerFades.some((f) => f.start === a.startTime))
						w.layerFades.push({
							start: a.startTime as number,
							endTime: Number(a.effect?.getComputedTiming().endTime),
							to: Number((a.effect as KeyframeEffect).getKeyframes().at(-1)?.opacity),
							shown: layer!.classList.contains('shown')
						});
			w.handoffFrames.push({
				t: performance.now(),
				layer: layer ? Number(getComputedStyle(layer).opacity) : card ? 1 : 0,
				shown: layer ? layer.classList.contains('shown') : !!card,
				name: nameEl?.textContent?.trim() ?? null,
				label: card?.querySelector('.up-label')?.textContent?.trim() ?? null,
				nameOpacity: ns ? Number(ns.opacity) : null,
				nameTransform: ns?.transform ?? null,
				riseStart: (nameEl?.getAnimations()[0]?.startTime as number | null | undefined) ?? null,
				lyrics: !!document.querySelector('.lyrics .row'),
				lyricsOpacity: reel ? Number(getComputedStyle(reel).opacity) : null,
				reelNode: reel ? Number((reel.dataset.probeNode ??= String(++reels))) : null,
				...(() => {
					const a = reel
						?.getAnimations()
						.find((x) => x instanceof CSSAnimation && x.animationName.endsWith('lyrics-arrive'));
					return {
						reelArriveStart: (a?.startTime as number | null | undefined) ?? null,
						reelArriveMs: a ? Number(a.effect?.getTiming().duration) : null
					};
				})(),
				textOverlapPx: textOverlap(),
				ariaHidden: layer?.getAttribute('aria-hidden') ?? null,
				pointerEvents: layer ? getComputedStyle(layer).pointerEvents : null
			});
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}, holdMs);
}

/** When the intro holds ended since `since` (performance.now() ms). */
const holdEnds = (tv: Page, since: number) =>
	tv.evaluate((s) => (window as unknown as { holdEnds: number[] }).holdEnds.filter((t) => t >= s), since);

/** The layer's exits since `since`: when it dropped `shown`, and its opacity at that moment. */
const exits = (tv: Page, since: number) =>
	tv.evaluate(
		(s) => (window as unknown as { exits: { t: number; opacity: number }[] }).exits.filter((e) => e.t >= s),
		since
	);

/** When the layer's fade-out ended (its `transitionend`), and when a reel mounted, since `since`. */
const fadeOuts = (tv: Page, since: number) =>
	tv.evaluate((s) => (window as unknown as { fadeOuts: number[] }).fadeOuts.filter((t) => t >= s), since);
const reelMounts = (tv: Page, since: number) =>
	tv.evaluate((s) => (window as unknown as { reelMounts: ReelMount[] }).reelMounts.filter((m) => m.t >= s), since);

/** When the layer took `shown`, and its opacity transitions as they really ran, since `since`. */
const shows = (tv: Page, since: number) =>
	tv.evaluate((s) => (window as unknown as { shows: number[] }).shows.filter((t) => t >= s), since);
const layerFades = (tv: Page, since: number) =>
	tv.evaluate((s) => (window as unknown as { layerFades: LayerFade[] }).layerFades.filter((f) => f.start >= s), since);

/** The frame log since `since`. Every read also checks rule 0: no frame draws card text over lyric text. */
async function frames(tv: Page, since = 0): Promise<Frame[]> {
	const log = await tv.evaluate(
		(s) => (window as unknown as { handoffFrames: Frame[] }).handoffFrames.filter((f) => f.t >= s),
		since
	);
	const hits = log
		.filter((f) => f.textOverlapPx > 0)
		.map((f) => `${Math.round(f.t)}:${f.name}:${f.textOverlapPx.toFixed(1)}px`);
	expect(hits, 'the card’s words were drawn over the lyrics’ words').toEqual([]);
	return log;
}

/** The reel is back and has finished arriving. */
async function reelSettled(tv: Page): Promise<void> {
	await expect(tv.locator(SEL.lyricsRow).first()).toBeAttached({ timeout: 10_000 });
	await expect
		.poll(() => tv.evaluate(() => Number(getComputedStyle(document.querySelector('.lyrics')!).opacity)))
		.toBe(1);
}

/** After a card's exit: the reel comes in only once the card is gone, and fades in (motion) rather than cutting. */
function expectReelArrives(after: Frame[], label: string, reduced = false): void {
	const first = after.findIndex((f) => f.lyrics);
	expect(first, `${label}: the lyrics never came back`).toBeGreaterThanOrEqual(0);
	// The card may still be mounted for the hold's last moment, but faded out: never visible beside the reel.
	expect(after[first]!.layer, `${label}: the lyrics came in with the card still showing`).toBeLessThanOrEqual(0.05);
	const ramp = after.slice(first).filter((f) => f.lyricsOpacity !== null && f.lyricsOpacity < 0.95);
	if (reduced) expect(ramp, `${label}: the reel faded in under reduce`).toEqual([]);
	else expect(ramp.length, `${label}: the reel cut in`).toBeGreaterThan(0);
}

const now = (tv: Page) => tv.evaluate(() => performance.now());

/** The two phases of one card in a frame log: from its first `shown` frame to its first frame after. */
function phases(log: Frame[]) {
	const on = log.findIndex((f) => f.shown);
	const off = on < 0 ? -1 : log.findIndex((f, i) => i > on && !f.shown);
	const settled = off < 0 ? -1 : log.findIndex((f, i) => i > off && f.layer === 0);
	return {
		enter: on < 0 ? [] : log.slice(Math.max(0, on - 1), off < 0 ? undefined : off),
		exit: off < 0 ? [] : log.slice(off, settled < 0 ? undefined : settled + 1),
		after: off < 0 ? [] : log.slice(off),
		holdMs: on < 0 || off < 0 ? null : log[off]!.t - log[on]!.t
	};
}

/** The largest one-frame climb of the layer's opacity: a cut is ~1, a 0.4 s fade at any real frame rate far less. */
const biggestStep = (fs: Frame[]) => Math.max(0, ...fs.slice(1).map((f, i) => f.layer - fs[i]!.layer));
const between = (f: Frame) => f.layer > 0.05 && f.layer < 0.95;

async function room(world: World, reduced: boolean, songIntroMs?: number) {
	const maya = await world.openPhone('Maya');
	const theo = await world.openPhone('Theo');
	const ana = await world.openPhone('Ana');
	for (const q of ['caroline', 'believin', 'prayer']) await readySong(world, maya, q);
	if (songIntroMs !== undefined) await putRoom(maya, { songIntroMs });
	const tv = await world.openTv();
	if (reduced) await tv.emulateMedia({ reducedMotion: 'reduce' });
	await logFrames(tv, songIntroMs);
	await tv.reload();
	await tapStage(tv);
	await queueReady(maya, 'caroline');
	// The evening's first song opens on its own card; wait until it has given way to the song.
	await expect(tv.locator(SEL.stateNext)).toContainText('Maya', { timeout: 30_000 });
	await expect(tv.locator(SEL.stateNext)).toHaveCount(0, { timeout: 15_000 });
	return { maya, theo, ana, tv };
}

test('the handoff card fades in and out at a skip and at a natural end, then the lyrics come in, with the hold unchanged', async ({
	world
}) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { longLyricLines: true });
	try {
		const { maya, theo, tv } = await room(world, false);
		await queueReady(theo, 'believin');
		await expect(tv.locator('.upnext')).toContainText('Theo', { timeout: 10_000 });

		// 1. A SKIP: Maya taps skip on her own strip.
		let t0 = await now(tv);
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(tv.locator(SEL.stateNext)).toContainText('Theo', { timeout: 5_000 });
		await expect(tv.locator(SEL.stateNext)).toHaveCount(0, { timeout: 10_000 });
		await reelSettled(tv);
		const skip = phases(await frames(tv, t0));
		const skipHoldEnd = (await holdEnds(tv, t0))[0];
		const skipExit = (await exits(tv, t0))[0];
		const skipFade = {
			out: (await fadeOuts(tv, t0))[0],
			reel: (await reelMounts(tv, t0))[0],
			ran: (await layerFades(tv, t0)).find((f) => !f.shown)
		};

		// 2. A NATURAL END: Maya queues again, and Theo's 8 s song is sought near its end and ends by itself.
		await queueReady(maya, 'caroline');
		await expect(tv.locator('.upnext')).toContainText('Maya', { timeout: 10_000 });
		t0 = await now(tv);
		await sendPlayerCommand(theo, { cmd: 'seek', positionSec: 6.8 });
		await expect(tv.locator(SEL.stateNext)).toContainText('Maya', { timeout: 10_000 });
		await expect(tv.locator(SEL.stateNext)).toHaveCount(0, { timeout: 10_000 });
		await reelSettled(tv);
		const natural = phases(await frames(tv, t0));
		const naturalHoldEnd = (await holdEnds(tv, t0))[0];
		const naturalExit = (await exits(tv, t0))[0];
		const naturalFade = {
			out: (await fadeOuts(tv, t0))[0],
			reel: (await reelMounts(tv, t0))[0],
			ran: (await layerFades(tv, t0)).find((f) => !f.shown)
		};

		for (const [label, p] of Object.entries({ skip, natural })) {
			expect(p.enter.length, `${label}: the card never came up`).toBeGreaterThan(1);
			expect(biggestStep(p.enter), `${label}: the card CUT in (one frame from nothing to full)`).toBeLessThan(0.9);
			expect(p.enter.some(between), `${label}: no frame of the enter is part-way`).toBe(true);
			// The lines rise: some frame of the enter has the name below its rest.
			expect(
				p.enter.some((f) => f.nameTransform !== null && f.nameTransform !== 'none'),
				`${label}: the name never moved`
			).toBe(true);
			const fading = p.exit.filter(between);
			expect(fading.length, `${label}: the card CUT out (no frame part-way)`).toBeGreaterThan(0);
			// The reel waits for the card: a real lyric line is as wide as the card's, so the two never share a frame.
			expect(fading.filter((f) => f.lyrics).length, `${label}: lyrics under the fading card`).toBe(0);
			expectReelArrives(p.after, label);
			// It arrives ONCE: from its first frame the same reel stays, or its fade replays (it unmounted at the hold's
			// end for one flush in round 5's first build).
			const nodes = [...new Set(p.after.map((f) => f.reelNode).filter((n) => n !== null))];
			expect(nodes.length, `${label}: the reel mounted ${nodes.length} times after the card left`).toBe(1);
			// The words do not move on the way out.
			expect(fading.every((f) => f.nameTransform === null || f.nameTransform === 'none')).toBe(true);
			// What fades out is the card the room was reading, not an empty scrim.
			expect(
				fading.map((f) => f.name),
				`${label}: the card's words left before its fade`
			).toEqual(fading.map(() => (label === 'skip' ? 'Theo' : 'Maya')));
			// A card on its way out is out of the accessibility tree and lets taps through; an up card is neither.
			expect(fading.every((f) => f.ariaHidden === 'true' && f.pointerEvents === 'none')).toBe(true);
			expect(p.enter.filter((f) => f.shown).every((f) => f.ariaHidden === 'false')).toBe(true);
			// The hold is still the room's songIntroMs (2.5 s); the exit fade starts one --motion-base (0.25 s) inside it,
			// so the card is up ~2.25 s and has gone when the song starts.
			expect(p.holdMs, `${label}: the card's time up`).toBeGreaterThan(2_000);
			expect(p.holdMs!).toBeLessThan(2_650);
			// Nobody loses their first line: the reel is readable (opacity ≥ 0.5) no later than main's moment, the HOLD'S
			// END (where main's lyrics come up), plus 100 ms. Anchored on the page's own hold timer firing, not the card's
			// first frame plus songIntroMs, which drifts with the frame the card first painted on. "Readable" is read off
			// the reel's own animation clock: `lyrics-arrive` is ease-out, cubic-bezier(0, 0, 0.58, 1), which crosses 0.5
			// at 0.3425 of its duration, so it is readable at `startTime` + 0.3425 × duration. Sampling rAF instead adds
			// the host's frame gaps: at load 80 they were 60-90 ms, and the first sampled frame at 0.5 came 176 ms after
			// the reel mounted, which is the host, not the page. The sampled frame keeps a looser bound below.
			const on = p.enter.find((f) => f.shown)!;
			const end = label === 'skip' ? skipHoldEnd : naturalHoldEnd;
			expect(end, `${label}: the hold never ended`).toBeDefined();
			const arrive = p.after.find((f) => f.reelArriveStart !== null && f.reelArriveMs !== null);
			expect(arrive, `${label}: the reel never ran its arrival`).toBeDefined();
			const readableAt = arrive!.reelArriveStart! + 0.3425 * arrive!.reelArriveMs!;
			const sampled = p.after.find((f) => f.lyrics && (f.lyricsOpacity ?? 0) >= 0.5);
			const gone = p.after.find((f) => f.layer <= 0.005);
			const mounted = p.after.find((f) => f.lyrics);
			const rel = (t: number | undefined) => (t === undefined ? 'never' : Math.round(t - on.t));
			const timeline = `card up 0, exit ${rel(p.after[0]?.t)}, card gone ${rel(gone?.t)}, reel mounted ${rel(mounted?.t)}, hold end ${rel(end)}, readable ${rel(readableAt)}, first sampled at 0.5 ${rel(sampled?.t)}`;
			// Each wait for a rendered frame (fade-out start, its `transitionend`, the reel's arrival) is measured and taken
			// off, leaving the page's own schedule: a median-frame allowance missed one 270 ms frame (#1116).
			const fade = label === 'skip' ? skipFade : naturalFade;
			expect(fade.ran, `${label}: the layer's fade-out never ran (${timeline})`).toBeDefined();
			expect(fade.out, `${label}: the layer's fade-out never ended (${timeline})`).toBeDefined();
			expect(fade.reel, `${label}: no reel mounted after the card (${timeline})`).toBeDefined();
			const exit = label === 'skip' ? skipExit : naturalExit;
			expect(exit, `${label}: the layer never dropped \`shown\``).toBeDefined();
			const lags = [
				fade.ran!.start - exit!.t,
				fade.out! - (fade.ran!.start + fade.ran!.endTime),
				arrive!.reelArriveStart! - fade.reel!.t
			].map((l) => Math.max(0, l));
			const hostMs = lags.reduce((a, b) => a + b, 0);
			const lagNote = `host waits ${lags.map(Math.round).join('+')} ms`;
			expect(
				Math.round(readableAt - hostMs - end!),
				`${label}: the first lyric row was readable this long after the hold's end (${timeline}, ${lagNote})`
			).toBeLessThanOrEqual(100);
			// THE REGRESSION PINS for a late reel. A lead of `--motion-base` alone (250 ms) leaves the reel readable ~86 ms
			// after the hold's end, inside the bound above, so these two hold the design itself.
			// (a) The lead itself: from the layer dropping `shown` to the hold's end, both stamped by the page's own timers,
			// so a busy host delays both alike. The design is `--motion-base` + `--motion-fast` (370 ms); 310 sits halfway
			// to the 250 ms lead that let the reel come in late.
			expect(
				Math.round(end! - exit!.t),
				`${label}: the exit led the hold's end by this much (${timeline})`
			).toBeGreaterThanOrEqual(310);
			// (b) The reel comes up as soon as the card has gone, in the hold's last moment, not only at the hold's end
			// (mutant E3): in the task of the layer's own fade-out `transitionend`. Counting sampled frames between the two
			// measured the host's frame rate instead (#1116). Only when the fade ended before the hold did.
			if (fade.out! < end!)
				expect(
					fade.reel!.onFadeOut,
					`${label}: the reel mounted ${rel(fade.reel!.t)}, not on the card's fade-out ending at ${rel(fade.out)} (${timeline})`
				).toBe(true);
			expect(sampled, `${label}: no sampled frame showed the reel readable (${timeline})`).toBeDefined();
			expect(
				Math.round(sampled!.t - hostMs - end!),
				`${label}: sampled readable far behind (${timeline}, ${lagNote})`
			).toBeLessThanOrEqual(300);
		}
	} finally {
		await worker.stop();
	}
});

// A SHORT intro (the room allows 500 ms) leaves no room to lead the exit: the card must come up readable, then leave at
// the hold's end. With the lead armed regardless, a 500 ms card never showed and a 700 ms one peaked at 0.68 (#1018
// review, round 5). The card must have had its whole fade-in before the layer drops `shown`.
for (const introMs of [500, 700, 1000]) {
	test(`a ${introMs} ms intro: the card comes up full and leaves at the hold's end, not led`, async ({ world }) => {
		test.setTimeout(180_000);
		const worker = await startFakeWorker(world, { longLyricLines: true });
		try {
			const { maya, theo, tv } = await room(world, false, introMs);
			await queueReady(theo, 'believin');
			await expect(tv.locator('.upnext')).toContainText('Theo', { timeout: 10_000 });
			const t0 = await now(tv);
			await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
			await expect(tv.locator(SEL.stateNext)).toContainText('Theo', { timeout: 5_000 });
			await expect(tv.locator(SEL.stateNext)).toHaveCount(0, { timeout: 10_000 });
			await reelSettled(tv);
			const p = phases(await frames(tv, t0));
			const end = (await holdEnds(tv, t0))[0];
			const exit = (await exits(tv, t0))[0];
			const shownAt = (await shows(tv, t0))[0];
			const fadeIn = (await layerFades(tv, t0)).find((f) => f.shown);
			expect(exit, 'the layer never dropped `shown`').toBeDefined();
			expect(shownAt, 'the layer never took `shown`').toBeDefined();
			expect(fadeIn, 'the card never faded in').toBeDefined();
			const note = `opacity ${exit!.opacity.toFixed(3)} at the exit, fade-in started ${Math.round(fadeIn!.start - shownAt!)} ms after \`shown\``;
			// Full on the page's own schedule. The opacity read at the exit measured how late the host's next frame started
			// the fade (16-200 ms after `shown` under load), not the page (#1116).
			expect(fadeIn!.to, `the card faded in to less than full (${note})`).toBeGreaterThanOrEqual(0.95);
			expect(
				exit!.t - shownAt!,
				`the card left before its ${fadeIn!.endTime} ms fade-in could finish (${note})`
			).toBeGreaterThanOrEqual(fadeIn!.endTime);
			// Not led: the card is up for the whole hold and leaves when it ends.
			expect(end, 'the hold never ended').toBeDefined();
			expect(Math.round(end! - p.after[0]!.t), 'the card left this long before its hold ended (a lead)').toBeLessThan(
				100
			);
		} finally {
			await worker.stop();
		}
	});
}

// A skip DURING the led exit starts a new hold, and the next singer's card must come up whole: the lead belongs to the
// hold it was armed for. With `holdSongIntro`'s reset deleted (mutant LM3) Ana's card peaked at 0.17 and 0.56.
test('a skip during the led exit raises the next card to full', async ({ world }) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { longLyricLines: true });
	try {
		const { maya, theo, ana, tv } = await room(world, false);
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		await expect(tv.locator('.upnext')).toContainText('Theo', { timeout: 10_000 });
		const t0 = await now(tv);
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(tv.locator(SEL.takeoverShown)).toHaveCount(1, { timeout: 5_000 });
		// The led exit has begun: the layer has dropped `shown` with Theo's card still mounted.
		await tv.waitForFunction(
			() =>
				!document.querySelector('.takeover-layer')!.classList.contains('shown') &&
				!!document.querySelector('.state-next'),
			undefined,
			{ polling: 'raf', timeout: 10_000 }
		);
		await theo.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(tv.locator(SEL.stateNext)).toContainText('Ana', { timeout: 10_000 });
		await expect(tv.locator(SEL.stateNext)).toHaveCount(0, { timeout: 10_000 });
		const anaFrames = (await frames(tv, t0)).filter((f) => f.name === 'Ana');
		expect(Math.max(0, ...anaFrames.map((f) => f.layer)), 'Ana’s card never came up whole').toBeGreaterThanOrEqual(
			0.95
		);
	} finally {
		await worker.stop();
	}
});

// Reduced motion switched on MID-HOLD, after the lead was armed: there is no fade any more, so a lead would cut the card
// early to an empty stage until the song. The card must stay up and cut at the hold's end, as on main (#1018 review,
// round 5, nit 2).
test('reduced motion switched on mid-hold: the card stays up and cuts at the hold’s end', async ({ world }) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { longLyricLines: true });
	try {
		const { maya, theo, tv } = await room(world, false);
		await queueReady(theo, 'believin');
		await expect(tv.locator('.upnext')).toContainText('Theo', { timeout: 10_000 });
		const t0 = await now(tv);
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(tv.locator(SEL.takeoverShown)).toHaveCount(1, { timeout: 5_000 });
		await tv.waitForTimeout(1_000);
		await tv.emulateMedia({ reducedMotion: 'reduce' });
		await expect(tv.locator(SEL.stateNext)).toHaveCount(0, { timeout: 10_000 });
		await reelSettled(tv);
		const p = phases(await frames(tv, t0));
		const end = (await holdEnds(tv, t0))[0];
		expect(end, 'the hold never ended').toBeDefined();
		expect(
			Math.round(end! - p.after[0]!.t),
			'the card left this long before its hold ended (led under reduce)'
		).toBeLessThan(100);
		expectReelArrives(p.after, 'reduce mid-hold', true);
	} finally {
		await worker.stop();
	}
});

// Reduced motion switched on DURING the led fade, after the lead fired: the fade stops, and with nothing to end it the
// reel would wait for the hold's end over an empty stage. `layerShown` puts the card back up instead, to cut at the
// hold's end. Without that guard the stage was empty for 115-120 ms, 6 frames (#1018 review, round 6).
test('reduced motion switched on during the led fade: the card comes back, the stage is never empty', async ({
	world
}) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { longLyricLines: true });
	try {
		const { maya, theo, tv } = await room(world, false);
		await queueReady(theo, 'believin');
		await expect(tv.locator('.upnext')).toContainText('Theo', { timeout: 10_000 });
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(tv.locator(SEL.takeoverShown)).toHaveCount(1, { timeout: 5_000 });
		// The led exit is part-way: `shown` dropped, Theo's card still mounted, the layer between 0.2 and 0.9.
		await tv.waitForFunction(
			() => {
				const l = document.querySelector('.takeover-layer')!;
				const o = Number(getComputedStyle(l).opacity);
				return !l.classList.contains('shown') && !!document.querySelector('.state-next') && o > 0.2 && o < 0.9;
			},
			undefined,
			{ polling: 'raf', timeout: 10_000 }
		);
		const t1 = await now(tv);
		await tv.emulateMedia({ reducedMotion: 'reduce' });
		await expect(tv.locator(SEL.stateNext)).toHaveCount(0, { timeout: 10_000 });
		await reelSettled(tv);
		const after = await frames(tv, t1);
		const empty = after.filter((f) => f.layer <= 0.05 && (f.lyricsOpacity ?? 0) < 0.05);
		expect(
			empty.map((f) => Math.round(f.t - t1)),
			'frames with neither the card nor the lyrics (ms after reduce switched on)'
		).toEqual([]);
	} finally {
		await worker.stop();
	}
});

test('a change of singer while the card comes up re-rises only the lines; the layer never dips', async ({ world }) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { longLyricLines: true });
	try {
		const { maya, theo, ana, tv } = await room(world, false);
		await queueReady(theo, 'believin');
		await queueReady(ana, 'prayer');
		await expect(tv.locator('.upnext')).toContainText('Theo', { timeout: 10_000 });
		// The skip socket is open before the first skip, so the second lands inside Theo's fade-in.
		await sendPlayerCommand(ana, { cmd: 'play' });
		const t0 = await now(tv);
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(tv.locator(SEL.stateNext)).toContainText('Theo', { timeout: 5_000 });
		// Once Theo's lines have started rising, so the swap lands part-way through it.
		await expect
			.poll(() =>
				tv.evaluate(() => document.querySelector('.state-next .up-name')?.getAnimations()[0]?.startTime ?? null)
			)
			.not.toBeNull();
		await sendPlayerCommand(ana, { cmd: 'skip' });
		await expect(tv.locator(SEL.stateNext)).toContainText('Ana', { timeout: 5_000 });
		await expect(tv.locator(SEL.stateNext)).toHaveCount(0, { timeout: 10_000 });
		const log = await frames(tv, t0);
		const on = log.findIndex((f) => f.shown);
		const swap = log.findIndex((f) => f.name === 'Ana');
		const off = log.findIndex((f, i) => i > swap && !f.shown);
		expect(on, 'Theo’s card never came up').toBeGreaterThanOrEqual(0);
		expect(log.slice(on, swap).some((f) => f.name === 'Theo')).toBe(true);
		// Up from Theo's first frame to the hold's end: the opacity only ever climbs, through the swap.
		const up = log.slice(on, off);
		const dips = up.slice(1).filter((f, i) => f.layer < up[i]!.layer - 0.01);
		expect(dips, 'the layer dipped while the card was up').toEqual([]);
		// Ana's lines rise in on their own: her name starts below full and climbs.
		expect(log[swap]!.nameOpacity!, 'Ana’s name was at full on its first frame').toBeLessThan(0.9);
		// Her lines START their own rise rather than carry on Theo's: the swap often lands while Theo's lines are still
		// rising, so the opacity above alone cannot tell the two apart.
		const riseOf = (who: string) => log.find((f) => f.name === who && f.riseStart !== null)?.riseStart ?? null;
		const theoRise = riseOf('Theo');
		expect(theoRise, 'Theo’s lines never rose').not.toBeNull();
		expect(riseOf('Ana') ?? -1, 'Ana’s lines took over Theo’s rise').toBeGreaterThan(theoRise!);
		test.info().annotations.push({
			type: 'swap',
			description: `layer opacity ${log[swap]!.layer.toFixed(2)} at the swap, ${Math.round(log[swap]!.t - log[on]!.t)} ms after Theo's card came up`
		});
	} finally {
		await worker.stop();
	}
});

test('under prefers-reduced-motion: reduce the card cuts in and out, and nothing moves', async ({ world }) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { longLyricLines: true });
	try {
		const { maya, theo, tv } = await room(world, true);
		await queueReady(theo, 'believin');
		await expect(tv.locator('.upnext')).toContainText('Theo', { timeout: 10_000 });
		const t0 = await now(tv);
		await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(tv.locator(SEL.stateNext)).toContainText('Theo', { timeout: 5_000 });
		await expect(tv.locator(SEL.stateNext)).toHaveCount(0, { timeout: 10_000 });
		await reelSettled(tv);
		const log = await frames(tv, t0);
		const p = phases(log);
		expect(p.enter.length).toBeGreaterThan(1);
		// The reel cuts back in, as the card cut out.
		expectReelArrives(p.after, 'reduce', true);
		expect(log.filter(between), 'a part-way frame under reduce').toEqual([]);
		expect(
			log.filter((f) => f.nameTransform !== null && f.nameTransform !== 'none'),
			'the name moved under reduce'
		).toEqual([]);
		// Gone with the hold, not held for a fade that is not there: the frame the layer drops is the card's last.
		const offAt = log.findIndex((f, i) => i > 0 && log[i - 1]!.shown && !f.shown);
		expect(log.slice(offAt + 1).filter((f) => f.name !== null)).toEqual([]);
	} finally {
		await worker.stop();
	}
});

// The reviewer's reversal leg (#1018 round 2): Theo's card is still fading in when his song is skipped with nobody
// after him, so the takeover clears mid-fade and the layer's transition REVERSES. Chromium fires `transitioncancel`
// there with the reversed fade already running; a card dropped on it left an empty scrim fading out.
// Keyed on how far the fade-in has got, not on a delay: a skip that lands before the fade-in's first painted step finds
// the layer still at 0, where there is nothing to reverse and the card rightly just goes. Not lower than 0.5: Chromium
// scales a reversed transition by how far it had got, so from ~0.25 it lasts about one frame. Even from 0.75 one 150 ms
// frame under load swallowed the whole reversal, so the leg plays the page's animations 5× slower (CDP
// `Animation.setPlaybackRate`): the same transitions and events, spread over enough frames to see. Timers are untouched.
for (const atOpacity of [0.5, 0.75]) {
	test(`a card cleared at ${atOpacity} into its fade-in keeps its words through the reversed fade`, async ({
		world
	}) => {
		test.setTimeout(180_000);
		const worker = await startFakeWorker(world, { longLyricLines: true });
		try {
			const { maya, theo, tv } = await room(world, false);
			await queueReady(theo, 'believin');
			await expect(tv.locator('.upnext')).toContainText('Theo', { timeout: 10_000 });
			await sendPlayerCommand(theo, { cmd: 'play' });
			const cdp = await tv.context().newCDPSession(tv);
			await cdp.send('Animation.enable');
			await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.2 });
			const t0 = await now(tv);
			await maya.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
			await expect(tv.locator(SEL.takeoverShown)).toHaveCount(1, { timeout: 5_000 });
			await tv.waitForFunction(
				(o) => Number(getComputedStyle(document.querySelector('.takeover-layer')!).opacity) >= o,
				atOpacity,
				{ polling: 'raf', timeout: 5_000 }
			);
			await sendPlayerCommand(theo, { cmd: 'skip' });
			await expect(tv.locator(SEL.takeoverShown)).toHaveCount(0, { timeout: 10_000 });
			await expect(tv.locator(SEL.stateNext)).toHaveCount(0, { timeout: 10_000 });
			const log = await frames(tv, t0);
			const on = log.findIndex((f) => f.shown);
			const off = log.findIndex((f, i) => i > on && !f.shown);
			// Every exit frame the scrim still shows on.
			const visible = log.slice(off).filter((f) => f.layer > 0.005);
			const timeline = log
				.slice(on, off + 8)
				.map((f) => `${Math.round(f.t - log[on]!.t)}:${f.shown ? 'up' : 'out'}:${f.layer.toFixed(2)}:${f.name ?? '∅'}`)
				.join(' ');
			expect(visible.length, `the card cut out: ${timeline}`).toBeGreaterThan(0);
			expect(visible.filter(between).length, `no part-way frame: ${timeline}`).toBeGreaterThan(0);
			expect(
				visible.map((f) => f.name),
				`an empty scrim faded: ${timeline}`
			).toEqual(visible.map(() => 'Theo'));
		} finally {
			await worker.stop();
		}
	});
}

/** Alice's song ends by itself into Bob's. `withholdMs`: Bob's bytes are held that long past the end, so the TV misses
 *  its preload and the card is held as the `loading` card until his player is ready (the same route as p21). `lagMs`:
 *  the TV's `ended` reaches the server that late, so the card says "Up next Bob" until the server confirms him. Returns
 *  the frame log from just before the end, with the layer's exits and the hold's end in that span. */
async function naturalEnd(world: World, { withholdMs = 0, lagMs = 0 }) {
	const alice = await world.openPhone('Alice');
	const bob = await world.openPhone('Bob');
	await openBrowseFromHome(alice);
	await openBrowseFromHome(bob);
	const s1 = await processTrack(alice, world.baseURL, TRACKS.caroline);
	const s2 = await processTrack(bob, world.baseURL, TRACKS.believin);
	const isSong = (s: typeof s1, src: string) =>
		src.includes(s.id) || (!!s.instrumentalRef && src.includes(s.instrumentalRef));
	let ended = false;
	const tv = await world.openTv();
	await logFrames(tv);
	if (withholdMs > 0)
		await tv.route(
			(u) => isSong(s2, u.pathname),
			async (r) => {
				while (!ended) await new Promise((res) => setTimeout(res, 20));
				await new Promise((res) => setTimeout(res, withholdMs));
				await r.continue().catch(() => {});
			}
		);
	await tv.reload();
	await tapStage(tv);
	await armMediaLog(tv);
	if (lagMs > 0)
		await tv.evaluate((hold) => {
			const send = WebSocket.prototype.send;
			WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
				if (typeof data === 'string' && data.includes('"status":"ended"')) {
					setTimeout(() => send.call(this, data), hold);
					return;
				}
				return send.call(this, data);
			};
		}, lagMs);
	await queueReadyTrack(alice, TRACKS.caroline);
	await returnHomeFromBrowse(alice);
	await queueReadyTrack(bob, TRACKS.believin);
	await returnHomeFromBrowse(bob);
	const endedAt = async () => (await readMediaLog(tv)).find((e) => e.ev === 'ended' && isSong(s1, e.src))?.t;
	await expect.poll(endedAt, { timeout: 40_000, intervals: [20] }).toBeDefined();
	ended = true;
	const t0 = (await endedAt())! - 300;
	// Bob's card up, then gone and unmounted.
	await expect(tv.locator(SEL.stateNext)).toContainText('Bob', { timeout: 10_000 });
	await expect(tv.locator(SEL.stateNext)).toHaveCount(0, { timeout: withholdMs + lagMs + 10_000 });
	await reelSettled(tv);
	return { log: await frames(tv, t0), exits: await exits(tv, t0), holdEnds: await holdEnds(tv, t0) };
}

test('a missed-preload card fades out with its words, then the lyrics come in', async ({ world }) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { longLyricLines: true });
	try {
		// Held 5 s past the end: past the 2.5 s hold, so it is the `loading` card that leaves, from TvPlayer's `onready`.
		const { log } = await naturalEnd(world, { withholdMs: 5_000 });
		const off = log.findIndex((f, i) => i > 0 && log[i - 1]!.shown && !f.shown);
		expect(off, 'Bob’s card never left').toBeGreaterThan(0);
		// It was up past its hold: the bytes arrived after it.
		const on = log.findIndex((f) => f.shown);
		expect(log[off]!.t - log[on]!.t, 'the card was not held for the missed preload').toBeGreaterThan(3_500);
		const fading = log.slice(off).filter(between);
		expect(fading.length, 'the missed-preload card CUT out').toBeGreaterThan(0);
		expect(
			fading.map((f) => f.name),
			'an empty scrim faded: the card lost its words on its exit'
		).toEqual(fading.map(() => 'Bob'));
		expect(fading.filter((f) => f.lyrics).length, 'lyrics under the fading card').toBe(0);
		expectReelArrives(log.slice(off), 'missed preload');
		// For the record, not asserted (headless frame times are not a TV's): the longest frame from the drop to +500 ms.
		const exit = log.filter((f) => f.t >= log[off - 1]!.t && f.t <= log[off]!.t + 500);
		test.info().annotations.push({
			type: 'exit-frames',
			description: `longest ${Math.round(Math.max(...exit.slice(1).map((f, i) => f.t - exit[i]!.t)))} ms over ${exit.length} frames`
		});
	} finally {
		await worker.stop();
	}
});

// A slot ready LATE: Bob's bytes are held 2.15 s past the end, so when the lead falls due (370 ms before the 2.5 s
// hold ends) his slot is still loading and the hold's end would not start his song; it becomes ready a moment later,
// inside the hold. The lead then starts from the player's `onready`, and the card still leaves before the hold ends.
test('a slot ready after the lead was due still leads the exit, from its onready', async ({ world }) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { longLyricLines: true });
	try {
		const { log, exits: out, holdEnds: ends } = await naturalEnd(world, { withholdMs: 2_150 });
		const bobUp = log.find((f) => f.shown && f.name === 'Bob');
		expect(bobUp, 'Bob’s card never came up').toBeDefined();
		const end = ends.find((t) => t > bobUp!.t);
		const exit = out.find((e) => e.t > bobUp!.t);
		expect(end, 'Bob’s hold never ended').toBeDefined();
		expect(exit, 'Bob’s card never left').toBeDefined();
		const timeline = `card up 0, exit ${Math.round(exit!.t - bobUp!.t)}, hold end ${Math.round(end! - bobUp!.t)}`;
		// Not before the lead was due: the slot was still loading then (else this run never took the late path).
		expect(Math.round(end! - exit!.t), `the exit led by more than the lead (${timeline})`).toBeLessThan(370);
		expect(Math.round(end! - exit!.t), `the card did not leave before its hold ended (${timeline})`).toBeGreaterThan(0);
	} finally {
		await worker.stop();
	}
});

test('"Up next" turning "Now singing" re-rises the lines, and the layer stays up', async ({ world }) => {
	test.setTimeout(180_000);
	const worker = await startFakeWorker(world, { longLyricLines: true });
	try {
		// A gapless end with a slow round trip: the card says "Up next Bob" until the server confirms him.
		const { log } = await naturalEnd(world, { lagMs: 1_500 });
		const riseOf = (label: string) =>
			log.find((f) => f.name === 'Bob' && f.label === label && f.riseStart !== null)?.riseStart ?? null;
		const upNext = riseOf('Up next');
		expect(upNext, 'no "Up next Bob" frame with its rise running').not.toBeNull();
		expect(riseOf('Now singing') ?? -1, 'the words changed but the lines did not rise again').toBeGreaterThan(upNext!);
		const on = log.findIndex((f) => f.shown);
		const off = log.findIndex((f, i) => i > on && !f.shown);
		const up = log.slice(on, off);
		expect(
			up.slice(1).filter((f, i) => f.layer < up[i]!.layer - 0.01),
			'the layer dipped at the words change'
		).toEqual([]);
	} finally {
		await worker.stop();
	}
});
