// MOTION CAPTURE for UI review: one real animation in, three artifacts out.
//
//   clip.gif        for the human — real-time pacing, held before/after frames so the loop reads
//   filmstrip.png   for an agent that sees images but not video — every frame labelled with its ms
//   metrics.json    the numbers the strip cannot show: declared timing, rAF cadence, long frames, CLS,
//                   and whether `prefers-reduced-motion: reduce` actually removed the motion
//
// TWO RUNS PER ANIMATION, because one run cannot be both deterministic and honest:
//   SEEK run  — every animation that starts after `arm()` is caught on its first event and PAUSED, then
//               stepped through `currentTime` in fixed increments with a screenshot at each. The frames are
//               exact (frame N is the animation at N×step ms) whatever the box's load, which is what makes a
//               strip comparable across runs and reviewable by an agent.
//   LIVE run  — the same trigger, unpaused, with rAF timestamps, Long Animation Frame entries and layout-shift
//               entries collected over the animation's window. This is the jank/CLS evidence; the seek run
//               has none, because it does not run in real time.
// Headless Chromium runs with --disable-gpu (playwright.config.ts), so LIVE numbers are a floor on what software
// rasterisation can do on this box — not a TV's GPU and not a phone's. See docs/UI-CHECKLIST.md#limits.
//
// Run it with `bun run ui:review` (docs/UI-CHECKLIST.md says what a reviewer reads off the output).
//
// Zero system deps: PNG decode is pngjs, GIF encode is gifenc (pure JS), the contact sheet is laid out as HTML
// and photographed by the same Chromium. No ffmpeg, no gifski, no sharp.
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
// gifenc ships CJS + ESM without types, and its package.json has no `exports`, so Playwright's loader resolves the
// CJS build: take the default and destructure.
// @ts-expect-error untyped
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;

