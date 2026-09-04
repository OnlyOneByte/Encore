<script lang="ts">
	/*
	 * The visualizer's canvas and its animation loop — and nothing about what is drawn. The renderers
	 * are pure functions in `visualizers.ts`; this component owns only the loop, the frame budget and
	 * the two ways it stops.
	 *
	 * Three costs are deliberately managed here, because a full-screen animation on a smart-TV browser
	 * is exactly where this class of feature falls over:
	 *
	 * 1. THIS IS THE SECOND rAF LOOP ON THE TV. LyricsOverlay already runs one during playback,
	 *    interpolating position telemetry to 60fps. So this one is capped at ~30fps: a drifting plasma
	 *    does not read as smoother at 60, and the lyric ball — which a singer is actually following —
	 *    has the stronger claim on the frame budget.
	 * 2. The backing store is REDUCED (see SCALE) and stretched by CSS. Softness is period-correct for
	 *    the effects being drawn, and it cuts fill cost roughly fourfold.
	 * 3. The loop does not run when the layer is not shown. An idle TV on the attract screen should cost
	 *    nothing, so `playing` going false cancels the frame rather than merely hiding the canvas.
	 *
	 * `prefers-reduced-motion: reduce` renders ONE frame and stops. That matches the convention already
	 * established across this codebase (LyricsOverlay, JoinBadge, TvProgress, app.css) — and it is
	 * enforced here by an explicit test, because the existing motion test parses CSS and therefore
	 * cannot see a canvas.
	 */
	import { VISUALIZER_RENDERERS, type VizContext } from './visualizers';
	import { frameClock, frameDue, shouldAnimate } from './visualizer-loop';
	import type { TvVisualizerId } from '@encore/shared';

	interface Props {
		/** Which renderer to run. */
		variant: TvVisualizerId;
		/** Room hue — every colour derives from it, inside the stage legibility bound. */
		hue: number;
		/** False stops the loop entirely rather than just hiding the canvas. */
		playing?: boolean;
	}
	let { variant, hue, playing = true }: Props = $props();

	/** Backing-store scale. 0.5 = quarter the pixels to fill. */
	const SCALE = 0.5;
	/** ~30fps. See note 1 above. */
	const FRAME_MS = 33;

	let canvas = $state<HTMLCanvasElement | null>(null);

	/**
	 * The animation clock baseline (the timestamp treated as t=0), held OUTSIDE the effect on purpose.
	 *
	 * This is the fix for the "static picture" bug. It used to be a per-effect-run local (`let start =
	 * 0`), so every effect re-run — a `playing` toggle, a `variant`/`hue` change now that those are
	 * tracked, or the visualizer block remounting — reset it and pinned `t` near zero, drawing the same
	 * `t ~ 0` frame forever. Living at component scope, it survives re-runs, so `t` keeps accumulating
	 * and the picture actually moves. `null` until the first frame establishes it.
	 */
	let clockStart: number | null = null;

	/**
	 * Whether the viewer asked for less motion. Read once via matchMedia rather than a CSS query,
	 * because the thing to disable is a JS loop, not a CSS animation.
	 */
	function prefersReducedMotion(): boolean {
		return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	$effect(() => {
		// Read every reactive input SYNCHRONOUSLY here so the effect TRACKS it. This is the other half of
		// the bug: `variant` and `hue` were previously read only inside `render()`, which runs from the
		// rAF callback — asynchronously, outside the effect's synchronous pass — so an `$effect`
		// subscribed to neither, and changing the room's visualizer or hue was silently dropped until a
		// full remount. Naming them here re-runs the effect on any change, rebuilding the loop with the
		// new values (and `clockStart` survives that re-run, so motion is uninterrupted).
		const activeVariant = variant;
		const activeHue = hue;
		const isPlaying = playing;
		const el = canvas;
		if (!el) return;
		const ctx = el.getContext('2d');
		if (!ctx) return; // no 2d context (ancient browser) → the layer's black floor is what shows

		// Size the backing store to the element's real box, at the reduced scale. Read once per mount and
		// on resize; a TV does not change size mid-song, but a dev window does.
		const size = () => {
			const r = el.getBoundingClientRect();
			el.width = Math.max(1, Math.round(r.width * SCALE));
			el.height = Math.max(1, Math.round(r.height * SCALE));
		};
		size();
		const onResize = () => size();
		window.addEventListener('resize', onResize);

		const render = (tSec: number) => {
			// The registry is keyed by the id union, so this lookup cannot miss.
			VISUALIZER_RENDERERS[activeVariant](ctx as unknown as VizContext, {
				t: tSec,
				hue: activeHue,
				w: el.width,
				h: el.height
			});
		};

		if (!shouldAnimate(isPlaying, prefersReducedMotion())) {
			// One frame, then nothing. A still plasma is a legitimate background; a moving one behind
			// lyrics is what a reduced-motion preference is asking us not to do, and an idle attract
			// screen must cost nothing.
			render(0);
			return () => window.removeEventListener('resize', onResize);
		}

		let raf = 0;
		let last: number | null = null;
		const tick = (now: number) => {
			// `clockStart` is component-scoped, so its baseline carries across effect re-runs and `t`
			// keeps climbing instead of resetting.
			const clock = frameClock(now, clockStart);
			clockStart = clock.start;
			if (frameDue(now, last, FRAME_MS)) {
				last = now;
				render(clock.tSec);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);

		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', onResize);
		};
	});
</script>

<!--
	aria-hidden: this is decoration behind the words. A screen reader announcing "canvas" on the karaoke
	stage would be noise, and there is no information here that is not also conveyed by the song itself.
-->
<canvas bind:this={canvas} aria-hidden="true"></canvas>

<style>
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		/* the backing store is smaller than the box (SCALE); CSS stretches it back up */
		display: block;
	}
</style>
