<!--
  Guide as Off / Low / Full (an owner ruling for the redesign). A tap presses its segment in the same frame; a send
  that never reached the room drops the press again, the rule guide-send.ts states for the slider.
-->
<script lang="ts">
	import { GUIDE_PRESETS, guidePresetOf, type GuidePresetId } from '$lib/guide-preset';

	let {
		level,
		onpick,
		disabled = false,
		label = 'Guide'
	}: {
		/** The room's effective level, 0..1. */
		level: number | null;
		/** Returns false when the command never reached the wire. */
		onpick: (level: number) => boolean | void;
		disabled?: boolean;
		label?: string;
	} = $props();

	let draft = $state<GuidePresetId | null>(null);
	// The room's answer replaces the draft, whichever way it went.
	$effect(() => {
		void level;
		draft = null;
	});
	const pressed = $derived(draft ?? guidePresetOf(level));

	function pick(p: (typeof GUIDE_PRESETS)[number]) {
		draft = p.id;
		if (onpick(p.level) === false) draft = null;
	}
</script>

<div class="segments" role="group" aria-label={label}>
	{#each GUIDE_PRESETS as p (p.id)}
		<button type="button" aria-pressed={pressed === p.id} disabled={disabled} onclick={() => pick(p)}
			><span>{p.label}</span></button
		>
	{/each}
</div>

<style>
	.segments {
		display: inline-flex;
		border: 2px solid currentColor;
		border-radius: var(--round-pill);
	}
	button {
		min-width: var(--tap);
		min-height: var(--tap);
		padding: 0 var(--step-3);
		border: 0;
		border-radius: var(--round-pill);
		background: none;
		color: inherit;
		font-size: var(--type-meta);
		font-weight: 700;
		cursor: pointer;
	}
	[aria-pressed='true'] {
		background: currentColor;
	}
	/* On the span, not the button: the fill above is the button's own currentColor. */
	[aria-pressed='true'] span {
		color: var(--seg-ink, var(--role-ground));
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