export interface Clip {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface MotionScenario {
	/** Output directory name under the samples root. */
	name: string;
	/** What the reviewer should look for. Written into metrics.json and onto the strip. */
	what: string;
	/** Bring a page to the state just BEFORE the motion. Gets a fresh page per run. */
	open(contextOptions: BrowserContextOptions): Promise<Page>;
	/** Fire the motion. Must resolve once the trigger has been delivered (not once motion ends). */
	trigger(page: Page): Promise<void>;
	/** Region of interest for the strip; the GIF uses `gifClip` or the full viewport. */
	stripClip?: (page: Page) => Promise<Clip | undefined>;
	gifClip?: (page: Page) => Promise<Clip | undefined>;
	/** Seek step in ms. ~33 for a 0.5 s+ motion, ~12-16 for a 120 ms one. */
	stepMs?: number;
	/** Render scale for frames (deviceScaleFactor). 0.5 keeps a 1080p TV GIF under 2 MB. */
	scale?: number;
	/** How long to wait for the trigger's first animation before calling it "no motion". */
	startTimeoutMs?: number;
	/** Thumbnails per row on the strip. */
	columns?: number;
	/** CSS selector the animation's target must match to be CAUGHT (seeked, timed). Anything else that starts
	 *  in the window is still listed under `others`, which is how an unrelated fade gets noticed rather than
	 *  silently becoming the subject. */
	only?: string;
	/** Scenario-specific facts read after each run (e.g. "did the phrase change"), kept in metrics.json. */
	observe?(page: Page): Promise<unknown>;
}

export interface AnimationRecord {
	kind: string;
	name: string;
	target: string;
	durationMs: number;
	delayMs: number;
	endTimeMs: number;
	easing: string;
	iterations: number;
	fill: string;
	/** What it animates. `vestibular` = moves or resizes something (transform, position, size), which is what
	 *  `prefers-reduced-motion` exists to stop; opacity and colour fades are not. */
	properties: string[];
	vestibular: boolean;
}

export interface LiveReport {
	animations: AnimationRecord[];
	others: AnimationRecord[];
	windowMs: number;
	rafFrames: number;
	frameIntervalsMs: { p50: number; p95: number; max: number };
	/** Intervals over 1.5× the median vsync — a frame the compositor did not get to in time. */
	droppedFrames: number;
	longAnimationFrames: { count: number; worstMs: number; supported: boolean };
	cls: { total: number; excludingRecentInput: number; entries: number };
}

// ── in-page instrumentation ──────────────────────────────────────────────────────────────────────────────

/**
 * Installed as an init script, so it is in place before the app's first animation. Inert until `arm()`.
 * Catches CSS animations and transitions through their start events (capture phase, so a component's own
 * listener cannot hide them) and WAAPI animations — Svelte 5 transitions included — by wrapping
 * `Element.prototype.animate`.
 */
function instrument() {
	type M = {
		armed: boolean;
		freeze: boolean;
		t0: number;
		caught: Animation[];
		others: Animation[];
		only: string | null;
		raf: number[];
		loaf: number[];
		loafSupported: boolean;
		shifts: { value: number; hadRecentInput: boolean }[];
		arm(freeze: boolean, only: string | null): void;
		catch(a: Animation): void;
	};
	const m: M = {
		armed: false,
		freeze: false,
		t0: 0,
		caught: [],
		others: [],
		only: null,
		raf: [],
		loaf: [],
		loafSupported: false,
		shifts: [],
		arm(freeze, only) {
			m.armed = true;
			m.freeze = freeze;
			m.only = only;
			m.others = [];
			m.t0 = performance.now();
			m.caught = [];
			m.raf = [];
			m.loaf = [];
			m.shifts = [];
			const tick = (t: number) => {
				if (!m.armed) return;
				m.raf.push(t);
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		},
		catch(a) {
			if (!m.armed || m.caught.includes(a) || m.others.includes(a)) return;
			const target = (a.effect as KeyframeEffect | null)?.target;
			if (m.only && !target?.matches(m.only)) {
				m.others.push(a);
				return;
			}
			m.caught.push(a);
			if (m.freeze) {
				// Freeze EVERYTHING so frames are stable (an infinite pulse elsewhere would otherwise move between
				// shots), then rewind only what we caught.
				for (const other of document.getAnimations()) other.pause();
				a.pause();
				a.currentTime = 0;
			}
		}
	};
	(window as unknown as { __motion: M }).__motion = m;

	const fromEvent = (e: Event) => {
		const el = e.target as Element;
		const key = e instanceof AnimationEvent ? e.animationName : e instanceof TransitionEvent ? e.propertyName : null;
		for (const a of el.getAnimations?.() ?? []) {
			const n = (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? undefined;
			if (key === null || n === key) m.catch(a);
		}
	};
	document.addEventListener('animationstart', fromEvent, true);
	document.addEventListener('transitionrun', fromEvent, true);

	const animate = Element.prototype.animate;
	Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
		const a = animate.apply(this, args);
		m.catch(a);
		return a;
	};

	try {
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) if (m.armed) m.loaf.push(e.duration);
		}).observe({ type: 'long-animation-frame', buffered: false });
		m.loafSupported = true;
	} catch {
		// Chromium < 123
	}
	new PerformanceObserver((list) => {
		for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[])
			if (m.armed) m.shifts.push({ value: e.value, hadRecentInput: e.hadRecentInput });
	}).observe({ type: 'layout-shift', buffered: false });
}

