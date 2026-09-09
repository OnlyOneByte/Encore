<script lang="ts" module>
	/*
	 * ── DEVIATIONS FROM REGISTRY OUTPUT (#913) ───────────────────────────────────────────────────────
	 *
	 * Copied with `shadcn-svelte add button` (v1.6.1, style `vega`), then edited. shadcn is copy-in
	 * precisely so the component is yours to own, so editing is the intended workflow — but an edit
	 * nobody wrote down is an edit an upgrade silently reverts. This block is the diff to re-apply after
	 * any `add --overwrite`, and EVERY item is enforced by a named test, so a reverted edit reds rather
	 * than shipping.
	 *
	 * 1. `transition-all` REMOVED from the base class. Encore does not want it: it animates layout
	 *    properties, `components/motion.test.ts` bans the name across the whole tree, and the incumbent
	 *    `.btn-accent` had no transition at all — so removing it is also what makes the migration
	 *    invisible. That guard's net arm is what caught it here, and is what will catch its return.
	 * 2. `size: icon` is `size-tap`, not `size-9`. The registry's 36px is under this app's 44px `--tap`
	 *    standard; `size-tap` reads the token rather than restating the number. Guarded by
	 *    `touch-targets.test.ts`. `grid place-items-center` comes with it because Icon renders as a block
	 *    and without a centring context the mark sits off-centre (the reported off-centre X).
	 * 3. A `press` axis and its scoped styles at the bottom of this file — three incumbent behaviours
	 *    over one shape. `touch-action: none` on the grab case is load-bearing for the #836 drag:
	 *    without it the browser claims the vertical gesture for scrolling and `onpointerdown` never
	 *    fires. `cursor: grab` must stay pinned to this control and never reach a row (XR-PH-17,
	 *    guarded by `reorder-mode-source-836.test.ts`).
	 * 4. An `iconPrimary` variant for NowPlayingHero's transport: accent fill while actionable, falling
	 *    back to the icon surface when disabled, which is what says the transport is dead not idle.
	 *
	 * NOT a deviation: colour. `app.css`'s semantic layer aliases `--primary`, `--muted`, `--ring` and
	 * friends onto Encore's tokens, so every stock class here resolves untouched. That layer is why this
	 * diff is four items instead of a rewrite.
	 */
	import { type VariantProps, tv } from "tailwind-variants";
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

	export const buttonVariants = tv({
		base: "rounded-md border border-transparent bg-clip-padding text-sm font-medium focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				iconPrimary:
					"bg-[var(--accent)] text-[var(--on-accent)] disabled:bg-[var(--card2)] disabled:text-[var(--ink-dim)] disabled:opacity-35",
				default: "bg-primary text-primary-foreground hover:bg-primary/80",
				outline: "border-border bg-background shadow-xs hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
				secondary: "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
				ghost: "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
				destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default: "h-9 gap-1.5 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
				xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
				lg: "h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
				icon: "size-tap grid place-items-center",
				"icon-xs": "size-6 rounded-[min(var(--radius-md),8px)] in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-8 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-md",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];
	export type ButtonPress = "none" | "ink" | "accent2" | "grab";

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			press?: ButtonPress;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		press = "none",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		data-press={press}
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		data-press={press}
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}

<style>
	/*
	 * PRESS FEEDBACK AS DECLARATIONS (deviation 3), not `active:` utilities: motion.test.ts judges a
	 * motion utility with no composited transition beside it, the incumbents had no transition at all,
	 * and CSS in `src/` is what this repo's source scans can read — the reason copy-in beat a headless
	 * dependency.
	 */
	[data-press='none']:active:not(:disabled) {
		transform: scale(0.96);
	}
	[data-press='ink']:not(:disabled):active {
		transform: scale(0.9);
		color: var(--ink);
	}
	[data-press='accent2']:not(:disabled):active {
		transform: scale(0.9);
		color: var(--accent2);
	}
	[data-press='grab'] {
		cursor: grab;
		touch-action: none;
	}
	[data-press='grab']:active {
		cursor: grabbing;
		color: var(--ink);
	}
</style>
