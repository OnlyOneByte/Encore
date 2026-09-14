<!--
  ── ENCORE DEVIATIONS (P0 · alert adoption) ──────────────────────────────────────────────────
  1. TONE VARIANTS REPLACE THE REGISTRY'S TWO. Upstream ships `default` (`bg-card`) and
     `destructive` (`text-destructive bg-card`) — both of which paint the CARD surface and carry the
     tone in the ink only. Encore already had a tinted-panel vocabulary for exactly this job
     (`--danger-bg`/`--danger-line`/`--danger-ink`, and the same triple for warn and ok), and
     `/metrics`'s no-worker banner was already drawn that way. Keeping the registry's flat card would
     have made the adopted banner LESS legible than the hand-rolled one it replaced, so the variants
     are `default | destructive | warn | accent`, each a fill + line + ink triple.

     `ok` is deliberately NOT defined: no call site needs it, and "vendored but unwired reads as
     migrated when it is not" (`ui/README.md`).

     Named `destructive` rather than Badge's `bad` so a future `shadcn-svelte add alert --overwrite`
     still diffs cleanly against the registry. That is a knowing inconsistency with Badge's tone
     names, recorded here rather than silently introduced.

  2. `border` GAINS AN EXPLICIT COLOUR. The registry writes bare `border`, which sets width only, so
     the colour falls back to `currentColor` — a `--ink`-bright hairline on the default variant and a
     full-strength danger line on destructive. Every variant now names its own border token.

  3. `rounded-lg` → `rounded-[var(--radius-sm)]`. Encore defines no `--radius-lg`, so `rounded-lg`
     resolved against Tailwind's default 0.5rem instead of the app's scale — the same silent-drift
     class as the `max-w-xs` → 6px trap found while adopting `alert-dialog`. `--radius-sm` (12px) is
     what `/metrics`'s banner already used.

  4. `px-4 py-3` → `--space-lg` / `--space-md`. Numeric spacing resolves against Tailwind's
     `--spacing` multiplier rather than Encore's 10-step scale.

  5. `text-sm` REMOVED. Phone surfaces size type off `--ph-text-*` in rem so the guest's browser text
     setting reaches it (`phone-inventory.test.ts` bans absolute font sizes here); `--ph-text-base`
     also matches the deliberate raise `/metrics` made when its banner became the page's most
     important line.
-->
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
		/*
		 * The registry hardcodes `role="alert"`. Encore needs `role="status"` on two of its call sites —
		 * `/metrics`'s no-worker banner and `/admin`'s post-delete notice are POLITE: they report a
		 * standing condition and the outcome of an action the operator just took, neither of which
		 * should interrupt what a screen reader is saying. `phone-inventory.test.ts` inventories every
		 * live region and requires all of them to be polite, so a hardcoded assertive role here would
		 * have been a guard failure rather than a preference.
		 */
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