/** Serialisable description of what was caught. Run in-page. */
function describeCaught(which: string): AnimationRecord[] {
	const m = (window as unknown as { __motion: Record<'caught' | 'others', Animation[]> }).__motion;
	const MOVES = /^(transform|translate|scale|rotate|top|left|right|bottom|inset|width|height|margin|offset)/;
	const label = (el: Element | null | undefined) => {
		if (!el) return '?';
		const cls = [...el.classList].filter((c) => !c.startsWith('s-') && !c.startsWith('svelte-')).slice(0, 3);
		const slot = el.getAttribute('data-slot');
		return el.tagName.toLowerCase() + (slot ? `[data-slot=${slot}]` : '') + cls.map((c) => '.' + c).join('');
	};
	return m[which as 'caught' | 'others'].map((a) => {
		const effect = a.effect as KeyframeEffect | null;
		const timing = effect?.getComputedTiming();
		const kind = a.constructor.name;
		const skip = new Set(['offset', 'computedOffset', 'easing', 'composite']);
		const properties =
			kind === 'CSSTransition'
				? [(a as CSSTransition).transitionProperty]
				: [...new Set((effect?.getKeyframes() ?? []).flatMap((k) => Object.keys(k).filter((p) => !skip.has(p))))];
		// A CSS animation's timing function lives on its keyframes, so the effect itself reports `linear`.
		const easing =
			kind === 'CSSAnimation' && effect?.target
				? getComputedStyle(effect.target).animationTimingFunction
				: String(effect?.getTiming().easing ?? '');
		return {
			kind,
			name: (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? (a.id || 'element.animate'),
			target: label(effect?.target),
			durationMs: Number(timing?.duration ?? 0),
			delayMs: Number(timing?.delay ?? 0),
			endTimeMs: Number(timing?.endTime ?? 0),
			easing,
			iterations: Number(timing?.iterations ?? 1),
			fill: String(timing?.fill ?? ''),
			properties,
			vestibular: properties.some((p) => MOVES.test(p))
		};
	});
}

// ── runs ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Frame {
	ms: number;
	png: Buffer;
}

async function waitForCatch(page: Page, timeout: number): Promise<boolean> {
	return page
		.waitForFunction(
			() => (window as unknown as { __motion: { caught: unknown[] } }).__motion.caught.length > 0,
			null,
			{
				timeout,
				polling: 'raf'
			}
		)
		.then(async () => {
			// Siblings started by the same state change (a dialog and its scrim) dispatch in the same or next frame.
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
			return true;
		})
		.catch(() => false);
}

/** Pause-and-seek capture. Returns frames at -1 (pre-trigger), 0, step, … endTime, and the settled end. */
async function seekRun(page: Page, s: MotionScenario, clip: Clip | undefined, step: number) {
	const shot = (c = clip) => page.screenshot({ clip: c, caret: 'hide', animations: 'allow' });
	const pre = await shot();
	await page.evaluate(
		(only) => (window as unknown as { __motion: { arm(f: boolean, o: string | null): void } }).__motion.arm(true, only),
		s.only ?? null
	);
	await s.trigger(page);
	// Nothing animated: a CUT. Keep the after frame too, so the strip shows the jump instead of only the before.
	if (!(await waitForCatch(page, s.startTimeoutMs ?? 3000)))
		return {
			frames: [
				{ ms: -1, png: pre },
				{ ms: 0, png: await shot() }
			],
			animations: []
		};
	const animations = await page.evaluate(describeCaught, 'caught');
	const end = Math.max(...animations.map((a) => (Number.isFinite(a.endTimeMs) ? a.endTimeMs : a.durationMs)));
	const frames: Frame[] = [{ ms: -1, png: pre }];
	const times: number[] = [];
	for (let t = 0; t < end; t += step) times.push(t);
	times.push(end);
	for (const t of times) {
		await page.evaluate((ms) => {
			for (const a of (window as unknown as { __motion: { caught: Animation[] } }).__motion.caught) a.currentTime = ms;
		}, t);
		frames.push({ ms: Math.round(t), png: await shot() });
	}
	return { frames, animations };
}

