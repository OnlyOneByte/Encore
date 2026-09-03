<script lang="ts">
	// The docked now-playing bar, pullable into the full rotation.
	//
	// Why a sheet: the rotation list used to compete with search for the same vertical scroll, and at
	// a party you are doing one or the other. Collapsing it frees the whole page for browsing, and the
	// peek can then carry the question people actually ask — "when am I up?" — which previously lived
	// in a card that scrolled off the top of the page.
	//
	// Pull is a pointer drag (works with touch, pen and mouse), but it is NEVER the only way in: the
	// whole peek is a button, Escape closes, and the backdrop is clickable. A drag-only sheet is
	// unreachable by keyboard and screen reader.
	import type { Snippet } from 'svelte';

	interface Props {
		open: boolean;
		/** Peek line 1 — the song, or a nudge to queue one. */
		title: string;
		/** Peek line 2 — who is singing. */
		sub?: string;
		/** Peek line 3 — "You're #3 · after Maya". The reason the sheet earns its space. */
		position?: string;
		queueCount?: number;
		children: Snippet; // the expanded body: the rotation list
		controls?: Snippet; // playback controls, rendered in the peek
		ontoggle?: (open: boolean) => void;
	}
	let { open, title, sub, position, queueCount = 0, children, controls, ontoggle }: Props = $props();

	// Drag state. `dragDy` is the live finger offset while dragging; committing past the threshold
	// toggles, otherwise the sheet springs back — a half-drag must not leave it in a third state.
	let dragging = $state(false);
	let dragDy = $state(0);
	let startY = 0;
	let captured: { el: HTMLElement; id: number } | null = null;
	const COMMIT_PX = 48;

	// How much of the sheet stays on screen when collapsed. MEASURED, not a constant: a hardcoded
	// guess leaves the body's first row bleeding below the peek (or clips the peek) the moment the
	// content changes height — e.g. when the position line appears. Published to :root so everything
	// else docked to the bottom (mic bar, toasts) agrees with the real rendered height.
	let peekH = $state(0);
	$effect(() => {
		if (peekH > 0) document.documentElement.style.setProperty('--peek-h', `${peekH}px`);
	});

	function onPointerDown(e: PointerEvent) {
		// let the buttons in the peek win their own taps
		if ((e.target as HTMLElement).closest('button.no-drag')) return;
		startY = e.clientY;
		dragging = true;
		dragDy = 0;
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		captured = { el, id: e.pointerId };
	}
	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const dy = e.clientY - startY;
		// only allow the direction that makes sense for the current state
		dragDy = open ? Math.max(0, dy) : Math.min(0, dy);
	}
	function endDrag() {
		if (!dragging) return;
		const moved = Math.abs(dragDy);
		const wasDrag = moved > 6; // below this it was a tap, not a pull
		if (captured) {
			captured.el.releasePointerCapture?.(captured.id);
			captured = null;
		}
		dragging = false;
		if (!wasDrag) {
			ontoggle?.(!open); // tap toggles
		} else if (moved > COMMIT_PX) {
			ontoggle?.(!open); // committed pull
		}
		dragDy = 0; // spring back
	}
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && ontoggle?.(false)} />

{#if open}
	<!-- click-outside to dismiss; aria-hidden because Escape + the toggle already expose the action -->
	<div class="backdrop" onclick={() => ontoggle?.(false)} aria-hidden="true"></div>
{/if}

<section class="sheet" class:open class:dragging style="--drag:{dragDy}px" aria-label="Queue">
	<div
		class="peek"
		bind:clientHeight={peekH}
		role="button"
		tabindex="0"
		aria-expanded={open}
		aria-label={open ? 'Collapse the queue' : `Show the queue, ${queueCount} ${queueCount === 1 ? 'song' : 'songs'}`}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={endDrag}
		onpointercancel={endDrag}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ontoggle?.(!open); }
			if (e.key === 'ArrowUp') { e.preventDefault(); ontoggle?.(true); }
			if (e.key === 'ArrowDown') { e.preventDefault(); ontoggle?.(false); }
		}}
	>
		<div class="grip" aria-hidden="true"></div>
		<div class="line">
			<div class="txt">
				<div class="t">{title}</div>
				{#if sub}<div class="s">{sub}</div>{/if}
				{#if position}<div class="pos">{position}</div>{/if}
			</div>
			{#if controls}<div class="ctrls">{@render controls()}</div>{/if}
		</div>
		<!-- The chevron already says which way this moves, and the grip already reads as draggable, so
		     spelling out "pull up"/"pull down to close" was redundant. The COUNT is kept: that is
		     information you cannot get from the affordance. The instruction survives for screen
		     readers in the button's aria-label above. -->
		<div class="hint">
			{#if !open && queueCount > 0}{queueCount} in the rotation{/if}
			<span class="chev" class:up={!open}>⌃</span>
		</div>
	</div>

	<div class="body" inert={!open}>
		{@render children()}
	</div>
</section>

<style>
	.backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 9; }
	.sheet {
		position: fixed; left: 0; right: 0; bottom: 0; z-index: 10;
		max-width: var(--max-w); margin: 0 auto;
		background: var(--card2); border: 1px solid var(--line); border-top-left-radius: 20px;
		border-top-right-radius: 20px; box-shadow: var(--shadow);
		display: flex; flex-direction: column;
		/* collapsed: only the peek shows. Expanded: most of the screen, body scrolls. */
		max-height: 82vh;
		transform: translateY(calc(100% - var(--peek-h, 132px) + var(--drag, 0px)));
		transition: transform 0.28s cubic-bezier(0.32, 0.72, 0, 1);
	}
	.sheet.open { transform: translateY(var(--drag, 0px)); }
	/* while a finger is down, follow it exactly — a transition here feels like lag */
	.sheet.dragging { transition: none; }
	.peek { padding: 8px 14px 10px; cursor: grab; touch-action: none; flex: 0 0 auto; }
	.peek:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 18px; }
	.grip { width: 40px; height: 4px; border-radius: 3px; background: #3a3a52; margin: 2px auto 10px; }
	.line { display: flex; align-items: center; gap: 12px; }
	.txt { min-width: 0; flex: 1; }
	.t { font-weight: 700; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.s { font-size: 0.78rem; color: var(--ink-dim); }
	.pos { font-size: 0.8rem; font-weight: 700; color: var(--accent2); margin-top: 3px; }
	.ctrls { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
	.hint {
		display: flex; align-items: center; justify-content: center; gap: 6px;
		font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase;
		color: #5b5b78; margin-top: 9px;
	}
	.chev { display: inline-block; transition: transform 0.28s ease; transform: rotate(180deg); }
	.chev.up { transform: rotate(0deg); }
	.body { overflow-y: auto; padding: 4px 14px 20px; -webkit-overflow-scrolling: touch; }
	/* keep the collapsed sheet from eating taps meant for the page behind it */
	.sheet:not(.open) .body { pointer-events: none; }
</style>
