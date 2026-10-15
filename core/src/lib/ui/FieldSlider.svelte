<script lang="ts">
	/*
	 * A NAMED slider, and the reason this file exists is that the name cannot be passed from a call site.
	 *
	 * Two structural facts about the vendored primitive, both of which make the obvious spellings silently useless:
	 *   1. `Field.Label for={id}` renders a real `<label>`, but the primitive's ROOT is a `<span>` and that is where
	 *      `id` lands. `<label for>` only binds LABELABLE elements, so it bound nothing.
	 *   2. The element carrying `role="slider"` is the THUMB, which bits-ui gives `aria-valuemin/max/now/orientation`
	 *      and no name. An `aria-label` handed to `<Slider>` travels in `restProps` to the root, where nothing reads it.
	 * So every slider in the app announced as a bare number — nine of them down one Settings page.
	 *
	 * WHY A WRAPPER RATHER THAN A VENDORED EDIT. `src/lib/components/ui/` is a copy-in target: an edit there is lost on
	 * the next re-vendor, silently, and this defect is exactly the kind that returns unnoticed. `src/lib/ui/` is the
	 * documented home for wrapping a vendored primitive one layer up (see ./README.md, which notes that layer was
	 * unbuilt) — so the fix lives here, where a re-vendor cannot reach it.
	 *
	 * An ATTACHMENT, not an `$effect` with `bind:ref`: the work is keyed on an element's lifetime, which is what
	 * `{@attach}` encodes, and it re-runs on its own when `label` changes because it reads it. Attachments spread
	 * through a component, so this one lands on the root element the primitive renders.
	 */
	import { Slider } from '$lib/components/ui/slider';
	import type { ComponentProps } from 'svelte';

	let { label, ...rest }: { label: string } & ComponentProps<typeof Slider> = $props();

	/* ONE PLACE, NOT ELEVEN. Every slider in the app goes through this wrapper — nine on /settings, one on
	   /settings/server, one in GuidingTrack — so the trailing commit belongs here rather than at each call site.
	   WHY: `onValueCommit` fires per ARROW KEYPRESS, and each commit is a PUT plus a room-wide websocket
	   broadcast. Holding Right on a 0-100 slider emitted one write per step, every one of them landing on every
	   phone and the TV. A pointer drag already commits once on release; the keyboard path had no such boundary,
	   so the accessible way to use the control was also the expensive one.
	   TRAILING, NOT LEADING: the value that matters is where the guest stopped, and a leading edge would write
	   the first step and drop the rest. `onValueChange` is deliberately NOT touched — the readout and the TV
	   preview still track every step, so the control stays live while only the WRITE is coalesced. */
	const COMMIT_SETTLE_MS = 200;
	let pending: ReturnType<typeof setTimeout> | null = null;
	let queued: number | number[] | undefined;
	/** The last value actually written, so a no-op commit sends nothing at all. */
	let lastSent: string | undefined = $state(undefined);

	function flush(): void {
		if (pending) {
			clearTimeout(pending);
			pending = null;
		}
		if (queued === undefined) return;
		const key = JSON.stringify(queued);
		const value = queued;
		queued = undefined;
		/* A REPEATED VALUE IS NOT A WRITE. This also kills the no-op PUT that a press at min/max, or a second
		   Home/End, used to emit — the slider clamps so the value never changes, but the commit still fired. */
		if (key === lastSent) return;
		lastSent = key;
		rest.onValueCommit?.(value as never);
	}

	function onCommit(value: number | number[]): void {
		queued = value;
		if (pending) clearTimeout(pending);
		pending = setTimeout(flush, COMMIT_SETTLE_MS);
	}

	/* FLUSHED ON THE WAY OUT, both ways. A host who sets a value and immediately tabs away or navigates would
	   otherwise lose the last write inside the settle window — the one case where a debounce turns into data
	   loss rather than a saving. */
	$effect(() => () => flush());

	/** EVERY thumb, because a range slider renders one per handle and an unnamed second handle is the same defect. */
	function nameThumbs(root: Element) {
		for (const thumb of root.querySelectorAll('[data-slot="slider-thumb"]')) {
			thumb.setAttribute('aria-label', label);
		}
	}
</script>

<!-- `onblur` on the wrapper, with `|capture` not needed: blur does not bubble, but focusout does, and the
	thumb is a descendant — so this fires when focus leaves any handle. -->
<div class="slider-slot" onfocusout={flush}>
	<Slider {...rest} onValueCommit={onCommit} {@attach nameThumbs} />
</div>

<style>
	/* `display: contents`, so inserting this wrapper changes no layout: the Slider stays the flex/grid item its
	   parents already size. A plain div here moved every slider on /settings by its own box. */
	.slider-slot {
		display: contents;
	}
</style>