async function liveRun(page: Page, s: MotionScenario): Promise<LiveReport> {
	await page.evaluate(
		(only) =>
			(window as unknown as { __motion: { arm(f: boolean, o: string | null): void } }).__motion.arm(false, only),
		s.only ?? null
	);
	const t0 = Date.now();
	await s.trigger(page);
	const caught = await waitForCatch(page, s.startTimeoutMs ?? 3000);
	const animations = caught ? await page.evaluate(describeCaught, 'caught') : [];
	const end = animations.length ? Math.max(...animations.map((a) => a.endTimeMs)) : 0;
	// Run past the end by a vsync-generous margin so the settle frame is counted too.
	await page.waitForTimeout(Math.max(0, end + 150 - (Date.now() - t0)));
	const raw = await page.evaluate(() => {
		const m = (
			window as unknown as {
				__motion: {
					armed: boolean;
					raf: number[];
					loaf: number[];
					loafSupported: boolean;
					shifts: { value: number; hadRecentInput: boolean }[];
				};
			}
		).__motion;
		m.armed = false;
		return { raf: m.raf, loaf: m.loaf, loafSupported: m.loafSupported, shifts: m.shifts };
	});
	const others = await page.evaluate(describeCaught, 'others');
	const iv = raw.raf.slice(1).map((t, i) => t - raw.raf[i]);
	const sorted = [...iv].sort((a, b) => a - b);
	const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
	const median = q(0.5) || 16.7;
	const r1 = (n: number) => Math.round(n * 10) / 10;
	return {
		animations,
		others,
		windowMs: Math.round(raw.raf.length ? raw.raf[raw.raf.length - 1] - raw.raf[0] : 0),
		rafFrames: raw.raf.length,
		frameIntervalsMs: { p50: r1(median), p95: r1(q(0.95)), max: r1(sorted[sorted.length - 1] ?? 0) },
		droppedFrames: iv.filter((d) => d > median * 1.5).length,
		longAnimationFrames: {
			count: raw.loaf.length,
			worstMs: r1(Math.max(0, ...raw.loaf)),
			supported: raw.loafSupported
		},
		cls: {
			total: Number(raw.shifts.reduce((n, e) => n + e.value, 0).toFixed(4)),
			excludingRecentInput: Number(
				raw.shifts
					.filter((e) => !e.hadRecentInput)
					.reduce((n, e) => n + e.value, 0)
					.toFixed(4)
			),
			entries: raw.shifts.length
		}
	};
}

/** Under reduce there is usually nothing to seek, so this is a real-time burst: screenshots as fast as they come. */
async function reducedRun(page: Page, s: MotionScenario, clip: Clip | undefined, windowMs: number) {
	const pre = await page.screenshot({ clip, caret: 'hide' });
	await page.evaluate(
		(only) =>
			(window as unknown as { __motion: { arm(f: boolean, o: string | null): void } }).__motion.arm(false, only),
		s.only ?? null
	);
	await s.trigger(page);
	// Timed from the trigger RESOLVING: a clock-driven trigger (the TV's) can spend seconds waiting first.
	const t0 = Date.now();
	const frames: Frame[] = [{ ms: -1, png: pre }];
	while (Date.now() - t0 < windowMs)
		frames.push({ ms: Date.now() - t0, png: await page.screenshot({ clip, caret: 'hide' }) });
	const animations = await page.evaluate(describeCaught, 'caught');
	const others = await page.evaluate(describeCaught, 'others');
	return { frames, animations, others };
}

// ── encoders ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * GIF at real-time pacing. GIF delays are in 10 ms units and browsers clamp anything under 20 ms to ~100 ms,
 * so a frame's delay is never below 20 — a 120 ms motion with 12 ms steps plays slightly slow rather than 5×
 * slow. `hold` frames before and after are what make the loop readable.
 */
function encodeGif(frames: Frame[], step: number, { holdMs = 700, slow = 1 } = {}): Buffer {
	const gif = GIFEncoder();
	frames.forEach((f, i) => {
		const img = PNG.sync.read(f.png);
		const rgba = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length);
		const palette = quantize(rgba, 256);
		const index = applyPalette(rgba, palette);
		const last = i === frames.length - 1;
		const delay = f.ms < 0 || last ? holdMs : Math.max(20, Math.round((step * slow) / 10) * 10);
		gif.writeFrame(index, img.width, img.height, { palette, delay });
	});
	gif.finish();
	return Buffer.from(gif.bytes());
}

