// THE REAL-TIME PASS of `ui:review` (world/motion.ts runs it for a row with `realtime`): the page unpaused, its CPU
// throttled (and once with a late first frame), recorded as painted. The seek run cannot show a motion that STARTS
// late, because its clock starts with the motion (#1000). Pixels come from CDP's screencast; positions come from the
// instrument's own rAF loop (`track` in motion.ts), once per rendered frame. The analysis and the encoder are pure,
// so tests/unit/playwright/motion-realtime.test.ts pins them.
import type { Page } from '@playwright/test';
import type { MotionScenario } from './motion';
// gifenc ships CJS + ESM without types, and its package.json has no `exports`, so Playwright's loader resolves the
// CJS build (the functions are on the default) while bun (the unit tests, `publish-media`) resolves the ESM one
// (they are named exports, and the default is empty). motion.ts takes them from here too.
// @ts-expect-error untyped
import * as gifenc from 'gifenc';
export const { GIFEncoder, quantize, applyPalette } = gifenc.GIFEncoder ? gifenc : gifenc.default;

/** Per media file. Two per row (the GIF and the strip) keeps a four-row PR under about 12 MB. `publish-media` and
 *  the real-time encoder both refuse a file over it, with the same message. */
export const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
export const overCap = (file: string, bytes: number) =>
	`${file} is ${bytes} bytes, over the ${MAX_FILE_BYTES}-byte (1.5 MB) cap: lower the row's scale or crop it`;

/** What a real-time run kept in the page: per rendered frame, `[id, l, t, r, b, opacity]` per box. */
export interface RealtimeTrace {
	raf: number[];
	frames: { t: number; e: number[][]; a: number[][] }[];
	labels: Record<number, string>;
	mounts: Record<number, number>;
	starts: Record<number, number>;
	/** performance.now() when the trigger was fired. */
	t0: number;
}

export interface RealtimeReport {
	/** CDP CPU throttle rate, 1 for none. */
	throttle: number;
	/** How much slower a fixed in-page busy loop ran once the throttle was set: the throttle as applied, not as asked.
	 *  null: this run is not throttled. */
	throttleRatio: number | null;
	/** The late-first-frame stall: where it ran (at the first `each` mount, or right after the trigger when none
	 *  mounted by then) and when, in ms after the trigger. null: this run has none. */
	stall: { ms: number; at: 'mount' | 'after-trigger'; atMs: number } | null;
	windowMs: number;
	sampledFrames: number;
	/** Painted frames from the screencast, which is paced by acks, so a gap there is not a dropped frame. */
	screencastFrames: number;
	/** rAF intervals over 1.5× the median, out of all intervals: the live pass's rule. */
	droppedFrames: number;
	rafIntervals: number;
	/** Frames where two visible `each` boxes, or a visible `each` and a visible `avoid`, intersect. Visible: effective
	 *  opacity over 0.05. `eachFrames` and `avoidFrames` split them by which kind of pair hit (a frame can have both);
	 *  `worstPx` is the deepest intersection; `first` the first 10. */
	overlap: {
		frames: number;
		eachFrames: number;
		avoidFrames: number;
		worstPx: number;
		first: { ms: number; a: string; b: string }[];
	};
	/** The same, where at least one of the pair is not visible: invisible, but a sign the spacing is gone. */
	hiddenOverlap: number;
	/** Smallest separation between two visible `each` boxes; negative is an overlap that deep. null: never two. */
	minGapPx: number | null;
	/** Frames with no visible `each` between two that have one: a hole in a stream. */
	blankFrames: number;
	/** Per `each` element that mounted in the run, mount to its first animationstart/transitionstart. */
	firstFrameMs: { worst: number | null; each: { id: string; ms: number | null }[] };
	/** How far each `each` box moved over the run (the larger of its top's and left's range). */
	travelPx: { max: number; each: { id: string; px: number }[] };
	line: string;
	/** How the GIF got under the cap: frames kept, identical neighbours merged, every other frame dropped. */
	gif?: { frames: number; merged: number; halved: boolean };
}

