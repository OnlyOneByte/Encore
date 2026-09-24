<!-- Each variant is a fill + line + ink TRIPLE, so a tinted banner is legible on its own; the registry's two variants
  carry the tone in the ink over a flat card. Every one names its own border colour, because the registry's bare `border`
  sets width only and falls back to currentColor — an ink-bright hairline. `ok` is deliberately undefined. Radius,
  spacing and type are arbitrary values off Encore's tokens rather than t-shirt or numeric utilities. -->
<script lang="ts" module>
	import { type VariantProps, tv } from 'tailwind-variants';

	export const alertVariants = tv({
		base: "grid gap-[var(--space-2xs)] rounded-[var(--radius-sm)] border px-[var(--space-lg)] py-[var(--space-md)] text-left text-[length:var(--ph-text-base)] has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-[var(--space-sm)] *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4 group/alert relative w-full",
		variants: {
			variant: {
				default: 'bg-[var(--card)] border-[var(--line)] text-[var(--ink)]',
				destructive:
					'bg-[var(--danger-bg)] border-[var(--danger-line)] text-[var(--danger-ink)] *:data-[slot=alert-description]:text-[var(--danger-ink)]',
				warn: 'bg-[var(--warn-bg)] border-[var(--warn-line)] text-[var(--warn)] *:data-[slot=alert-description]:text-[var(--warn)]',
				accent:
					'bg-[var(--card-tint)] border-[var(--line-tint)] text-[var(--accent-ink)] *:data-[slot=alert-description]:text-[var(--accent-ink)]'
			}
		},
		defaultVariants: {
			variant: 'default'
		}
	});

	export type AlertVariant = VariantProps<typeof alertVariants>['variant'];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		variant = 'default',
		role = 'alert',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		variant?: AlertVariant;
		/* Overridable, unlike the registry's hardcoded `alert`: `phone-inventory.test.ts` requires every live region to be POLITE. */
		role?: 'alert' | 'status' | null;
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="alert"
	role={role ?? undefined}
	class={cn(alertVariants({ variant }), className)}
	{...restProps}
>
	{@render children?.()}
</div>