/** Cut `clip` (page CSS px) out of a frame that was shot at `origin` (or the viewport) and `scale`. */
function crop(png: Buffer, clip: Clip, origin: Clip | undefined, scale: number): Buffer {
	const src = PNG.sync.read(png);
	const x = Math.max(0, Math.round((clip.x - (origin?.x ?? 0)) * scale));
	const y = Math.max(0, Math.round((clip.y - (origin?.y ?? 0)) * scale));
	const w = Math.min(src.width - x, Math.round(clip.width * scale));
	const h = Math.min(src.height - y, Math.round(clip.height * scale));
	const dst = new PNG({ width: w, height: h });
	PNG.bitblt(src, dst, x, y, w, h, 0, 0);
	return PNG.sync.write(dst);
}

/** The contact sheet, laid out as HTML and photographed — labels in a real font with no image library. */
async function filmstrip(
	browser: Browser,
	title: string,
	sub: string,
	frames: Frame[],
	columns: number
): Promise<Buffer> {
	const { width, height } = PNG.sync.read(frames[0].png);
	const thumbW = Math.min(width, Math.floor(1900 / columns) - 12);
	const thumbH = Math.round((height * thumbW) / width);
	const cells = frames
		.map(
			(f, i) =>
				`<figure><img src="data:image/png;base64,${f.png.toString('base64')}" width="${thumbW}" height="${thumbH}"><figcaption><b>${
					f.ms < 0 ? 'before' : `${f.ms} ms`
				}</b><span>#${i}</span></figcaption></figure>`
		)
		.join('');
	const html = `<!doctype html><style>
		body{margin:0;padding:12px;background:#111;color:#eee;font:14px system-ui,sans-serif;width:max-content}
		h1{font-size:16px;margin:0 0 2px}p{margin:0 0 10px;color:#aaa;max-width:${columns * (thumbW + 12)}px}
		main{display:grid;grid-template-columns:repeat(${columns},${thumbW}px);gap:12px}
		figure{margin:0}img{display:block;outline:1px solid #444;image-rendering:auto}
		figcaption{display:flex;justify-content:space-between;padding-top:3px;font-variant-numeric:tabular-nums}
		b{color:#ffd166}span{color:#777}</style><h1>${title}</h1><p>${sub}</p><main>${cells}</main>`;
	const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 400, height: 300 } });
	const page = await ctx.newPage();
	await page.setContent(html);
	const png = await page.locator('body').screenshot();
	await ctx.close();
	return png;
}

// ── the entry point ──────────────────────────────────────────────────────────────────────────────────────

export interface CaptureResult {
	dir: string;
	files: Record<string, { path: string; bytes: number }>;
	metrics: Record<string, unknown>;
}