const VISIBLE = 0.05;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Separation of two boxes: positive is the gap between them, negative how deep they intersect. */
function separation(a: number[], b: number[]): number {
	return Math.max(a[1] - b[3], b[1] - a[3], a[2] - b[4], b[2] - a[4]);
}

/** The numbers a real-time run is read by, from its in-page trace. Pure, so it is unit-tested. */
export function analyseRealtime(
	tr: RealtimeTrace,
	run: {
		label: string;
		throttle: number;
		throttleRatio: number | null;
		stall: RealtimeReport['stall'];
		windowMs: number;
		screencastFrames: number;
	}
): RealtimeReport {
	const ms = (t: number) => Math.round(t - tr.t0);
	const name = (id: number) => tr.labels[id] ?? `#${id}`;
	let overlapFrames = 0;
	let eachFrames = 0;
	let avoidFrames = 0;
	let hiddenOverlap = 0;
	let worst = 0;
	let minGap = Infinity;
	const first: RealtimeReport['overlap']['first'] = [];
	const shown: boolean[] = [];
	for (const f of tr.frames) {
		let hitEach = false;
		let hitAvoid = false;
		let hidden = false;
		const pairs: [number[], number[]][] = [];
		for (let i = 0; i < f.e.length; i++) {
			for (let j = i + 1; j < f.e.length; j++) pairs.push([f.e[i], f.e[j]]);
			for (const a of f.a) if (a[0] !== f.e[i][0]) pairs.push([f.e[i], a]);
		}
		for (const [a, b] of pairs) {
			const sep = separation(a, b);
			const visible = a[5] > VISIBLE && b[5] > VISIBLE;
			const isEach = f.e.includes(b);
			if (visible && isEach) minGap = Math.min(minGap, sep);
			if (sep >= 0) continue;
			if (!visible) {
				hidden = true;
				continue;
			}
			if (isEach) hitEach = true;
			else hitAvoid = true;
			worst = Math.max(worst, -sep);
			if (first.length < 10) first.push({ ms: ms(f.t), a: name(a[0]), b: name(b[0]) });
		}
		if (hitEach) eachFrames++;
		if (hitAvoid) avoidFrames++;
		if (hitEach || hitAvoid) overlapFrames++;
		else if (hidden) hiddenOverlap++;
		shown.push(f.e.some((e) => e[5] > VISIBLE));
	}
	const lo = shown.indexOf(true);
	const hi = shown.lastIndexOf(true);
	const blankFrames = lo < 0 ? 0 : shown.slice(lo, hi + 1).filter((s) => !s).length;

	const iv = tr.raf.slice(1).map((t, i) => t - tr.raf[i]);
	const sorted = [...iv].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)] || 16.7;
	const droppedFrames = iv.filter((d) => d > median * 1.5).length;

	const firstFrame = Object.entries(tr.mounts).map(([id, at]) => ({
		id: name(Number(id)),
		ms: tr.starts[Number(id)] === undefined ? null : Math.round(tr.starts[Number(id)] - at)
	}));
	const known = firstFrame.flatMap((f) => (f.ms === null ? [] : [f.ms]));
	const range = new Map<number, { t: number[]; l: number[] }>();
	for (const f of tr.frames)
		for (const e of f.e) {
			const r = range.get(e[0]) ?? { t: [], l: [] };
			r.t.push(e[2]);
			r.l.push(e[1]);
			range.set(e[0], r);
		}
	const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
	const travel = [...range].map(([id, r]) => ({ id: name(id), px: r1(Math.max(spread(r.t), spread(r.l))) }));

	const report: Omit<RealtimeReport, 'line'> = {
		throttle: run.throttle,
		throttleRatio: run.throttleRatio === null ? null : r1(run.throttleRatio),
		stall: run.stall,
		windowMs: run.windowMs,
		sampledFrames: tr.frames.length,
		screencastFrames: run.screencastFrames,
		droppedFrames,
		rafIntervals: iv.length,
		overlap: { frames: overlapFrames, eachFrames, avoidFrames, worstPx: r1(worst), first },
		hiddenOverlap,
		minGapPx: Number.isFinite(minGap) ? r1(minGap) : null,
		blankFrames,
		firstFrameMs: { worst: known.length ? Math.max(...known) : null, each: firstFrame },
		travelPx: { max: Math.max(0, ...travel.map((t) => t.px)), each: travel }
	};
	const line =
		`${run.label.padEnd(18)} overlap ${overlapFrames} frames` +
		(overlapFrames ? ` (worst ${report.overlap.worstPx} px)` : '') +
		` · min gap ${report.minGapPx ?? '—'} px · blank ${blankFrames} · dropped ${droppedFrames}/${iv.length}` +
		` · first frame ${report.firstFrameMs.worst === null ? '—' : `+${report.firstFrameMs.worst} ms`}`;
	return { ...report, line };
}

