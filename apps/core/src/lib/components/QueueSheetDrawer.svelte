<script lang="ts">
	// SPIKE (#827) — QueueSheet ported onto vaul-svelte's drawer, kept BESIDE the incumbent so the four
	// do-not-regress numbers can be measured on both in one browser session. This is not a migration:
	// nothing imports it but the /components gallery, behind `?spike827=drawer`.
	//
	// The prop surface is deliberately IDENTICAL to QueueSheet.svelte, because a port that has to change
	// its callers is not the port the decision was costed against.
	//
	// What the port has to do differently, and why each one is a finding rather than a preference:
	//
	// 1. THE COLLAPSED PEEK IS AN OPEN DIALOG. The incumbent is one `position: fixed` <section> that is
	//    always mounted; "collapsed" is a transform. vaul's Content is a bits-ui Dialog.Content, which
	//    is UNMOUNTED at `open={false}` — so the peek, which must be on screen at all times, cannot be
	//    the closed state. The peek is therefore `open` PERMANENTLY TRUE at the first snap point, with
	//    `modal={false}` + `dismissible={false}` so the page behind stays interactive and Escape/backdrop
	//    do not tear the peek off screen.
	// 2. `--peek-h` STOPS BEING READ BY CSS. The incumbent's transform is
	//    `translateY(calc(100% - var(--peek-h, 132px) + var(--drag, 0px)))`, so the token IS the geometry.
	//    vaul computes the offset in JS (`use-snap-points.svelte.js:44-54`) and writes an inline
	//    `transform: translate3d(0, Npx, 0)`, which outranks any stylesheet rule. The measured height must
	//    be handed in as a px SNAP POINT instead. The documentElement write stays because everything else
	//    docked to the bottom (mic bar, toasts) still offsets from it.
	// 3. THE 82dvh CAP BECOMES A JS FRACTION. `0.82` is multiplied by `window.innerHeight` in the same
	//    derivation. The `max-height: 82dvh` below is kept so the cap is still expressed in CSS and the
	//    dvh-unit guard still has something to read — the probe measures whether it is the binding
	//    constraint or dead weight.
	import type { Snippet } from 'svelte';
	import { Drawer } from 'vaul-svelte';
	import { formatClock, formatRemaining, progressFraction } from '$lib/clock';

	interface Props {
		open: boolean;
		title: string;
		sub?: string;
		position?: string;
		queueCount?: number;
		elapsedSec?: number;
		durationSec?: number;
		children: Snippet;
		controls?: Snippet;
		ontoggle?: (open: boolean) => void;
	}
	let {
		open,
		title,
		sub,
		position,
		queueCount = 0,
		elapsedSec = 0,
		durationSec = 0,
		children,
		controls,
		ontoggle
	}: Props = $props();

	const progress = $derived(progressFraction(elapsedSec, durationSec));

	/*
	 * SPIKE instrumentation. vaul's drag pipeline is entirely internal — `onDrag` / `onRelease` are the
	 * only observable points — and "the port ignored a 200px drag" is a claim that must distinguish "the
	 * library never saw the gesture" from "it saw it and declined to move". The probe reads this off
	 * `window`. It found a real property of the port that way: `shouldDrag` refuses any gesture starting
	 * within 500ms of the drawer's own openTime, and a drag dispatched too early reports events with zero
	 * movement, which is indistinguishable from broken snap points without this counter.
	 */
	interface DragTrace {
		drags: number;
		lastPct: number | null;
		releases: number;
		snaps: boolean[];
	}
	function trace(): DragTrace {
		const w = window as Window & { __spike827?: DragTrace };
		w.__spike827 ??= { drags: 0, lastPct: null, releases: 0, snaps: [] };
		return w.__spike827;
	}

	// Same measured peek as the incumbent, same documentElement contract, same teardown (#460 §14).
	let peekH = $state(0);
	$effect(() => {
		if (peekH > 0) document.documentElement.style.setProperty('--peek-h', `${peekH}px`);
		return () => {
			if (peekH > 0) document.documentElement.style.removeProperty('--peek-h');
		};
	});

	// The peek snap point. A px STRING, not a fraction: the peek is content-measured, so a fraction of
	// the viewport is the wrong unit — 132px is 15.6% of a 844px phone and 27.5% of a 480px one.
	// `132` is the app.css fallback, used until the first measurement lands.
	const PEEK_FALLBACK = 132;
	const EXPANDED_SNAP = 0.82;
	const peekSnap = $derived(`${peekH > 0 ? peekH : PEEK_FALLBACK}px`);
	const snapPoints = $derived([peekSnap, EXPANDED_SNAP]);
	const activeSnapPoint = $derived(open ? EXPANDED_SNAP : peekSnap);
</script>

<Drawer.Root
	open={true}
	modal={false}
	dismissible={false}
	snapPoints={snapPoints}
	activeSnapPoint={activeSnapPoint}
	onActiveSnapPointChange={(p) => ontoggle?.(p === EXPANDED_SNAP)}
	onDrag={(_e, pct) => {
		const s = trace();
		s.drags++;
		s.lastPct = pct;
	}}
	onRelease={(_e, isOpen) => {
		const s = trace();
		s.releases++;
		s.snaps.push(isOpen);
	}}
	snapToSequentialPoint={true}
	setBackgroundColorOnScale={false}
