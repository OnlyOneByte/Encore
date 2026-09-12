// The four visualizer renderers, as PURE functions of time.
//
// Split out of the component deliberately, for two reasons:
//
// 1. A canvas inside a `.svelte` file is untestable in this suite — there is no DOM. As plain
//    functions taking a 2D context, they can be driven against a tiny fake context and asserted on
//    (see visualizers.test.ts), which is the only way the legibility bound below gets enforced.
// 2. The component then owns exactly one thing: the loop. Frame budget, visibility gating and
//    reduced-motion live there; nothing about *what is drawn* does.
//
// ── The bound every renderer draws inside ──
//
// This is the stage background: it sits behind the word-timed lyric reel, whose entire legibility
// strategy is one `text-shadow` tuned against black. So every colour here comes from `stageHueToHex`,
// which pins lightness to STAGE_BG_L and applies the accent2 guard. A renderer must NOT reach for a
// raw hsl()/rgb() value — that is how a visualizer would quietly become the brightest thing on screen.
//
// Ruled explicitly (see .kiro spec §8): a visualizer is bounded by the SAME cap as every static
// background, with no visualizer-specific constant and no dim-while-lyrics-show behaviour.
//
// ── What is deliberately absent ──
//
// No spectrum bars and no oscilloscope. Both assert they are drawing the audio signal, and nothing
// here reads it — these are functions of `t`. Faking them is the defect the lyrics overlay refuses by
// name ("a lie dressed as precision"). They arrive with real analysis or not at all.
import { stageHueToHex, type TvVisualizerId } from '$shared';

/**
 * The subset of CanvasRenderingContext2D these renderers use.
 *
 * Declared as a structural type rather than taking the DOM interface, so a test can pass a recording
 * stub. Keep it minimal — every method added here is one a fake has to implement.
 */
export interface VizContext {
	fillStyle: string | CanvasGradient | CanvasPattern;
	strokeStyle: string | CanvasGradient | CanvasPattern;
	lineWidth: number;
	globalAlpha: number;
	fillRect(x: number, y: number, w: number, h: number): void;
	beginPath(): void;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	arc(x: number, y: number, r: number, a0: number, a1: number): void;
	stroke(): void;
	fill(): void;
}

export interface VizFrame {
	/** Seconds since the loop started. The ONLY time source — renderers must be pure in `t`. */
	t: number;
	/** Room hue (0–359). Every colour is derived from this through `stageHueToHex`. */
	hue: number;
	/** Backing-store width in px (already reduced — see VisualizerStage). */
	w: number;
	/** Backing-store height in px. */
	h: number;
}

/** Hue offset helper: a second hue a fixed angle from the room's, still inside the stage bound. */
function shifted(hue: number, deg: number): string {
	return stageHueToHex(hue + deg);
}

/**
 * Wipe to the stage floor. Every renderer starts here rather than relying on the previous frame, so a
 * dropped frame or a resize cannot leave streaks — and so each renderer is a pure function of `t`
 * rather than of the accumulated history of every frame before it.
 */
function clear(ctx: VizContext, f: VizFrame): void {
	ctx.globalAlpha = 1;
	ctx.fillStyle = '#000';
	ctx.fillRect(0, 0, f.w, f.h);
}

/**
 * Plasma — the demoscene classic: summed sinusoids sampled on a coarse grid.
 *
 * Drawn as filled cells rather than per-pixel `ImageData`. Per-pixel is the textbook version and is
 * far too slow on a TV browser at 1080p; a coarse grid on an already-reduced backing store reads as a
 * soft field, which is what the effect looked like on the hardware it comes from anyway.
 */
export function drawPlasma(ctx: VizContext, f: VizFrame): void {
	clear(ctx, f);
	// 12 on the reduced backing store ≈ 24 effective px after the CSS upscale. At 24 here (48 effective)
	// the cells read as hard blocks — an artifact rather than the soft field this is meant to be. Verified
	// by eyes-on, not by arithmetic.
	const cell = 12;
	const cols = Math.ceil(f.w / cell);
	const rows = Math.ceil(f.h / cell);
	const warm = stageHueToHex(f.hue);
	const cool = shifted(f.hue, 55);
	for (let cy = 0; cy < rows; cy++) {
		for (let cx = 0; cx < cols; cx++) {
			const x = cx / Math.max(1, cols);
			const y = cy / Math.max(1, rows);
			// three interfering waves — the classic form, slow enough to read as drifting not flickering
			const v = Math.sin(x * 6 + f.t * 0.6) + Math.sin(y * 5 - f.t * 0.45) + Math.sin((x + y) * 4 + f.t * 0.3);
			const n = (v + 3) / 6; // → 0..1
			ctx.globalAlpha = 0.25 + n * 0.75;
			ctx.fillStyle = n > 0.5 ? warm : cool;
			ctx.fillRect(cx * cell, cy * cell, cell, cell);
		}
	}
	ctx.globalAlpha = 1;
}

