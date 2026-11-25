<script lang="ts">
	/* "YOU'RE UP" floods the phone in the singer's colour (redesign step 6, #1156), on every tab but Queue, where the
	   card already says it. PRESENTATIONAL: the layout owns when it shows, the timer and the live region.
	   NO <style> BLOCK, on purpose: SvelteKit links even a lazily imported component's stylesheet into every route
	   that imports it, and CLAIM 13 has no room for it, so the look is inline (as JoinLanding's is, #1198) and the
	   motion is the Web Animations API. */
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { YOURE_UP } from '$lib/phrasing/turn-phrasing';
	import { floodColors } from '$lib/youre-up';

	interface Props {
		name: string;
		title: string;
		singerColor: string;
		ondismiss: () => void;
		onrestart: () => void;
		/** The song's key and guide rows, laid out as the Queue card lays them out. */
		controls?: Snippet;
	}
	let { name, title, singerColor, ondismiss, onrestart, controls }: Props = $props();
	const colors = $derived(floodColors(singerColor));

	// A tap anywhere but a control dismisses it, so the first touch after the moment never lands on the page under it.
	function onpointerdown(e: PointerEvent) {
		if (!(e.target as Element).closest('button, a, input, [role="slider"], [role="radiogroup"]')) ondismiss();
	}

	// Opacity in, the headline popping from 0.92; only transform and opacity, on --motion-slow. Under reduced motion it
	// simply appears.
	const reduced = new MediaQuery('prefers-reduced-motion: reduce', false);
	let root = $state<HTMLElement>();
	let big = $state<HTMLElement>();
	$effect(() => {
		if (!root || !big || reduced.current) return;
		const ms = parseFloat(getComputedStyle(root).getPropertyValue('--motion-slow')) * 1000 || 400;
		const opts: KeyframeAnimationOptions = { duration: ms, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' };
		root.animate([{ opacity: 0 }, { opacity: 1 }], opts);
		big.animate(
			[
				{ opacity: 0, transform: 'scale(0.92)' },
				{ opacity: 1, transform: 'none' }
			],
			opts
		);
	});
</script>

<!-- Not a dialog: it takes no focus and blocks nothing it does not cover. The layout's live region announces it, so
	the words here are hidden from assistive tech rather than read twice. The ink is also the focus ring (`--focus`). -->
<div
	bind:this={root}
	data-testid="youre-up-flood"
	role="presentation"
	onpointerdown={onpointerdown}
	style:position="fixed"
	style:inset="0"
	style:z-index="var(--z-dock)"
	style:display="flex"
	style:flex-direction="column"
	style:padding="var(--step-24) var(--step-16) calc(var(--step-16) + env(safe-area-inset-bottom, 0px))"
	style:background={colors.bg}
	style:color={colors.ink}
	style:--role-ink={colors.ink}
	style:--focus={colors.ink}
>
	<div
		aria-hidden="true"
		style:flex="1"
		style:display="flex"
		style:flex-direction="column"
		style:justify-content="center"
		style:gap="var(--step-8)"
		style:min-height="0"
	>
		<p style:margin="0" style:font-size="var(--type-title)" style:font-weight="700">{name}, grab the mic</p>
		<p
			bind:this={big}
			style:margin="0"
			style:font-size="var(--type-hero)"
			style:font-weight="800"
			style:line-height="1"
			style:letter-spacing="-0.03em"
		>
			{YOURE_UP}
		</p>
		<p style:margin="0" style:font-size="var(--type-lead)" style:font-weight="700" style:overflow-wrap="anywhere">
			{title}
		</p>
	</div>
	{#if controls}<div>{@render controls()}</div>{/if}
	<button
		type="button"
		onclick={onrestart}
		style:align-self="center"
		style:min-height="var(--tap)"
		style:padding-inline="var(--step-16)"
		style:border="0"
		style:background="transparent"
		style:color="inherit"
		style:font="inherit"
		style:font-weight="700"
		style:text-decoration="underline"
		style:text-underline-offset="3px">Restart</button
	>
</div>
