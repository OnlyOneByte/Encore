<script lang="ts" module>
	/*
	 * BUTTON — shadcn-svelte's component, repointed at Encore's tokens (#913 S1).
	 *
	 * Copied in with `shadcn-svelte add button` (v1.6.1, style `vega`), then edited. Three classes of
	 * change were required, and each is a rule for every later component:
	 *
	 * 1. EVERY COLOUR UTILITY WAS REPLACED. The stock variants reference `bg-primary`,
	 *    `text-primary-foreground`, `bg-muted`, `border-ring`, `bg-destructive` and friends — Tailwind
	 *    theme colours that DO NOT EXIST in this app and cannot be made to. `app.css`'s `@theme inline`
	 *    block registers no colour on purpose: minting is all-or-nothing per namespace, so
	 *    `--color-accent` would hand out `text-accent` alongside `bg-accent`, and `--accent` measures
	 *    3.10:1 as ink on `--card2` — below AA, which is the whole reason `--accent-ink` exists as a
	 *    separate token. `lib/tailwind-toolchain.test.ts` reds if a colour is ever registered.
	 *    So colour arrives as ARBITRARY VALUES over `:root` tokens — `bg-[var(--accent)]` — which need
	 *    no registration and cannot mint an illegal sibling.
	 *
	 * 2. `transition-all` WAS REMOVED, not narrowed. It is in the stock base class, and
	 *    `components/motion.test.ts` treats it as an offender (#830, XR-VER-15) because it animates
	 *    layout properties. The incumbent `.btn-accent` had NO transition at all — its `:active` was a
	 *    bare `transform: scale(0.96)` — so removing it is also what makes this migration invisible.
	 *    Only `transform`, `opacity`, `background`, `background-color`, `color` and `box-shadow` are
	 *    composited enough for that guard; a later variant that wants motion names one of those.
	 *
	 * 3. GEOMETRY IS A VARIANT, NEVER A CALL-SITE CLASS. `app.css` sets Tailwind to
	 *    `source(none)` plus a single `@source '../src/lib/components/ui/**\/*.svelte'`, so utilities are
	 *    minted from THIS DIRECTORY ONLY. A `class="w-full"` written at a call site is scanned by
	 *    nothing and emitted nowhere — verified by building with one and finding no `.w-full` rule in
	 *    any of the 16 built CSS assets. Svelte's scoped CSS cannot reach in here either: a class the
	 *    page passes down gets no scoping attribute for the page's own scoped style block. Both roads are
	 *    closed, so a call site that needs a different shape asks for a VARIANT, and page-level layout
	 *    (a margin that positions the button in its column, a width that fills a form) stays on a
	 *    wrapper element in the page, where scoped CSS still works.
	 *
	 * Variants are deliberately minimal: exactly the two shapes the app has today, `accent` and `icon`.
	 * The stock `outline` / `secondary` / `ghost` / `destructive` / `link` were dropped rather than
	 * repointed — an unused variant is invented API, and each would need its own contrast decision.
	 */
	import { type VariantProps, tv } from 'tailwind-variants';
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

	export const buttonVariants = tv({
		base: 'inline-flex shrink-0 cursor-pointer items-center justify-center gap-[var(--space-sm)] border-0 whitespace-nowrap outline-none select-none disabled:cursor-default [&_svg]:pointer-events-none [&_svg]:shrink-0',
		variants: {
			variant: {
				/* The incumbent `.btn-accent`: the fill and its only legal ink, per #840's per-stop pair. */
				accent: 'bg-[var(--accent)] font-bold text-[var(--on-accent)] disabled:opacity-45',
				/*
				 * The incumbent `.icon-btn`: a 44px box on `--card2` with a dimmed glyph. `place-items`
				 * over `items-center` is load-bearing — Icon renders as a block, and without a centring
				 * context the mark sits off-centre (the reported off-centre X).
				 */
				icon: 'grid size-tap place-items-center border border-[var(--line)] bg-[var(--card2)] text-[20px] text-[var(--ink-dim)] disabled:opacity-35'
			},
			shape: {
				/* `--radius-btn` (10px). The incumbent hardcoded `10px`; this names it instead. */
				btn: 'rounded-[var(--radius-btn)]',
				/* `--radius-sm` (12px), the icon button's box. */
				sm: 'rounded-[var(--radius-sm)]',
				/* `--radius` (18px), the card/sheet radius, for a full-width primary button. */
				lg: 'rounded-[var(--radius)]'
			},
			size: {
				/* The icon button is a fixed 44px box; `variant: icon` already sizes it. */
				none: '',
				/*
				 * A full-width form commit. Reproduces settings' `.save`: fills its column, clears the
				 * 44px tap floor by padding rather than by height, base phone type.
				 */
				block: 'w-full min-h-tap p-[13px] text-[length:var(--ph-text-base)]',
				/*
				 * The same shape one step up, for a page whose primary action is the page's purpose —
				 * join's `.submit`. Padding and type keep it well over the tap floor.
				 */
				blockLg: 'w-full p-[var(--space-2xl)] text-[length:var(--ph-text-lg)]'
			}
		},
		defaultVariants: { variant: 'accent', shape: 'btn', size: 'none' }
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonShape = VariantProps<typeof buttonVariants>['shape'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			shape?: ButtonShape;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = 'accent',
		shape = 'btn',
		size = 'none',
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
		class={cn(buttonVariants({ variant, shape, size }), className)}
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
		class={cn(buttonVariants({ variant, shape, size }), className)}
		type={type}
		disabled={disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}

<style>
	/*
	 * THE ACTIVE PRESS IS A DECLARATION, NOT A UTILITY, AND THAT IS THE RULE (#913 S1).
	 *
	 * `active:scale-[0.96]` is what the incumbent `.btn-accent:active` did, and it is what shadcn would
	 * reach for — but `components/motion.test.ts` flags a motion utility that is not accompanied by a
	 * transition whose properties are all composited (#830, XR-VER-15), and the incumbent had no
	 * transition at all. Adding one to satisfy the guard would change the feel; widening the guard's
	 * allowlist to silence it is the move XR-VER-06 explicitly forbids. So the motion is expressed here,
	 * where the DECLARATION scans can see `transform` and pass it on its merits.
	 *
	 * This is also the copy-in rationale doing its job rather than being talked about: the reason
	 * shadcn was chosen over a headless dependency is that a copied component's CSS lands in `src/`,
	 * where this repo's ~30 source-scan guards still reach it. A scoped style block in a copied component
	 * is therefore not a retreat from the library — it is the property that made the library adoptable.
	 */
	[data-slot='button']:active:not(:disabled) {
		transform: scale(0.96);
	}
</style>
