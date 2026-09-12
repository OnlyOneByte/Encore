// The four visualizer renderers, driven against a recording fake context.
//
// This is the whole reason they are pure functions rather than code inside the component: a canvas has
// no DOM in this suite, so without this split the renderers would be entirely untested and the
// legibility bound below would be enforced by nothing but good intentions.
import { test, expect } from 'bun:test';
import {
	VISUALIZER_RENDERERS,
	drawPlasma,
	drawStarfield,
	drawMoire,
	drawLissajous,
	type VizContext,
	type VizFrame
} from '$lib/tv/visualizers';
import { TV_VISUALIZERS, stageHueToHex, SINGER_HUES, contrastRatio, parseHex } from '$shared';

/**
 * Records every colour, draw call, alpha AND coordinate, so a pure renderer can be asserted on.
 *
 * Recording coordinates is load-bearing, not thoroughness: the first version of this fake discarded
 * them, and the "advancing time changes the picture" test then passed a renderer that only MOVED its
 * geometry — same colours, same call sequence, same alphas — as static.
 */
function fake() {
	const colors: string[] = [];
	const calls: string[] = [];
	const alphas: number[] = [];
	const geom: number[] = [];
	const ctx = {
		_fill: '',
		_stroke: '',
		lineWidth: 1,
		globalAlpha: 1,
		get fillStyle() {
			return this._fill;
		},
		set fillStyle(v: string) {
			this._fill = v;
			colors.push(v);
		},
		get strokeStyle() {
			return this._stroke;
		},
		set strokeStyle(v: string) {
			this._stroke = v;
			colors.push(v);
		},
		fillRect(x: number, y: number, w: number, h: number) {
			calls.push('fillRect');
			alphas.push(this.globalAlpha);
			geom.push(x, y, w, h);
		},
		beginPath() {
			calls.push('beginPath');
		},
		moveTo(x: number, y: number) {
			calls.push('moveTo');
			geom.push(x, y);
		},
		lineTo(x: number, y: number) {
			calls.push('lineTo');
			geom.push(x, y);
		},
		arc(x: number, y: number, r: number) {
			calls.push('arc');
			geom.push(x, y, r);
		},
		stroke() {
			calls.push('stroke');
			alphas.push(this.globalAlpha);
		},
		fill() {
			calls.push('fill');
			alphas.push(this.globalAlpha);
		}
	};
	return { ctx: ctx as unknown as VizContext, colors, calls, alphas, geom };
}

const frame = (over: Partial<VizFrame> = {}): VizFrame => ({ t: 1.5, hue: 240, w: 640, h: 360, ...over });
const ALL = [drawPlasma, drawStarfield, drawMoire, drawLissajous];

test('every registry id has a renderer, and every renderer is in the registry', () => {
	// The Record is keyed by TvVisualizerId so a missing renderer is a compile error, but the reverse —
	// a renderer nothing can select — is not, and that is a dead-code shape worth catching.
	const ids = TV_VISUALIZERS.map((v) => v.id).sort();
	expect(Object.keys(VISUALIZER_RENDERERS).sort()).toEqual(ids);
	expect(Object.values(VISUALIZER_RENDERERS).every((fn) => typeof fn === 'function')).toBe(true);
});

test('every entry carries a label and a note — the picker renders from them', () => {
	for (const v of TV_VISUALIZERS) {
		expect(v.label.length).toBeGreaterThan(0);
		expect(v.note.length).toBeGreaterThan(0);
	}
});

test('the registry offers NO display that claims to show the audio signal', () => {
	// The rule, not a style nit: nothing on the TV reads the audio, so a bars/scope display would be
	// asserting an input it does not have — the defect the lyrics overlay refuses by name. If real
	// analysis ever lands, this test is the thing to delete, deliberately, in that commit.
	const forbidden = ['bars', 'spectrum', 'scope', 'oscilloscope', 'waveform', 'eq', 'equalizer'];
	for (const v of TV_VISUALIZERS) {
		expect(forbidden, `"${v.id}" claims to draw the signal`).not.toContain(v.id);
	}
});

