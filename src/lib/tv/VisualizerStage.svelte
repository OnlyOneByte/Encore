<script lang="ts">
	// The canvas and its loop only; the renderers are pure functions in `visualizers.ts`. This is the SECOND rAF loop
	// on the TV, so three costs are managed: the draw is capped at ~30fps because the lyric ball keeps the stronger
	// claim on the frame budget, the backing store is REDUCED and stretched by CSS, and `playing` going false CANCELS
	// the frame rather than merely hiding the canvas. See docs/FRONTEND.md#the-visualizer-stage.
	import { VISUALIZER_RENDERERS, type VizContext } from './visualizers';
	import { frameClock, frameDue, shouldAnimate } from './visualizer-loop';
	import type { TvVisualizerId } from '$lib/contract';

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
	/** ~30fps. */
	const FRAME_MS = 33;

	let canvas = $state<HTMLCanvasElement | null>(null);

	// The clock baseline, held OUTSIDE the effect ON PURPOSE: as a per-effect-run local, every re-run — a `playing`
	// toggle, a `variant`/`hue` change, a remount — resets it and pins `t` near zero, drawing one frame forever.
	let clockStart: number | null = null;

	/** Via matchMedia rather than a CSS query, because the thing to disable is a JS LOOP. */
	function prefersReducedMotion(): boolean {
		return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	$effect(() => {
		// Read every reactive input SYNCHRONOUSLY here so the effect TRACKS it: read only inside `render()`, which runs
		// from the rAF callback, an `$effect` subscribes to nothing and a hue change is dropped until a remount.
		const activeVariant = variant;
		const activeHue = hue;
		const isPlaying = playing;
		const el = canvas;
		if (!el) return;
		const ctx = el.getContext('2d');
		if (!ctx) return; // no 2d context (ancient browser) → the layer's black floor is what shows

		// A TV does not change size mid-song, but a dev window does.
		const size = () => {
			const r = el.getBoundingClientRect();
			el.width = Math.max(1, Math.round(r.width * SCALE));
			el.height = Math.max(1, Math.round(r.height * SCALE));
		};
		size();
		const onResize = () => size();
		window.addEventListener('resize', onResize);

		const render = (tSec: number) => {
			VISUALIZER_RENDERERS[activeVariant](ctx as unknown as VizContext, {
				t: tSec,
				hue: activeHue,
				w: el.width,
				h: el.height
			});
		};

		if (!shouldAnimate(isPlaying, prefersReducedMotion())) {
			// One frame, then nothing: a still plasma is a legitimate background, and a moving one behind lyrics is what a
			// reduced-motion preference is asking us not to do. Enforced by its own test, since the CSS-parsing motion
			// guard cannot see a canvas.
			render(0);
			return () => window.removeEventListener('resize', onResize);
		}

		let raf = 0;
		let last: number | null = null;
		const tick = (now: number) => {
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

<!-- aria-hidden: decoration behind the words, carrying nothing the song does not already convey. -->
<canvas bind:this={canvas} aria-hidden="true"></canvas>

<style>
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		/* The backing store is smaller than the box (SCALE); CSS stretches it back up. */
		display: block;
	}
</style>