>
	<Drawer.Portal>
		<Drawer.Content class="sheet-surface sheet spike-drawer" aria-label="Queue">
			<div
				class="peek"
				bind:clientHeight={peekH}
				role="button"
				tabindex="0"
				aria-expanded={open}
				aria-label={open
					? 'Collapse the queue'
					: `Show the queue, ${queueCount} ${queueCount === 1 ? 'song' : 'songs'}`}
				onclick={(e) => {
					if ((e.target as HTMLElement).closest('button.no-drag')) return;
					ontoggle?.(!open);
				}}
				onkeydown={(e) => {
					if (e.target !== e.currentTarget) return;
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						ontoggle?.(!open);
					}
					if (e.key === 'ArrowUp') {
						e.preventDefault();
						ontoggle?.(true);
					}
					if (e.key === 'ArrowDown') {
						e.preventDefault();
						ontoggle?.(false);
					}
				}}
			>
				<Drawer.Handle class="grip" />
				<div class="line">
					<div class="txt">
						<div class="t">{title}</div>
						{#if sub}<div class="s">{sub}</div>{/if}
						{#if position}<div class="pos">{position}</div>{/if}
					</div>
					{#if controls}<div class="ctrls">{@render controls()}</div>{/if}
				</div>

				{#if progress !== null}
					<div class="seekrow" aria-hidden="true">
						<span class="time">{formatClock(elapsedSec)}</span>
						<span class="track"><i style="transform:scaleX({progress})"></i></span>
						<span class="time r">{formatRemaining(elapsedSec, durationSec)}</span>
					</div>
				{/if}
				<div class="hint">
					{#if !open && queueCount > 0}{queueCount} waiting{/if}
				</div>
			</div>

			<div class="body" inert={!open}>
				{@render children()}
			</div>
		</Drawer.Content>
	</Drawer.Portal>
</Drawer.Root>

<style>
	/* Copied VERBATIM from QueueSheet.svelte's own <style> so the two variants differ only in the
	   drawer machinery. Kept in `src/` on purpose: the spike's job includes checking whether the
	   design guards can still read the numbers, and they can only read what lives here.
	   
	   FINDING (risk 5, third direction). The two rules that style the drawer's OWN elements —
	   `.spike-drawer` on Drawer.Content and `.grip` on Drawer.Handle — must be `:global`. A `class=`
	   string handed to a COMPONENT is a prop, not an element attribute, so Svelte never stamps its
	   scope hash on it and a scoped rule silently matches nothing. This is not a shadcn/Tailwind
	   consequence; it is true of any library whose root element you do not author. Every guard that
	   resolves a class name to its `.name { … }` rule (contrast.test.ts:127, touch-targets.test.ts,
	   design-system.test.ts:465) reads scoped rules; `:global` blocks still parse, so these two
	   survive — but the same edit under shadcn's copy-in replaces them with `class="max-h-[82dvh]"`,
	   which has no rule to find. */
	:global(.spike-drawer) {
		z-index: var(--z-sheet);
		background: var(--card2);
		max-height: 82dvh;
		/* FINDING (risk 1, the shape the snap points cost). vaul supplies NO positioning — it only ever
		   writes `transform` — and its snap-point offset is `containerHeight - snapHeight`
		   (`use-snap-points.svelte.js:51`), which reveals the element's own TOP `snapHeight` pixels only
		   if the element is TOP-anchored and viewport-tall. `.sheet-surface` in app.css is the opposite:
		   `bottom: 0` with a content height. Composed as-is the port MEASURED 0px of peek on screen — the
		   sheet was translated 680px below a viewport it was already sitting at the bottom of. So the port
		   must override two of `.sheet-surface`'s own declarations, which is a real cost: the shared sheet
		   surface stops being shared, and the next sheet added to it inherits an anchoring the drawer
		   variant does not use. `max-height` above still binds (692.08px at 844dvh), so the dvh cap is
		   not merely decorative here — it is what makes snap 0.82 and the CSS cap agree exactly. */
		top: 0;
		bottom: auto;
		height: 100%;
	}
	:global(.spike-drawer .grip) {
		width: 40px;
		height: 4px;
		border-radius: 3px;
		background: var(--line-strong);
		margin: var(--space-3xs) auto var(--space-md);
	}
	.peek {
		padding: var(--space-sm) var(--space-xl) calc(var(--space-md) + env(safe-area-inset-bottom, 0px));
		cursor: grab;
		touch-action: none;
		flex: 0 0 auto;
	}
	.peek:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
		border-radius: var(--radius);
	}
	.seekrow {
		display: flex;
		align-items: center;
		gap: 9px;
		margin: var(--space-md) 0 var(--space-3xs);
	}
	.time {
		font-size: var(--ph-text-2xs);
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
		min-width: 30px;
	}
	.time.r {
		text-align: right;
	}
	.track {
		flex: 1;
		height: 4px;
		background: var(--line);
		border-radius: var(--radius-xs);
		overflow: hidden;
	}
	.track > i {
		display: block;
		height: 100%;
		width: 100%;
		background: var(--grad);
		border-radius: var(--radius-xs);
		transform-origin: left center;
		transition: transform var(--motion-tick) linear;
	}
	@media (prefers-reduced-motion: reduce) {
		.track > i {
			transition: none;
		}
	}
	.line {
		display: flex;
		align-items: center;
		gap: var(--space-lg);
	}
	.txt {
		min-width: 0;
		flex: 1;
	}
	.t {
		font-weight: 700;
		font-size: 0.95rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.s {
		font-size: 0.78rem;
		color: var(--ink-dim);
	}
	.pos {
		font-size: var(--ph-text-sm);
		font-weight: 700;
		color: var(--accent2);
		margin-top: 3px;
	}
	.ctrls {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		flex: 0 0 auto;
	}
	.hint {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-xs);
		font-size: var(--ph-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-dim);
		margin-top: 9px;
	}
	.body {
		overflow-y: auto;
		padding: var(--space-2xs) var(--space-xl) calc(var(--space-4xl) + env(safe-area-inset-bottom, 0px));
		-webkit-overflow-scrolling: touch;
	}
</style>