test('every renderer draws something', () => {
	for (const draw of ALL) {
		const f = fake();
		draw(f.ctx, frame());
		expect(f.calls.length).toBeGreaterThan(1);
	}
});

test('every renderer clears to the stage floor first, so a dropped frame cannot streak', () => {
	// Each is a pure function of t. If one relied on the previous frame's pixels, a skipped frame or a
	// resize would leave debris that never clears on a screen that runs for hours.
	for (const draw of ALL) {
		const f = fake();
		draw(f.ctx, frame());
		expect(f.colors[0]).toBe('#000');
		expect(f.calls[0]).toBe('fillRect');
	}
});

test('every colour a renderer emits is a stage-tier colour — never a raw bright value', () => {
	// The bound that keeps the lyric reel readable. A renderer reaching for hsl()/rgb() directly is how a
	// visualizer would quietly become the brightest thing on the screen.
	const legal = new Set<string>(['#000']);
	for (const h of SINGER_HUES) {
		// renderers offset the room hue; allow every stage colour reachable from any hue
		for (let d = 0; d < 360; d += 5) legal.add(stageHueToHex(h + d));
	}
	for (const draw of ALL) {
		const f = fake();
		draw(f.ctx, frame());
		for (const c of f.colors) {
			expect(legal.has(c), `${draw.name} emitted a non-stage colour: ${c}`).toBe(true);
		}
	}
});

test('white lyrics stay readable against every colour a renderer can emit', () => {
	// The consequence the bound exists for, asserted directly rather than trusted. 4.5:1 is the text bar;
	// `.word.done` is #fff and is the brightest thing in the reel.
	for (const draw of ALL) {
		for (const hue of [0, 75, 165, 240, 345]) {
			const f = fake();
			draw(f.ctx, frame({ hue }));
			for (const c of f.colors) {
				if (!parseHex(c)) continue;
				expect(contrastRatio('#ffffff', c), `${draw.name} @hue ${hue} vs ${c}`).toBeGreaterThanOrEqual(4.5);
			}
		}
	}
});

test('renderers are pure in t — the same frame twice draws identically', () => {
	// No Math.random anywhere: a frame must be reproducible, or the reduced-motion single frame and the
	// eyes-on screenshots would both be non-deterministic.
	for (const draw of ALL) {
		const a = fake();
		const b = fake();
		draw(a.ctx, frame({ t: 4.25 }));
		draw(b.ctx, frame({ t: 4.25 }));
		expect(a.colors).toEqual(b.colors);
		expect(a.calls).toEqual(b.calls);
		expect(a.geom).toEqual(b.geom);
	}
});

test('advancing time actually changes the picture', () => {
	// The counterpart to purity: a "visualizer" that renders the same thing at every t is a static
	// gradient with extra CPU cost.
	for (const draw of ALL) {
		const a = fake();
		const b = fake();
		draw(a.ctx, frame({ t: 0 }));
		draw(b.ctx, frame({ t: 3.7 }));
		const changed =
			JSON.stringify(a.colors) !== JSON.stringify(b.colors) ||
			JSON.stringify(a.calls) !== JSON.stringify(b.calls) ||
			JSON.stringify(a.alphas) !== JSON.stringify(b.alphas) ||
			JSON.stringify(a.geom) !== JSON.stringify(b.geom);
		expect(changed, `${draw.name} is static`).toBe(true);
	}
});

test('a degenerate canvas size does not throw or divide by zero', () => {
	// A 0x0 backing store happens on first mount before layout settles.
	for (const draw of ALL) {
		for (const size of [
			{ w: 0, h: 0 },
			{ w: 1, h: 1 },
			{ w: 3840, h: 2160 }
		]) {
			const f = fake();
			expect(() => draw(f.ctx, frame(size))).not.toThrow();
			for (const c of f.colors) expect(typeof c).toBe('string');
		}
	}
});

test('an out-of-range hue is handled, not propagated as NaN', () => {
	for (const draw of ALL) {
		for (const hue of [-90, 0, 359, 400, 1080]) {
			const f = fake();
			expect(() => draw(f.ctx, frame({ hue }))).not.toThrow();
			for (const c of f.colors) expect(c).toMatch(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/);
		}
	}
});
