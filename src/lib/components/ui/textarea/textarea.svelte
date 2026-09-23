<!--
  Encore's `.encore-field` look in scoped CSS, adapted the way input.svelte is and sharing its 16px
  font-size floor (iOS Safari auto-zooms a focused sub-16px control and never zooms back).

  `resize: vertical` only — a lyrics paste is many short lines, and horizontal resize breaks out of the
  card. NO margin of any kind: outer spacing belongs to the call site, because a primitive that ships its
  own margin cannot be reused at a second one.
-->
<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from '$lib/utils.js';
	import type { HTMLTextareaAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		'data-slot': dataSlot = 'textarea',
		...restProps
	}: WithoutChildren<WithElementRef<HTMLTextareaAttributes>> = $props();
</script>

<textarea
	bind:this={ref}
	data-slot={dataSlot}
	class={cn('encore-textarea', className)}
	bind:value={value}
	{...restProps}></textarea>

<style>
	.encore-textarea {
		width: 100%;
		box-sizing: border-box;
		background: var(--card2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		color: var(--ink);
		font: inherit;
		font-size: var(--ph-text-base);
		padding: var(--space-xs);
		resize: vertical;
	}
	.encore-textarea::placeholder {
		color: var(--ink-dim);
	}
	.encore-textarea:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.encore-textarea[aria-invalid='true'] {
		border-color: var(--warn);
	}
	.encore-textarea:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
</style>
