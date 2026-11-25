<!--
  Guide as Off / Low / Full (an owner ruling for the redesign): one exclusive choice, so an APG radio group with one
  tab stop and arrow keys. A pick shows at once; the room's answer, or PRESS_HOLD_MS without one, replaces it.
-->
<script lang="ts">
	import { GUIDE_PRESETS, nearestGuidePreset, type GuidePresetId } from '$lib/guide-preset';

	type Preset = (typeof GUIDE_PRESETS)[number];

	let {
		level,
		onpick,
		disabled = false,
		label = 'Guide',
		scope
	}: {
		/** The room's effective level, 0..1. */
		level: number | null;
		/** What the level belongs to (a song): a pick never outlives it, even when the next one's level is equal. */
		scope?: string;
		/** Returns false when the command never reached the wire. */
		onpick: (level: number) => boolean | void;
		disabled?: boolean;
		label?: string;
	} = $props();

	// A room that keeps its level (a refused or no-op command) sends no change, so a pick may not outlive this.
	const PRESS_HOLD_MS = 3000;

	let draft = $state<GuidePresetId | null>(null);
	let hold: ReturnType<typeof setTimeout> | undefined;
	const buttons = $state<HTMLButtonElement[]>([]);

	// The room's answer replaces the draft, whichever way it went; so does the next song.
	$effect(() => {
		void level;
		void scope;
		draft = null;
	});
	$effect(() => () => clearTimeout(hold));

	// The nearest preset, so a room default between them (0.2) still shows one picked (#1295 review).
	const checked = $derived(draft ?? nearestGuidePreset(level));
	const tabStop = $derived(GUIDE_PRESETS.findIndex((p) => p.id === checked));

	function pick(p: Preset) {
		clearTimeout(hold);
		draft = p.id;
		if (onpick(p.level) === false) draft = null;
		else hold = setTimeout(() => (draft = null), PRESS_HOLD_MS);
	}

	function onkeydown(e: KeyboardEvent, i: number) {
		const n = GUIDE_PRESETS.length;
		const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
		if (to === undefined) return;
		e.preventDefault();
		const j = (to + n) % n;
		buttons[j]?.focus();
		pick(GUIDE_PRESETS[j]!);
	}
</script>

<!-- INLINE, with no <style> block: the You're up flood renders these too, and SvelteKit would link a stylesheet of theirs
	into every route (CLAIM 13). The global ring draws in `--focus`, which the group sets to the card's own ring colour:
	on a lit card the default is under 3:1. The pill radius is inline, so it wins over the ring rule's. -->
<div
	class="segments"
	role="radiogroup"
	aria-label={label}
	aria-disabled={disabled}
	style:display="inline-flex"
	style:border="2px solid currentColor"
	style:border-radius="var(--round-pill)"
	style:--focus="var(--seg-focus, var(--role-focus))"
>
	{#each GUIDE_PRESETS as p, i (p.id)}
		<button
			type="button"
			role="radio"
			aria-checked={checked === p.id}
			tabindex={i === (tabStop < 0 ? 0 : tabStop) ? 0 : -1}
			disabled={disabled}
			bind:this={buttons[i]}
			onclick={() => pick(p)}
			onkeydown={(e) => onkeydown(e, i)}
			style:min-width="var(--tap)"
			style:min-height="var(--tap)"
			style:padding="0 var(--step-12)"
			style:border="0"
			style:border-radius="var(--round-pill)"
			style:background={checked === p.id ? 'currentColor' : 'none'}
			style:color="inherit"
			style:font-size="var(--type-meta)"
			style:font-weight="700"
			style:cursor={disabled ? 'default' : 'pointer'}
			style:opacity={disabled ? '0.5' : undefined}
			><span style:color={checked === p.id ? 'var(--seg-ink, var(--role-ground))' : undefined}>{p.label}</span></button
		>
	{/each}
</div>
