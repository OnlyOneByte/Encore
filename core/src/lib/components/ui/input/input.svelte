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
		/* --control-line and NOT --line: this border is the only thing that says "type here", which SC 1.4.11 puts a 3:1
		   floor under. 3.65:1 on the --card2 fill below, and 3.97:1 on the --card the `join` variant swaps in. */
		border: 1px solid var(--control-line);
		background: var(--card2);
		color: var(--ink);
		min-height: var(--tap);
		font-size: var(--ph-text-base);
	}
	/* Your own name is the one field worth typing comfortably, so it keeps the sheet's larger box. THREE BOXES, THREE
	   RUNGS, and they have to stay one rung apart each or the variants are not telling the guest anything: base is
	   10px inline, this is 12 and `join` below is 16. This was `lg xl` (12/14) and join was 14 — 12/14/14, where two
	   of the three were the same and the third was 2px away. `xl` is retired; see app.css's ladder. */
	.encore-field[data-variant='comfortable'] {
		padding: var(--space-lg);
		font-size: 1.05rem;
		border-radius: 14px;
	}
	/* The join screen's one field, on a phone held at arm's length: the sheet's largest comfortable box. At `2xl` the
	   box is 4px taller than it was at `xl`, which JoinLanding's `.join-main` pays for by dropping its own vertical
	   inset one rung in the same change — that file says so. */
	.encore-field[data-variant='join'] {
		padding: var(--space-2xl);
		font-size: var(--ph-text-lg);
		background: var(--card);
	}
	/* A LAN address is read character by character to check it, so the digits stay monospaced; the name field does not. */
	.encore-field[data-variant='mono'] {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		padding: 7px var(--space-md);
	}
	/* --danger, the same token the vendored checkbox, switch and button already spend on `aria-invalid` through
	   `border-destructive`: a rejected value does not self-heal, so amber here drew /settings' join address in the
	   reconnecting colour while the refusal beneath it was red. */
	.encore-field[aria-invalid='true'] {
		border-color: var(--danger);
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
