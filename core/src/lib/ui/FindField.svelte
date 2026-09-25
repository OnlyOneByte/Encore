<script lang="ts">
	/*
	 * THE APP'S ONE TEXT FIELD SHAPE: a leading mark, a borderless input, an optional spinner, an optional clear
	 * control, and the focus ring drawn around the WHOLE box rather than the input. `/` and `/library` declared all of
	 * it twice — five CSS rules byte for byte, and near-identical markup.
	 *
	 * THE TWO CALLERS DO OPPOSITE THINGS and that is deliberate, not an accident this component should paper over:
	 * home's field FETCHES from three resolvers (hence `busy`, which is the only reason a spinner exists here), while
	 * /library's narrows rows already in memory. What they share is the CONTROL; the behaviour stays at the call site,
	 * which is why this takes callbacks rather than owning a query.
	 *
	 * SIZING IS THE CALLER'S. The root is `width: 100%; min-width: 0` and nothing else, because the two need different
	 * flex behaviour — home shares a row with the library door, /library spans alone. A class handed to a component is
	 * stripped at the caller, so a caller that needs flex-item layout wraps this in its own slot div, the same idiom
	 * `.lib-slot` / `.me-slot` / `.gear-slot` already use.
	 *
	 * THE RING BELONGS TO THE BOX, which is why app.css's global per-input ring is suppressed on the input below —
	 * without that there are two rings, one inside the other.
	 */
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';

	let {
		value = $bindable(''),
		/** The accessible name. Distinct from `placeholder` on purpose: a placeholder is not a label. */
		ariaLabel,
		placeholder,
		/** Renders the spinner. Only true for a field that actually goes somewhere. */
		busy = false,
		/** Whether to offer the clear control right now — the caller decides what "has something to clear" means. */
		clearable = false,
		/** The clear control's accessible name. It differs by caller ("the search" vs "the filter"), and it is the
		 *  whole announcement for an icon-only button. */
		clearLabel = 'Clear',
		onclear,
		oninput,
		/** Bindable, because both callers call `.focus()` on it — after clearing, and to return focus. */
		element = $bindable<HTMLInputElement | null>(null)
	}: {
		value?: string;
		ariaLabel: string;
		placeholder: string;
		busy?: boolean;
		clearable?: boolean;
		clearLabel?: string;
		onclear?: () => void;
		oninput?: () => void;
		element?: HTMLInputElement | null;
	} = $props();
</script>

<div class="findbox">
	<span class="find-mark"><Icon name="search" /></span>
	<input bind:this={element} bind:value={value} oninput={oninput} aria-label={ariaLabel} placeholder={placeholder} />
	{#if busy}<Spinner aria-label="Searching" />{/if}
	{#if clearable}
		<Button variant="ghost" size="icon" aria-label={clearLabel} onclick={onclear}>
			<Icon name="close" />
		</Button>
	{/if}
</div>

<style>
	.findbox {
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-lg) var(--space-xl);
		min-height: 52px;
		/* The caller owns flex-item behaviour; this only fills whatever box it is given, and can shrink. */
		width: 100%;
		min-width: 0;
	}
	.findbox input {
		border: 0;
		background: transparent;
		color: var(--ink);
		font-size: var(--ph-text-base);
		/* flex + min-width:0, never width:100% — the box must be able to shrink under SC 1.4.10 reflow. */
		flex: 1;
		min-width: 0;
		/* The input, not the wrapper, is the tap target. */
		min-height: var(--tap);
	}
	/* The ring belongs to the WHOLE box, which is why app.css's per-input ring is suppressed below. */
	.findbox:has(input:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.findbox input:focus-visible {
		outline: none;
	}
	.find-mark {
		display: grid;
		place-items: center;
		color: var(--ink-dim);
	}
	/* A phone held sideways spends almost its whole height on chrome, so the control shrinks to the tap floor rather
	   than its resting 52px. Previously only `/` carried this; /library is the same control and now shrinks with it. */
	@media (max-height: 480px) {
		.findbox {
			min-height: var(--tap);
			padding: var(--space-sm) var(--space-xl);
		}
	}
</style>