export async function captureMotion(browser: Browser, s: MotionScenario, outRoot: string): Promise<CaptureResult> {
	const dir = join(outRoot, s.name);
	mkdirSync(dir, { recursive: true });
	const step = s.stepMs ?? 33;
	const scale = s.scale ?? 1;
	const cols = s.columns ?? 6;
	const timing: Record<string, number> = {};
	const clock = async <T>(label: string, fn: () => Promise<T>) => {
		const t = Date.now();
		const r = await fn();
		timing[label] = Date.now() - t;
		return r;
	};
	const files: CaptureResult['files'] = {};
	const write = (name: string, buf: Buffer | string) => {
		const path = join(dir, name);
		writeFileSync(path, buf);
		files[name] = { path, bytes: Buffer.byteLength(buf) };
	};
	const withPage = async <T>(opts: BrowserContextOptions, fn: (p: Page) => Promise<T>) => {
		const page = await s.open({ deviceScaleFactor: scale, ...opts });
		await page.addInitScript(instrument);
		// The init script only runs on the NEXT document; reload so the open state carries the instrument.
		// Scenarios whose state survives a reload (most routes) need nothing more; others call instrument() in open.
		await page.evaluate(instrument);
		try {
			return await fn(page);
		} finally {
			await page.context().close();
		}
	};

	// 1. SEEK — full-motion, paused and stepped.
	const seek = await clock('seekMs', () =>
		withPage({}, async (page) => {
			const gifClip = s.gifClip ? await s.gifClip(page) : undefined;
			const stripClip = s.stripClip ? await s.stripClip(page) : gifClip;
			// The GIF and the strip may want different crops, so frames are shot once at the union (the GIF clip)
			// and the strip is re-shot only when its crop differs.
			const gifRun = await seekRun(page, s, gifClip, step);
			return { gifRun, stripClip, gifClip, observed: await s.observe?.(page) };
		})
	);
	// The strip is a crop of the GIF's frames, not a second run: one seek pass per animation.
	const stripFrames =
		seek.stripClip && seek.stripClip !== seek.gifClip
			? seek.gifRun.frames.map((f) => ({ ms: f.ms, png: crop(f.png, seek.stripClip!, seek.gifClip, scale) }))
			: seek.gifRun.frames;
	const motionEnd = Math.max(0, ...seek.gifRun.animations.map((a) => a.endTimeMs));

	await clock('encodeMs', async () => {
		write('clip.gif', encodeGif(seek.gifRun.frames, step));
		write('clip-slow4x.gif', encodeGif(seek.gifRun.frames, step, { slow: 4 }));
		write(
			'filmstrip.png',
			await filmstrip(
				browser,
				`${s.name} — seek-rendered, ${step} ms steps`,
				`${s.what} · frames are exact animation times (paused + currentTime), not wall-clock samples`,
				stripFrames,
				cols
			)
		);
	});

	// 2. LIVE — real-time cadence, long frames, CLS.
	const live = await clock('liveMs', () =>
		withPage({}, async (page) => ({ ...(await liveRun(page, s)), observed: await s.observe?.(page) }))
	);

	// 3. REDUCED — the same trigger with the OS preference set.
	const reduced = await clock('reducedMs', () =>
		withPage({ reducedMotion: 'reduce' }, async (page) => {
			const clip = s.stripClip ? await s.stripClip(page) : s.gifClip ? await s.gifClip(page) : undefined;
			return {
				...(await reducedRun(page, s, clip, Math.max(300, motionEnd + 200))),
				observed: await s.observe?.(page)
			};
		})
	);
	await clock('reducedEncodeMs', async () =>
		write(
			'filmstrip-reduced.png',
			await filmstrip(
				browser,
				`${s.name} — prefers-reduced-motion: reduce, real-time burst`,
				`${reduced.animations.length} animation(s) started under reduce · labels are wall-clock ms after the trigger`,
				reduced.frames.slice(0, cols * 2),
				cols
			)
		)
	);

	const metrics = {
		scenario: s.name,
		what: s.what,
		capturedAt: new Date().toISOString(),
		stepMs: step,
		scale,
		declared: seek.gifRun.animations,
		motionEndMs: motionEnd,
		seekFrames: seek.gifRun.frames.length,
		seekObserved: seek.observed,
		live,
		reducedMotion: {
			animationsStarted: reduced.animations.length,
			animations: reduced.animations,
			// Strict: the subject did not animate at all. Lenient: nothing that MOVES ran, anywhere on the page —
			// a cross-fade under reduce is acceptable, a slide or scale is not.
			honoured: reduced.animations.length === 0,
			noVestibularMotion: ![...reduced.animations, ...reduced.others].some((a) => a.vestibular),
			others: reduced.others,
			burstFrames: reduced.frames.length,
			observed: reduced.observed
		},
		timingsMs: timing,
		files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.bytes]))
	};
	write('metrics.json', JSON.stringify(metrics, null, 2) + '\n');
	return { dir, files, metrics };
}
