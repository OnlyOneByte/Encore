<script lang="ts">
	/* "YOU'RE UP" floods the phone in the singer's colour (redesign step 6, #1156), on every tab but Queue, where the
	   card already says it. The Key and Guide rows are the card's, in the card's order, driving the live song through
	   $lib/live-tune as /queue does. The layout owns when it shows, the timer and the live region.
	   NO <style> BLOCK, on purpose: SvelteKit links even a lazily imported component's stylesheet into every route
	   that imports it, and CLAIM 13 has no room for it, so the look is inline (as JoinLanding's is, #1198) and the
	   motion is the Web Animations API. */
	import { MediaQuery } from 'svelte/reactivity';
	import { MAX_KEY_SHIFT, type SongProfile } from '$lib/contract';
	import { YOURE_UP } from '$lib/phrasing/turn-phrasing';
	import { keyStepName } from '$lib/phrasing/row-action-names';
	import { floodColors } from '$lib/youre-up';
	import { liveTune } from '$lib/live-tune.svelte';
	import { songFacts } from '$lib/song-facts';
	import GuideSegments from '$lib/ui/GuideSegments.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		name: string;
		title: string;
		singerColor: string;
		/** The playing entry (this phone's own), and what the room says about it. */
		entryId: string;
		mediaId: string | null;
		profile: SongProfile | null;
		serverKey: number;
		/** The effective guide level, 0..1. */
		guideLevel: number;
		keyAvailable: boolean;
		guideAvailable: boolean;
		ondismiss: () => void;
		onrestart: () => void;
	}
	let props: Props = $props();
	const colors = $derived(floodColors(props.singerColor));
	const tune = liveTune(() => ({
		entryId: props.entryId,
		mediaId: props.mediaId,
		mine: true,
		serverKey: props.serverKey
	}));
	const facts = $derived(songFacts(props.profile, tune.keyShift));
	const keyWords = $derived(
		[facts.keyShifted ? `${facts.keyOriginal} → ${facts.keySounding}` : facts.keyOriginal, facts.rangeText]
			.filter(Boolean)
			.join(' · ')
	);
	// The ink at 14%, the card's rule between its rows.
	const rule = $derived(`1px solid color-mix(in srgb, ${colors.ink} 14%, transparent)`);

	// A tap anywhere but a control dismisses it, so the first touch after the moment never lands on the page under it.
	function onpointerdown(e: PointerEvent) {
		if (!(e.target as Element).closest('button, a, input, [role="slider"], [role="radiogroup"]')) props.ondismiss();
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
	the words here are hidden from assistive tech rather than read twice. Every control inks itself in the flood's ink,
	its focus ring and the pressed Guide segment's fill included. -->
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
	style:--ink={colors.ink}
	style:--ink-dim={colors.ink}
	style:--control-line={colors.ink}
	style:--role-ink={colors.ink}
	style:--focus={colors.ink}
	style:--seg-focus={colors.ink}
	style:--seg-ink={colors.bg}
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
		<p style:margin="0" style:font-size="var(--type-title)" style:font-weight="700">{props.name}, grab the mic</p>
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
			{props.title}
		</p>
	</div>

	<!-- The card's two rows, in its order: Key with its words, then Guide. -->
	<div
		data-testid="flood-key"
		style:display="flex"
		style:align-items="center"
		style:justify-content="space-between"
		style:gap="var(--step-12)"
		style:min-height="56px"
		style:border-top={rule}
	>
		<span>
			<span class="control-label">{facts.keyLabel}</span>
			<small style:display="block" style:font-size="var(--type-meta)" style:font-weight="600"
				>{keyWords || 'Original'}</small
			>
		</span>
		<div style:display="flex" style:gap="var(--step-8)">
			<Button
				size="tap"
				variant="keycap"
				disabled={!props.keyAvailable || tune.keyShift <= -MAX_KEY_SHIFT}
				aria-label={keyStepName(-1, props.title)}
				onclick={() => tune.stepKey(-1)}><Icon name="minus" /></Button
			>
			<Button
				size="tap"
				variant="keycap"
				disabled={!props.keyAvailable || tune.keyShift >= MAX_KEY_SHIFT}
				aria-label={keyStepName(1, props.title)}
				onclick={() => tune.stepKey(1)}><Icon name="plus" /></Button
			>
		</div>
	</div>
	<div
		data-testid="flood-guide"
		style:display="flex"
		style:align-items="center"
		style:justify-content="space-between"
		style:gap="var(--step-12)"
		style:min-height="56px"
		style:border-top={rule}
	>
		<span class="control-label">Guide</span>
		<GuideSegments
			level={props.guideLevel}
			scope={props.entryId}
			disabled={!props.guideAvailable}
			onpick={tune.guidePick}
		/>
	</div>

	<button
		type="button"
		onclick={props.onrestart}
		style:align-self="center"
		style:min-height="var(--tap)"
		style:margin-top="var(--step-8)"
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