/** A fixed busy loop in the page, in ms: ~30 ms unthrottled, so a throttle shows as a ratio in ~0.2 s. */
const busyMs = (page: Page) =>
	page.evaluate(() => {
		const t = performance.now();
		let x = 0;
		for (let i = 0; i < 2e7; i++) x += i % 7;
		return performance.now() - t + (x < 0 ? 1 : 0);
	});

/**
 * The real-time pass: the same open and trigger, unpaused, at `throttle`× CPU, optionally with the main thread
 * held `stallMs` once as the first `each` mounts. Pixels come from CDP's screencast, which is what Chromium actually
 * painted, stamped in wall-clock time; positions come from the instrument's own rAF loop, once per rendered frame.
 */
export async function realtimeRun(
	page: Page,
	s: MotionScenario,
	{
		each,
		avoid,
		throttle,
		stallMs,
		windowMs
	}: { each: string; avoid: string | null; throttle: number; stallMs: number; windowMs: number }
) {
	const cdp = await page.context().newCDPSession(page);
	await page.evaluate(
		([only, e, a]) => {
			const m = (
				window as unknown as {
					__motion: { arm(f: boolean, o: string | null): void; track(e: string, a: string | null): void };
				}
			).__motion;
			m.arm(false, only);
			m.track(e, a);
		},
		[s.only ?? null, each, avoid] as const
	);
	if (stallMs)
		await page.evaluate(
			([q, ms]) => {
				const w = window as unknown as { __stall: { at: string; atMs: number } | null; __stallNow(at: string): void };
				w.__stall = null;
				w.__stallNow = (at) => {
					if (w.__stall) return;
					w.__stall = { at, atMs: performance.now() };
					const until = performance.now() + ms;
					while (performance.now() < until);
				};
				const mo = new MutationObserver((records) => {
					if (
						!records.some((r) =>
							[...r.addedNodes].some((n) => n instanceof Element && (n.matches(q) || n.querySelector(q)))
						)
					)
						return;
					mo.disconnect();
					w.__stallNow('mount');
				});
				mo.observe(document.documentElement, { childList: true, subtree: true });
			},
			[each, stallMs] as const
		);
	// Proof the throttle took: the same loop before and after it, measured before the screencast so the probe is not
	// in the recorded window. The first call warms the JIT.
	let throttleRatio: number | null = null;
	if (throttle > 1) {
		await busyMs(page);
		const base = await busyMs(page);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
		throttleRatio = (await busyMs(page)) / base;
	}
	const shots: { at: number; data: string }[] = [];
	cdp.on('Page.screencastFrame', (f) => {
		shots.push({ at: (f.metadata.timestamp ?? Date.now() / 1000) * 1000, data: f.data });
		void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
	});
	const vp = page.viewportSize() ?? { width: 1280, height: 720 };
	const scale = s.scale ?? 1;
	await cdp.send('Page.startScreencast', {
		format: 'png',
		maxWidth: Math.round(vp.width * scale),
		maxHeight: Math.round(vp.height * scale)
	});
	// One clock for both: the page's epoch time at the trigger labels the screencast frames too.
	const { t0, epoch0 } = await page.evaluate(() => {
		const t = performance.now();
		(window as unknown as { __motion: { rt: { t0?: number } } }).__motion.rt.t0 = t;
		return { t0: t, epoch0: performance.timeOrigin + t };
	});
	const started = Date.now();
	await s.trigger(page);
	if (stallMs)
		// Nothing mounted while the trigger ran: hold the thread now instead, so the run still has its late frame.
		await page.evaluate(
			() =>
				new Promise<void>((r) =>
					requestAnimationFrame(() =>
						requestAnimationFrame(() => {
							(window as unknown as { __stallNow(at: string): void }).__stallNow('after-trigger');
							r();
						})
					)
				)
		);
	await page.waitForTimeout(Math.max(0, windowMs - (Date.now() - started)));
	await cdp.send('Page.stopScreencast');
	if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
	const trace = await page.evaluate(() => {
		const m = (window as unknown as { __motion: { armed: boolean; raf: number[]; rt: RealtimeTrace } }).__motion;
		m.armed = false;
		const stall = (window as unknown as { __stall?: { at: 'mount' | 'after-trigger'; atMs: number } | null }).__stall;
		const { frames, labels, mounts, starts, t0 } = m.rt;
		return { trace: { raf: m.raf, frames, labels, mounts, starts, t0 }, stall: stall ?? null };
	});
	await cdp.detach().catch(() => {});
	const stall =
		stallMs && trace.stall ? { ms: stallMs, at: trace.stall.at, atMs: Math.round(trace.stall.atMs - t0) } : null;
	return {
		trace: trace.trace,
		stall,
		throttleRatio,
		frames: shots.map((f) => ({ ms: Math.round(f.at - epoch0), png: Buffer.from(f.data, 'base64') }))
	};
}

