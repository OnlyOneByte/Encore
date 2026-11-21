// The real-time pass's numbers and its GIF budget (world/motion.ts), from hand-built traces: what `ui:review`
// prints for a timing row has to mean what docs/UI-CHECKLIST.md says it means.
import { describe, expect, test } from 'bun:test';
import {
	analyseRealtime,
	encodeRealtimeGif,
	pickStripFrames,
	MAX_FILE_BYTES,
	type RawFrame,
	type RealtimeTrace
} from '../../playwright/world/motion';

/** [id, l, t, r, b, opacity]: a 40 px disc at `top` in the lane. */
const disc = (id: number, top: number, op = 1) => [id, 100, top, 140, top + 40, op];
const trace = (frames: RealtimeTrace['frames'], extra: Partial<RealtimeTrace> = {}): RealtimeTrace => ({
	raf: frames.map((f) => f.t),
	frames,
	labels: { 1: '#1', 2: '#2', 9: 'div.corner' },
	mounts: {},
	starts: {},
	t0: 0,
	...extra
});
const run = { label: 'realtime-late 400', throttle: 1, stall: null, windowMs: 1000, screencastFrames: 5 };
const analyse = (tr: RealtimeTrace) => analyseRealtime(tr, run);

describe('analyseRealtime', () => {
	test('two visible discs 10 px apart: no overlap, a 10 px gap', () => {
		const r = analyse(trace([{ t: 16, e: [disc(1, 100), disc(2, 150)], a: [] }]));
		expect(r.overlap.frames).toBe(0);
		expect(r.minGapPx).toBe(10);
	});

	test('two visible discs 5 px into each other: one overlapping frame, a -5 px gap, named', () => {
		const r = analyse(trace([{ t: 116, e: [disc(1, 100), disc(2, 135)], a: [] }], { t0: 100 }));
		expect(r.overlap).toEqual({
			frames: 1,
			eachFrames: 1,
			avoidFrames: 0,
			worstPx: 5,
			first: [{ ms: 16, a: '#1', b: '#2' }]
		});
		expect(r.minGapPx).toBe(-5);
	});

	test('an overlap with one of the pair invisible is counted apart, and sets no gap', () => {
		const r = analyse(trace([{ t: 16, e: [disc(1, 100), disc(2, 135, 0.02)], a: [] }]));
		expect(r.overlap.frames).toBe(0);
		expect(r.hiddenOverlap).toBe(1);
		expect(r.minGapPx).toBeNull();
	});

	test('a disc into an avoid box is an overlap; the avoid box is not a neighbour for the gap', () => {
		const r = analyse(trace([{ t: 16, e: [disc(1, 100)], a: [[9, 0, 130, 200, 300, 1]] }]));
		expect([r.overlap.frames, r.overlap.eachFrames, r.overlap.avoidFrames]).toEqual([1, 0, 1]);
		expect(r.overlap.first[0]).toEqual({ ms: 16, a: '#1', b: 'div.corner' });
		expect(r.minGapPx).toBeNull();
	});

	test('a frame with no visible disc between two that have one is a blank; the tail is not', () => {
		const r = analyse(
			trace([
				{ t: 16, e: [disc(1, 100)], a: [] },
				{ t: 32, e: [disc(1, 90, 0)], a: [] },
				{ t: 48, e: [disc(1, 80)], a: [] },
				{ t: 64, e: [], a: [] }
			])
		);
		expect(r.blankFrames).toBe(1);
	});

	test('dropped frames: rAF intervals over 1.5x the median', () => {
		const frames = [0, 16, 32, 48, 100, 116].map((t) => ({ t, e: [disc(1, 100)], a: [] }));
		const r = analyse(trace(frames));
		expect([r.droppedFrames, r.rafIntervals]).toEqual([1, 5]);
	});

	test('first frame: mount to first start per disc, the worst of those that started', () => {
		const r = analyse(trace([{ t: 16, e: [disc(1, 100)], a: [] }], { mounts: { 1: 100, 2: 200 }, starts: { 1: 520 } }));
		expect(r.firstFrameMs).toEqual({
			worst: 420,
			each: [
				{ id: '#1', ms: 420 },
				{ id: '#2', ms: null }
			]
		});
	});

	test('travel: how far each disc moved over the run', () => {
		const r = analyse(
			trace([
				{ t: 16, e: [disc(1, 500)], a: [] },
				{ t: 32, e: [disc(1, 300)], a: [] }
			])
		);
		expect(r.travelPx).toEqual({ max: 200, each: [{ id: '#1', px: 200 }] });
	});

	test('the line says it in one row', () => {
		const r = analyse(trace([{ t: 116, e: [disc(1, 100), disc(2, 135)], a: [] }], { t0: 100 }));
		expect(r.line).toBe(
			'realtime-late 400  overlap 1 frames (worst 5 px) · min gap -5 px · blank 0 · dropped 0/0 · first frame —'
		);
	});
});

const frame = (ms: number, seed: number, size = 24): RawFrame => {
	const data = Buffer.alloc(size * size * 4);
	for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : (i * 7919 + seed * 104729) % 251;
	return { ms, width: size, height: size, data };
};

describe('encodeRealtimeGif', () => {
	test('identical neighbours become one frame', () => {
		const a = frame(0, 1);
		const out = encodeRealtimeGif([a, { ...a, ms: 40 }, { ...a, ms: 80 }, frame(120, 2)], 'x.gif');
		expect([out.frames, out.merged, out.halved]).toEqual([2, 2, false]);
	});

	test('over the cap: every other frame goes, once', () => {
		const frames = Array.from({ length: 10 }, (_, i) => frame(i * 40, i));
		const full = encodeRealtimeGif(frames, 'x.gif', Infinity);
		const out = encodeRealtimeGif(frames, 'x.gif', full.gif.length - 1);
		expect([out.frames, out.halved]).toEqual([5, true]);
		expect(out.gif.length).toBeLessThan(full.gif.length);
	});

	test('still over after halving: refused with publish-media’s message', () => {
		const frames = Array.from({ length: 4 }, (_, i) => frame(i * 40, i));
		expect(() => encodeRealtimeGif(frames, 'row/realtime.gif', 10)).toThrow(
			/^row\/realtime\.gif is \d+ bytes, over the 1572864-byte \(1\.5 MB\) cap: lower the row's scale or crop it$/
		);
		expect(MAX_FILE_BYTES).toBe(1572864);
	});
});

describe('pickStripFrames', () => {
	const ms = Array.from({ length: 100 }, (_, i) => i * 10);
	test('evenly spread, first and last included', () => {
		expect(pickStripFrames(ms, [], 4)).toEqual([0, 33, 66, 99]);
	});
	test('the frames nearest the first overlaps are added', () => {
		expect(pickStripFrames(ms, [504], 4)).toEqual([0, 33, 50, 66, 99]);
	});
});
