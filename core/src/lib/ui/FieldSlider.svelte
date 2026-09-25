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

	/** EVERY thumb, because a range slider renders one per handle and an unnamed second handle is the same defect. */
	function nameThumbs(root: Element) {
		for (const thumb of root.querySelectorAll('[data-slot="slider-thumb"]')) {
			thumb.setAttribute('aria-label', label);
		}
	}
</script>

<Slider {...rest} {@attach nameThumbs} />
