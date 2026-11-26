<!--
  What one screen shows, Everything, Words only or Up next (proposal 34): one exclusive choice, so an APG radio group
  with one tab stop and arrow keys, as GuideSegments is. The page's next poll replaces a pick the server refused.
-->
<script lang="ts">
	import type { TvShow } from '$lib/contract';

	const CHOICES: { id: TvShow; label: string }[] = [
		{ id: 'everything', label: 'Everything' },
		{ id: 'words', label: 'Words only' },
		{ id: 'board', label: 'Up next' }
	];

	let {
		show,
		onpick,
		disabled = false,
		label
	}: { show: TvShow; onpick: (show: TvShow) => void; disabled?: boolean; label: string } = $props();

	const buttons = $state<HTMLButtonElement[]>([]);
	const tabStop = $derived(
		Math.max(
			0,
			CHOICES.findIndex((c) => c.id === show)
		)
	);

	function pick(id: TvShow) {
		if (id !== show) onpick(id);
	}

	function onkeydown(e: KeyboardEvent, i: number) {
		const n = CHOICES.length;
		const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
		if (to === undefined) return;
		e.preventDefault();
		const j = (to + n) % n;
		buttons[j]?.focus();
		pick(CHOICES[j]!.id);
	}
</script>

<div class="fit">
	<div class="segments" role="radiogroup" aria-label={label}>
		{#each CHOICES as c, i (c.id)}
			<button
				type="button"
				role="radio"
				aria-checked={show === c.id}
				tabindex={i === tabStop ? 0 : -1}
				disabled={disabled}
				bind:this={buttons[i]}
				onclick={() => pick(c.id)}
				onkeydown={(e) => onkeydown(e, i)}><span>{c.label}</span></button
			>
		{/each}
	</div>
</div>

<style>
	.fit {
		container-type: inline-size;
		margin-top: var(--step-8);
	}
	.segments {
		display: flex;
		border: 1px solid var(--role-rule);
		border-radius: var(--round-pill);
	}
	/* Each label keeps one line, so a choice sizes to its label rather than to an equal third. */
	button {
		flex: 1 1 auto;
		min-height: var(--tap);
		padding: 0 var(--step-8);
		white-space: nowrap;
		border: 0;
		border-radius: var(--round-pill);
		background: none;
		color: var(--role-ink-dim);
		font-size: var(--type-meta);
		font-weight: 700;
		cursor: pointer;
	}
	/* Narrower than the three labels (a Spotlight at 320): one choice per line, each still a full 44 px tap. */
	@container (max-width: 15rem) {
		.segments {
			flex-direction: column;
			border-radius: var(--step-24);
		}
	}
	button:focus-visible {
		outline-color: var(--role-focus);
	}
	[aria-checked='true'] {
		background: var(--role-ink);
	}
	[aria-checked='true'] span {
		color: var(--role-ground);
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