/** Deterministic per-star pseudo-random in 0..1. No Math.random: a renderer must be pure in `t`. */
function starRand(i: number, salt: number): number {
	const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
	return v - Math.floor(v);
}

/**
 * Starfield — flying forward through stars, the one every old media player shipped.
 *
 * Each star's depth is `t` modulo its own cycle, so the field is a pure function of time with no
 * accumulated per-frame state. A star nearing the viewer grows and brightens; at the end of its cycle
 * it wraps to the far distance, which reads as continuous travel.
 */
export function drawStarfield(ctx: VizContext, f: VizFrame): void {
	clear(ctx, f);
	const cx = f.w / 2;
	const cy = f.h / 2;
	// 320, not 140: eyes-on at 140 on a 640x360 backing store showed a handful of stray dots rather than
	// a field. Brightness cannot be the lever here — the stage tier caps it — so density and size are.
	const count = 320;
	const near = stageHueToHex(f.hue);
	const far = shifted(f.hue, 40);
	for (let i = 0; i < count; i++) {
		const ang = starRand(i, 1) * Math.PI * 2;
		const speed = 0.35 + starRand(i, 2) * 0.5;
		const cycle = 6 / speed;
		const depth = ((f.t + starRand(i, 3) * cycle) % cycle) / cycle; // 0 far → 1 near
		const spread = starRand(i, 4) * 0.5 + 0.5;
		const r = depth * depth * Math.max(f.w, f.h) * 0.75 * spread;
		const x = cx + Math.cos(ang) * r;
		const y = cy + Math.sin(ang) * r;
		if (x < 0 || y < 0 || x > f.w || y > f.h) continue;
		ctx.globalAlpha = 0.25 + depth * 0.75;
		ctx.fillStyle = depth > 0.6 ? near : far;
		const size = 1.5 + depth * 4.5;
		ctx.fillRect(x - size / 2, y - size / 2, size, size);
	}
	ctx.globalAlpha = 1;
}

/**
 * Ripples — two ring systems at slightly different periods, so their interference walks slowly.
 * Stroked circles rather than a computed field, which is cheap and gives the hard-edged look the
 * period hardware had.
 */
export function drawMoire(ctx: VizContext, f: VizFrame): void {
	clear(ctx, f);
	const maxR = Math.hypot(f.w, f.h) / 2;
	const centres: Array<[number, number, number]> = [
		[f.w * 0.38, f.h * 0.45, 1],
		[f.w * 0.62, f.h * 0.55, -1]
	];
	ctx.lineWidth = 2;
	for (const [cx, cy, dir] of centres) {
		ctx.strokeStyle = dir > 0 ? stageHueToHex(f.hue) : shifted(f.hue, 50);
		const step = 26;
		const phase = (((f.t * 18 * dir) % step) + step) % step;
		for (let r = phase; r < maxR; r += step) {
			ctx.globalAlpha = 0.25 + 0.35 * (1 - r / maxR);
			ctx.beginPath();
			ctx.arc(cx, cy, r, 0, Math.PI * 2);
			ctx.stroke();
		}
	}
	ctx.globalAlpha = 1;
}

/**
 * Phase curves — a Lissajous figure whose frequency ratio drifts, so the curve continuously draws and
 * redraws itself. Closest thing here to what Winamp's AVS looked like.
 */
export function drawLissajous(ctx: VizContext, f: VizFrame): void {
	clear(ctx, f);
	const cx = f.w / 2;
	const cy = f.h / 2;
	const ax = f.w * 0.36;
	const ay = f.h * 0.36;
	// a slowly drifting ratio keeps the figure from ever settling into a static loop
	const ratio = 2 + Math.sin(f.t * 0.08) * 1.5;
	const phase = f.t * 0.5;
	ctx.lineWidth = 2;
	for (let layer = 0; layer < 3; layer++) {
		ctx.strokeStyle = layer === 0 ? stageHueToHex(f.hue) : shifted(f.hue, 30 * layer);
		ctx.globalAlpha = 0.7 - layer * 0.2;
		ctx.beginPath();
		const steps = 240;
		const lag = layer * 0.35;
		for (let i = 0; i <= steps; i++) {
			const u = (i / steps) * Math.PI * 2;
			const x = cx + Math.sin(u * 3 + phase - lag) * ax;
			const y = cy + Math.sin(u * ratio + phase * 0.7 - lag) * ay;
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();
	}
	ctx.globalAlpha = 1;
}

/**
 * The registry's id → renderer map.
 *
 * `Record<TvVisualizerId, …>` on purpose: adding an id to TV_VISUALIZERS without a renderer is a
 * compile error, the same discipline `stageBackgroundCss` uses for background styles.
 */
export const VISUALIZER_RENDERERS: Record<TvVisualizerId, (ctx: VizContext, f: VizFrame) => void> = {
	plasma: drawPlasma,
	starfield: drawStarfield,
	moire: drawMoire,
	lissajous: drawLissajous
};
