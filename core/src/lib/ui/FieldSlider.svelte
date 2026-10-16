<script lang="ts">
	/*
	 * A NAMED slider, and the reason this file exists is that the name cannot be passed from a call site.
	 *
	 * Two structural facts about the vendored primitive, both of which make the obvious spellings silently useless:
	 *   1. `Field.Label for={id}` renders a real `<label>`, but the primitive's ROOT is a `<span>` and that is where
	 *      `id` lands. `<label for>` only binds LABELABLE elements, so it bound nothing.
	 *   2. The element carrying `role="slider"` is the THUMB, which bits-ui gives `aria-valuemin/max/now/orientation`
	 *      and no name. An `aria-label` handed to `<Slider>` travels in `restProps` to the root, where nothing reads it.
	 * So every slider in the app announced as a bare number — eight of them down one Settings page.
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

	/*
	 * `value` IS PULLED OUT OF THE SPREAD AND FORWARDED WITH `bind:`, so that a caller who wants a CONTROLLED
	 * slider can have one. A `bind:` does not survive a spread — `{...rest}` forwards the value, never the
	 * binding — so while `value` rode `rest` the primitive always owned it: it wrote its own local copy on every
	 * move and nothing re-asserted the caller's. For the nine OTHER sliders that was invisible, because every one of
	 * them advances its own state from `onValueChange` and so always agreed. For GuidingTrack it was the shipping half
	 * of docs/UI-REVIEW.md finding C: with the socket down the command was refused and the draft correctly
	 * declined to move, but the thumb, the filled range and `aria-valuenow` had already advanced inside the
	 * primitive and stayed there THROUGH the reconnect.
	 * Both shapes are still available from here. Plain `value={x}` leaves the prop unbound, so the local state is
	 * this wrapper's and the control is uncontrolled exactly as before; `bind:value={get, set}` makes every read
	 * the caller's authority and every write a request. GuidingTrack carries the account of why it needs the
	 * second.
	 */
	let { label, value = $bindable(), ...rest }: { label: string } & ComponentProps<typeof Slider> = $props();

	/* ONE PLACE, NOT TEN. Every slider in the app goes through this wrapper — eight on /settings, one on
	   /settings/server, one in GuidingTrack, re-counted off `<FieldSlider` and none of them inside an `{#each}` —
	   so the trailing commit belongs here rather than at each call site.
	   WHY: `onValueCommit` fires per ARROW KEYPRESS, and each commit is a PUT plus a room-wide websocket
	   broadcast. Holding Right on a 0-100 slider emitted one write per step, every one of them landing on every
	   phone and the TV. A pointer drag already commits once on release; the keyboard path had no such boundary,
	   so the accessible way to use the control was also the expensive one.
	   TRAILING, NOT LEADING: the value that matters is where the guest stopped, and a leading edge would write
	   the first step and drop the rest. ONLY `onValueCommit` IS DEBOUNCED HERE: the live path is untouched, so the
	   readout and the TV preview still track every step and the control stays live while only the WRITE is
	   coalesced. Which callback the live path IS differs by caller, and this file is deliberately indifferent to
	   it — `onValueChange` for the nine sliders that read their own state back, the value binding's setter for
	   GuidingTrack, whose whole point is that the write is a request the room may refuse. */
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
	<!-- `value as never` for the same reason slider.svelte casts it: `SliderRootProps` is discriminated on `type`,
		and a destructured bindable cannot be narrowed by it. -->
	<Slider {...rest} bind:value={value as never} onValueCommit={onCommit} {@attach nameThumbs} />
</div>

<style>
	/* `display: contents`, so inserting this wrapper changes no layout: the Slider stays the flex/grid item its
	   parents already size. A plain div here moved every slider on /settings by its own box. */
	.slider-slot {
		display: contents;
	}
</style>
