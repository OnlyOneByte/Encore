// The four visualizer renderers, as PURE functions of `t`, taking a structural 2D context so they can be
// driven against a fake and asserted on. The component owns only the loop.
//
// THE BRIGHTNESS BOUND. This is the stage background, sitting behind the word-timed lyric reel. Every colour
// MUST come from `stageHueToHex` (lightness pinned to STAGE_BG_L, accent2 guard applied); a raw hsl()/rgb()
// value is how a visualizer becomes the brightest thing on screen. Bounded by the same cap as a static
// background — no visualizer-specific constant, no dim-while-lyrics-show.
//
// Deliberately absent: spectrum bars and oscilloscopes. Both claim to draw the audio signal and nothing here
// reads it. They arrive with real analysis or not at all.
import { stageHueToHex, type TvVisualizerId } from '$lib/contract';

/**
 * The subset of CanvasRenderingContext2D these renderers use. Structural rather than the DOM interface
 * so a test can pass a recording stub. Keep it minimal — every method added is one a fake must provide.
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
 * Wipe to the stage floor. Every renderer starts here, so a dropped frame or a resize cannot streak and
 * no renderer depends on the accumulated history of the frames before it.
 */
function clear(ctx: VizContext, f: VizFrame): void {
	ctx.globalAlpha = 1;
	ctx.fillStyle = '#000';
	ctx.fillRect(0, 0, f.w, f.h);
}

/**
 * Plasma — summed sinusoids on a coarse grid. Filled cells rather than per-pixel `ImageData`, which is
 * far too slow on a TV browser at 1080p and reads the same on a reduced backing store.
 */
export function drawPlasma(ctx: VizContext, f: VizFrame): void {
	clear(ctx, f);
	// ~24 effective px after the CSS upscale. Doubling this reads as hard blocks, not a soft field.
	const cell = 12;
	const cols = Math.ceil(f.w / cell);
	const rows = Math.ceil(f.h / cell);
	const warm = stageHueToHex(f.hue);
	const cool = shifted(f.hue, 55);
	for (let cy = 0; cy < rows; cy++) {
		for (let cx = 0; cx < cols; cx++) {
			const x = cx / Math.max(1, cols);
			const y = cy / Math.max(1, rows);
			// Slow enough to read as drifting rather than flickering.
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
 * Starfield. Each star's depth is `t` modulo its own cycle, so the field needs no accumulated per-frame
 * state and a star wrapping to the far distance reads as continuous travel.
 */
export function drawStarfield(ctx: VizContext, f: VizFrame): void {
	clear(ctx, f);
	const cx = f.w / 2;
	const cy = f.h / 2;
	// Density and size are the only levers for reading as a FIELD rather than stray dots, because the
	// stage tier caps brightness. Below ~200 on a 640x360 backing store it stops reading as a field.
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
 * Ripples — two ring systems at slightly different periods, so the interference walks. Stroked circles
 * rather than a computed field: cheap, and hard-edged.
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
 * Phase curves — a Lissajous figure whose frequency ratio drifts, so the curve never settles.
 */
export function drawLissajous(ctx: VizContext, f: VizFrame): void {
	clear(ctx, f);
	const cx = f.w / 2;
	const cy = f.h / 2;
	const ax = f.w * 0.36;
	const ay = f.h * 0.36;
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
 * The registry's id -> renderer map. `Record<TvVisualizerId, …>` on purpose: adding an id to
 * TV_VISUALIZERS without a renderer is a compile error.
 */
export const VISUALIZER_RENDERERS: Record<TvVisualizerId, (ctx: VizContext, f: VizFrame) => void> = {
	plasma: drawPlasma,
	starfield: drawStarfield,
	moire: drawMoire,
	lissajous: drawLissajous
};
