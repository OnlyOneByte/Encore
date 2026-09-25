<!-- The registry's appearance is REPLACED by Encore's `.encore-field` look, in scoped CSS rather than utilities. Two
  hard floors, shared with native-select.svelte: `min-height: var(--tap)`, which reads the token rather than restating 44
  because `touch-targets.test.ts` requires that, and a 16px font-size on every variant, because iOS Safari auto-zooms on
  focusing any control under 16px and never zooms back. See docs/FRONTEND.md#shared-components. -->
<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from 'svelte/elements';

	type InputType = Exclude<HTMLInputTypeAttribute, 'file'>;

	type Props = WithElementRef<
		Omit<HTMLInputAttributes, 'type'> & ({ type: 'file'; files?: FileList } | { type?: InputType; files?: undefined })
	>;

	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		variant = 'field',
		files = $bindable(),
		class: className,
		'data-slot': dataSlot = 'input',
		...restProps
	}: Props & { variant?: 'field' | 'comfortable' | 'mono' | 'join' } = $props();
</script>

{#if type === 'file'}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		data-variant={variant}
		class={cn('encore-field', className)}
		type="file"
		bind:files={files}
		bind:value={value}
		{...restProps}
	/>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		data-variant={variant}
		class={cn('encore-field', className)}
		type={type}
		bind:value={value}
		{...restProps}
	/>
{/if}

<style>
	.encore-field {
		width: 100%;
		box-sizing: border-box;
		padding: 9px var(--space-md);
		border-radius: var(--radius-btn);
		border: 1px solid var(--line);
		background: var(--card2);
		color: var(--ink);
		min-height: var(--tap);
		font-size: var(--ph-text-base);
	}
	/* Your own name is the one field worth typing comfortably, so it keeps the sheet's larger box. */
	.encore-field[data-variant='comfortable'] {
		padding: var(--space-lg) var(--space-xl);
		font-size: 1.05rem;
		border-radius: 14px;
	}
	/* The join screen's one field, on a phone held at arm's length: the sheet's largest comfortable box. */
	.encore-field[data-variant='join'] {
		padding: var(--space-xl);
		font-size: var(--ph-text-lg);
		background: var(--card);
	}
	/* A LAN address is read character by character to check it, so the digits stay monospaced; the name field does not. */
	.encore-field[data-variant='mono'] {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		padding: 7px var(--space-md);
	}
	.encore-field[aria-invalid='true'] {
		border-color: var(--warn);
	}
	.encore-field:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.encore-field:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
</style>
