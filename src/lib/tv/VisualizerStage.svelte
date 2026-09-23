<script lang="ts">
	/*
	 * The visualizer's canvas and its animation loop — nothing about WHAT is drawn; the renderers are pure
	 * functions in `visualizers.ts`. Three costs are managed here, because a full-screen animation on a
	 * smart-TV browser is where this class of feature falls over: it is the SECOND rAF loop on the TV, so it
	 * is capped at ~30fps and the lyric ball keeps the stronger claim on the frame budget; the backing store
	 * is REDUCED and stretched by CSS, which is period-correct and cuts fill cost roughly fourfold; and
	 * `playing` going false CANCELS the frame rather than merely hiding the canvas.
	 *
	 * `prefers-reduced-motion: reduce` renders ONE frame and stops, enforced by its own test because the
	 * CSS-parsing motion guard cannot see a canvas.
	 */
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
	/** ~30fps. See note 1 above. */
	const FRAME_MS = 33;

	let canvas = $state<HTMLCanvasElement | null>(null);

	/**
	 * The animation clock baseline, held OUTSIDE the effect ON PURPOSE. As a per-effect-run local, every
	 * re-run — a `playing` toggle, a `variant`/`hue` change, the block remounting — resets it and pins `t`
	 * near zero, drawing the same frame forever. At component scope `t` keeps accumulating.
	 */
	let clockStart: number | null = null;

	/** Read via matchMedia rather than a CSS query, because the thing to disable is a JS LOOP. */
	function prefersReducedMotion(): boolean {
		return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	$effect(() => {
		// Read every reactive input SYNCHRONOUSLY here so the effect TRACKS it. Read only inside `render()`,
		// which runs from the rAF callback and so outside the effect's synchronous pass, an `$effect`
		// subscribes to NEITHER and a room's visualizer or hue change is dropped until a remount.
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
			// The registry is keyed by the id union, so this lookup cannot miss.
			VISUALIZER_RENDERERS[activeVariant](ctx as unknown as VizContext, {
				t: tSec,
				hue: activeHue,
				w: el.width,
				h: el.height
			});
		};

		if (!shouldAnimate(isPlaying, prefersReducedMotion())) {
			// One frame, then nothing. A still plasma is a legitimate background; a moving one behind lyrics is
			// what a reduced-motion preference is asking us not to do.
			render(0);
			return () => window.removeEventListener('resize', onResize);
		}

		let raf = 0;
		let last: number | null = null;
		const tick = (now: number) => {
			// Component-scoped, so the baseline carries across effect re-runs and `t` keeps climbing.
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
	aria-hidden: decoration behind the words. A screen reader announcing "canvas" on the karaoke stage is
	noise, and there is no information here the song does not already convey.
-->
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
