<script lang="ts" module>
	/* Vendored from the shadcn-svelte registry, then edited. Each edit is the diff to re-apply after any
	   `add --overwrite`, and each is pinned by a guard so a reverted edit reds rather than shipping: `transition-all` is
	   absent from the base (it animates layout and cannot honour Reduce Motion), `size: icon` is `size-tap` because every
	   registry size is under the 44px floor, the `press` axis, and the role-named variants below. See
	   docs/FRONTEND.md#shared-components. */
	import { type VariantProps, tv } from 'tailwind-variants';
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

	export const buttonVariants = tv({
		/* `no-underline text-inherit` are on the BASE because a Button may render as an anchor and Preflight is off, so
		   the UA's `a:link` style is never reset — every anchor-shaped button would paint underlined in the browser's link
		   colour. `tailwind-merge` keeps a variant's own colour over these. */
		base: "rounded-md border border-transparent bg-clip-padding text-sm font-medium focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap outline-none select-none no-underline text-inherit disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				iconPrimary:
					'bg-[var(--accent)] text-[var(--on-accent)] disabled:bg-[var(--card2)] disabled:text-[var(--ink-dim)] disabled:opacity-35',
				/* The phone home's identity control (name + colour dot to /settings?tab=you). `min-w-0 shrink` cancels the
				   base's `shrink-0`, which is what the name's ellipsis depends on — a non-shrinking button cannot narrow.
				   `min-h-tap` because it declares no height and would otherwise inherit the 36px default. */
				identity:
					'min-w-0 shrink justify-start gap-[var(--space-sm)] px-[var(--space-xs)] font-normal text-[length:inherit] hover:bg-muted min-h-tap',
				/* The +/- semitone pair. `whitespace-normal` cancels the base's nowrap: "semitone" is one unbreakable token,
				   and at 200% text nowrap forces the row past the 320px reflow floor. DASHED means inert, written as the RESTING
				   state upgraded by `enabled:` rather than a `disabled:` override, so it does not depend on utility order. */
				keycap:
					'border-dashed border-[var(--line-strong)] bg-transparent text-[var(--ink-dim)] whitespace-normal [overflow-wrap:anywhere] enabled:border-solid enabled:border-[var(--line)] enabled:text-[var(--ink)]',
				/* A disclosure trigger styled as a section eyebrow — a LABEL treatment, so no stock variant
				   is close. `whitespace-normal` for the same 200%-text reason as `keycap`. `bg-transparent` for the
				   same reason `ghost` carries it, and it was MISSING until this variant got its first caller
				   (/library's `Sort & filter`): it declares only a hover background, so with Preflight off the UA's
				   mid-grey `buttonface` painted the rest of the time and an eyebrow LABEL rendered as a grey slab
				   that reads as disabled. */
				eyebrow:
					'justify-start gap-[7px] px-[var(--space-3xs)] text-[length:var(--ph-text-2xs)] font-bold tracking-[0.14em] uppercase whitespace-normal bg-transparent text-[var(--ink-dim)] hover:text-[var(--ink)] hover:bg-transparent',
				/* SongRow's "add a turn". It must NOT converge with `iconPrimary`: that accent fill is the expensive minute-long
				   process, this is the free instant queue-add, and inverting the weight puts the primary fill on the dead-end
				   action. `--ok` is the readiness colour the row's "Karaoke ready" badge already uses. */
				iconReady: 'bg-[var(--card2)] border-[var(--ok)] text-[var(--ok)]',
				/* DISABLED IS A SURFACE SWAP, NEVER A SUBTREE OPACITY: compositing a fill and its ink together against the page
				   quietly drops a label under 4.5:1 while every contrast guard keeps passing (SC 1.4.3). So this swaps to the
				   inert pair --card2 under --ink-dim and cancels the base's inherited `disabled:opacity-50`. */
				default:
					'bg-primary text-primary-foreground hover:bg-primary/80 disabled:bg-[var(--card2)] disabled:text-[var(--ink-dim)] disabled:opacity-100',
				outline:
					'border-border bg-background shadow-xs hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
				secondary:
					'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
				/* `bg-transparent` is a defect fix, not a preference: the registry's ghost paints only on hover, which assumes
				   Preflight zeroed `button { background }`. Preflight is off here, so a ghost BUTTON otherwise shows the UA's
				   mid-grey `buttonface` slab. It belongs on the variant, not a call site. */
				ghost:
					'bg-transparent hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50',
				destructive:
					'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40',
				link: 'text-primary underline-offset-4 hover:underline'
			},
			size: {
				/* Fills its column — a form's one commit control. A VARIANT rather than a `class="w-full"` at the call site,
				   because app.css scans only this directory for utilities and one written in a page is emitted nowhere. */
				block: 'w-full min-h-tap',
				/* A content-hugging size that clears the 44px tap floor, which no registry size does (they run 24–40px).
				   Reaching for `sm` silently drops a compliant control to 32px. `min-h-tap` rather than `h-tap`, so the label can
				   grow the box at 200% text instead of overflowing it. */
				tap: 'min-h-tap gap-[var(--space-xs)] px-[var(--space-xl)]',
				/* The same shape one step up, for a page whose primary action IS the page's purpose. The
				   radius is --radius, the card/sheet one, because at full width it reads as a surface. */
				blockLg: 'w-full p-[var(--space-2xl)] text-[length:var(--ph-text-lg)] rounded-[var(--radius)]',
				default:
					'h-9 gap-1.5 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: 'h-8 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
				lg: 'h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				icon: 'size-tap grid place-items-center',
				'icon-xs':
					"size-6 rounded-[min(var(--radius-md),8px)] in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
				'icon-sm': 'size-8 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-md',
				'icon-lg': 'size-10'
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default'
		}
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];
	export type ButtonPress = 'none' | 'ink' | 'accent2' | 'grab';

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
		variant = 'default',
		press = 'none',
		size = 'default',
		ref = $bindable(null),
		href = undefined,
		type = 'button',
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
		role={disabled ? 'link' : undefined}
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
		type={type}
		disabled={disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}

<style>
	/* Press feedback as declarations rather than `active:` utilities, because CSS in `src/` is what this repo's source
	   scans can read. `touch-action: none` on the grab case is load-bearing for the reorder drag: without it the browser
	   claims the vertical gesture and `onpointerdown` never fires. `cursor: grab` must stay pinned here and never reach a
	   row (`reorder-mode-source.test.ts`). */
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
