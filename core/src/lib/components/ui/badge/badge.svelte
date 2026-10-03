<!-- Encore's chip, not the registry's four generic tones: these chips are a semantic STATE system mapping a song's
  readiness and kind onto --ok / --warn / --danger / --accent-ink, each a certified surface+border+ink triple. Appearance
  is scoped CSS rather than utilities. -->
<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';

	export const badgeVariants = tv({
		base: 'encore-chip',
		variants: {
			variant: {
				neutral: '',
				ok: 'encore-chip-ok',
				warn: 'encore-chip-warn',
				bad: 'encore-chip-bad',
				accent: 'encore-chip-accent',
				tag: 'encore-chip-accent encore-chip-tag'
			},
			/* A chip carrying a PHRASE rather than a token must opt into wrapping: under the base's `white-space: nowrap` its
				   min-content width is its full width, so it pushes the page past the 320px reflow floor at 200% text. */
			wrap: {
				true: 'encore-chip-wrap',
				false: ''
			}
		},
		defaultVariants: {
			variant: 'neutral',
			wrap: false
		}
	});

	export type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAnchorAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		href,
		class: className,
		variant = 'neutral',
		wrap = false,
		children,
		...restProps
	}: WithElementRef<HTMLAnchorAttributes> & {
		variant?: BadgeVariant;
		wrap?: boolean;
	} = $props();
</script>

<svelte:element
	this={href ? 'a' : 'span'}
	bind:this={ref}
	data-slot="badge"
	href={href}
	class={cn(badgeVariants({ variant, wrap }), className)}
	{...restProps}
>
	{@render children?.()}
</svelte:element>

<style>
	.encore-chip {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		font-size: var(--ph-text-xs);
		font-weight: 600;
		padding: var(--space-3xs) 7px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--line);
		background: var(--card2);
		color: var(--ink-dim);
		white-space: nowrap;
	}
	/* Claws back a little of a row on the narrowest phone, without shrinking the title or the 44px target. It belongs
	   here rather than in the row: a scoped rule there cannot reach the element this component renders.
	   THE CLAW-BACK IS THE PADDING ALONE NOW. This arm also shrank the type, to 0.62rem/9.92px, off a base of
	   0.65rem/10.4px — both under the ladder's 12px floor, on a chip that carries whole sentences ("Name match only
	   — search to sing it"), at the width where the screen is smallest. The base is now `--ph-text-xs`, and the
	   floor does not get an exception for being narrow, so a `wrap` chip may take one more line here. */
	@media (max-width: 380px) {
		.encore-chip {
			padding: 1px var(--space-xs);
		}
	}
	.encore-chip-wrap {
		white-space: normal;
	}
	.encore-chip-ok {
		background: var(--ok-bg);
		border-color: var(--ok-line);
		color: var(--ok);
	}
	.encore-chip-warn {
		background: var(--warn-bg);
		border-color: var(--warn-line);
		color: var(--warn);
	}
	.encore-chip-bad {
		background: var(--danger-bg);
		border-color: var(--danger-line);
		color: var(--danger-ink);
	}
	/* A tag is a describing word, so it reads as one: capitalised, and washed in accent rather than any status colour. */
	.encore-chip-tag {
		text-transform: capitalize;
	}
	.encore-chip-accent {
		background: var(--card-tint2);
		border-color: var(--line-tint);
		color: var(--accent-ink);
	}
</style>