export interface RawFrame {
	ms: number;
	width: number;
	height: number;
	data: Buffer;
}

/**
 * A real-time run's frames as a GIF at their wall-clock pacing, under `maxBytes`: identical neighbours become one
 * longer frame, the palette is 64 colours, and if the file is still over, every other frame is dropped and it is
 * encoded once more. Still over after that throws `overCap`, the message `publish-media` prints.
 */
export function encodeRealtimeGif(frames: RawFrame[], file: string, maxBytes = MAX_FILE_BYTES) {
	const merged = frames.filter((f, i) => i === 0 || !f.data.equals(frames[i - 1].data));
	const encode = (list: RawFrame[]) => {
		const gif = GIFEncoder();
		list.forEach((f, i) => {
			const rgba = new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.length);
			const palette = quantize(rgba, 64);
			const delay = i + 1 < list.length ? Math.max(20, list[i + 1].ms - f.ms) : 800;
			gif.writeFrame(applyPalette(rgba, palette), f.width, f.height, { palette, delay });
		});
		gif.finish();
		return Buffer.from(gif.bytes());
	};
	let gif = encode(merged);
	let kept = merged;
	if (gif.length > maxBytes) {
		kept = merged.filter((_, i) => i % 2 === 0);
		gif = encode(kept);
	}
	if (gif.length > maxBytes) throw new Error(overCap(file, gif.length));
	return { gif, frames: kept.length, merged: frames.length - merged.length, halved: kept !== merged };
}

/** Up to `n` frames spread evenly over the run, plus the ones nearest the first few overlaps, in time order. */
export function pickStripFrames(ms: number[], overlapMs: number[], n: number): number[] {
	if (!ms.length) return [];
	const picked = new Set<number>();
	for (let i = 0; i < n; i++) picked.add(Math.round((i * (ms.length - 1)) / Math.max(1, n - 1)));
	for (const t of overlapMs.slice(0, 3)) {
		let best = 0;
		for (let i = 1; i < ms.length; i++) if (Math.abs(ms[i] - t) < Math.abs(ms[best] - t)) best = i;
		picked.add(best);
	}
	return [...picked].sort((a, b) => a - b);
}
