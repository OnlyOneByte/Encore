<script lang="ts" module>
	/*
	 * ── DEVIATIONS FROM REGISTRY OUTPUT ───────────────────────────────────────────────────────
	 *
	 * Copied with `shadcn-svelte add button` (v1.6.1, style `vega`), then edited. shadcn is copy-in
	 * precisely so the component is yours to own, so editing is the intended workflow — but an edit
	 * nobody wrote down is an edit an upgrade silently reverts. This block is the diff to re-apply after
	 * any `add --overwrite`, and EVERY item is enforced by a named test, so a reverted edit reds rather
	 * than shipping.
	 *
	 * 1. `transition-all` REMOVED from the base class. Encore does not want it: it animates layout
	 * properties, `components/motion.test.ts` bans the name across the whole tree, and the incumbent
	 * `.btn-accent` had no transition at all — so removing it is also what makes the migration
	 * invisible. That guard's net arm is what caught it here, and is what will catch its return.
	 * 2. `size: icon` is `size-tap`, not `size-9`. The registry's 36px is under this app's 44px `--tap`
	 * standard; `size-tap` reads the token rather than restating the number. Guarded by
	 * `touch-targets.test.ts`. `grid place-items-center` comes with it because Icon renders as a block
	 * and without a centring context the mark sits off-centre (the reported off-centre X).
	 * 3. A `press` axis and its scoped styles at the bottom of this file — three incumbent behaviours
	 * over one shape. `touch-action: none` on the grab case is load-bearing for the drag:
	 * without it the browser claims the vertical gesture for scrolling and `onpointerdown` never
	 * fires. `cursor: grab` must stay pinned to this control and never reach a row (XR-PH-17,
	 * guarded by `reorder-mode-source-836.test.ts`).
	 * 4. An `iconPrimary` variant for NowPlayingDrawer's transport (NowPlayingHero's, before the drawer
	 * replaced it): accent fill while actionable, falling
	 * back to the icon surface when disabled, which is what says the transport is dead not idle.
	 * 5. Three more role-named variants for the phone home's controls — `identity`, `keycap`, `eyebrow`.
	 * Each is documented at its own entry below, and each exists because a REQUIREMENT of its call site
	 * contradicts the base: `shrink-0` defeats an ellipsis, and `whitespace-nowrap` defeats the 320px
	 * reflow floor for a button whose label is one unbreakable word.
	 *
	 * NOT a deviation: colour. `app.css`'s semantic layer aliases `--primary`, `--muted`, `--ring` and
	 * friends onto Encore's tokens, so every stock class here resolves untouched. That layer is why this
	 * diff is four items instead of a rewrite.
	 */
	import { type VariantProps, tv } from 'tailwind-variants';
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

	export const buttonVariants = tv({
		/*
		 * `no-underline text-inherit` ARE HERE BECAUSE A BUTTON MAY RENDER AS AN ANCHOR, and six of them
		 * do — the identity control, the page-header back arrow, the drawer's "···" door, the settings
		 * links. Tailwind's Preflight is OFF in this app (app.css is `source(none)`), so the UA's own
		 * `a:link` style is never reset: every one of those was painted underlined, in the browser's link
		 * colour, instead of taking the surface it was given. The phone header's own name button was the
		 * visible case — a violet, underlined username sitting in a row of `--ink` text.
		 *
		 * On the BASE rather than on the identity variant, because it is a property of being a control
		 * that happens to navigate, not of one call site. `tailwind-merge` resolves the colour against a
		 * variant that sets its own (`iconPrimary`'s `text-[var(--on-accent)]`, `keycap`'s ink pair) by
		 * keeping the variant's, so this changes nothing for a variant that already had an opinion — it
		 * only stops an anchor falling back to the UA's.
		 */
		base: "rounded-md border border-transparent bg-clip-padding text-sm font-medium focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap outline-none select-none no-underline text-inherit disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				iconPrimary:
					'bg-[var(--accent)] text-[var(--on-accent)] disabled:bg-[var(--card2)] disabled:text-[var(--ink-dim)] disabled:opacity-35',
				/*
				 * The phone home's identity control (name + colour dot -> /settings?tab=you). Role-named
				 * like `iconPrimary` above, because what it encodes is a call site's requirement rather
				 * than a general appearance.
				 *
				 * It exists for ONE reason the stock variants cannot give: the base sets `shrink-0`, and
				 * this control wraps a name that must ELLIPSIS. A non-shrinking button inside the header's
				 * flex row cannot narrow, so `text-overflow` never engages and a long name pushes the gear
				 * off the row instead. `min-w-0 shrink` restores the flex minimum the ellipsis depends on.
				 * `justify-start` because the label leads; `font-normal` and `text-[length:inherit]`
				 * because the name's size is the header's, not the button's (the old rule said
				 * `font: inherit`).
				 *
				 * `min-h-tap` because it declares no height of its own and so inherited the default
				 * `h-9` — 36px, measured on the render by `gate:measured`, which is the four pixels
				 * XR-VER-09 is about. It is the phone's only route to the profile editor, so it is not a
				 * control a thumb can afford to miss. The header's row height is set by the brand line
				 * beside it, so raising this one to the floor changes no layout.
				 */
				identity:
					'min-w-0 shrink justify-start gap-[var(--space-sm)] px-[var(--space-xs)] font-normal text-[length:inherit] hover:bg-muted min-h-tap',
				/*
				 * The +/- semitone pair. Two requirements the stock variants actively fight:
				 *
				 * 1. The base sets `whitespace-nowrap`, but "semitone" is one unbreakable token and at
				 *    200% text a full-width button is still narrower than it — so nowrap forced the row,
				 *    and the sheet around it, past 320px. `whitespace-normal` plus
				 *    `[overflow-wrap:anywhere]` lets the word break instead of the layout (XR-PH-02).
				 * 2. DASHED means inert. The incumbent drew a dashed border while the shift was clamped
				 *    at +/-7 and switched to solid when actionable, which reads as "no further" without
				 *    relying on colour. Expressed here as the RESTING state upgraded by `enabled:`,
				 *    rather than as a `disabled:` override, so it does not depend on utility ordering to
				 *    beat the base's own disabled rule.
				 */
				keycap:
					'border-dashed border-[var(--line-strong)] bg-transparent text-[var(--ink-dim)] whitespace-normal [overflow-wrap:anywhere] enabled:border-solid enabled:border-[var(--line)] enabled:text-[var(--ink)]',
				/*
				 * A disclosure trigger styled as a section eyebrow — the "Vocal range" toggle. Uppercase,
				 * letter-spaced and 2xs, which is a LABEL treatment rather than a button treatment, so no
				 * stock variant is close. `whitespace-normal` for the same 200%-text reason as `keycap`.
				 */
				eyebrow:
					'justify-start gap-[7px] px-[var(--space-3xs)] text-[length:var(--ph-text-2xs)] font-bold tracking-[0.14em] uppercase whitespace-normal text-[var(--ink-dim)] hover:text-[var(--ink)] hover:bg-transparent',
				/*
				 * SongRow's "add a turn" action. The pair it belongs to is the app's most load-bearing
				 * hierarchy: `iconPrimary` (accent fill, sparkle) is the expensive minute-long process,
				 * this is the free instant queue-add. They must not converge — an earlier version had the
				 * weight INVERTED, putting the primary fill on the dead-end action, and the comment in
				 * SongRow records why that was worse than a styling nit.
				 *
				 * Green ink on the icon surface rather than a fill: it reads as available without
				 * competing with the accent. `--ok` is the readiness colour the row's "Karaoke ready"
				 * badge already uses, so the button agrees with the chip beside it.
				 */
				iconReady: 'bg-[var(--card2)] border-[var(--ok)] text-[var(--ok)]',
				default: 'bg-primary text-primary-foreground hover:bg-primary/80',
				outline:
					'border-border bg-background shadow-xs hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
				secondary:
					'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
				ghost:
					'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50',
				destructive:
					'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40',
				link: 'text-primary underline-offset-4 hover:underline'
			},
			size: {
				/*
				 * Fills its column — a form's one commit control. This is a VARIANT rather than a
				 * `class="w-full"` at the call site, and that is not style preference: app.css sets
				 * `source(none)` with a single `@source` over this directory, so a utility written in a
				 * page is scanned by nothing and emitted nowhere. S1 of the shadcn migration briefly shipped that bug — the
				 * settings Save and join Start-singing buttons kept their width only by accident,
				 * because a vendored component elsewhere happened to use the same class.
				 */
				block: 'w-full min-h-tap',
				/*
				 * A content-hugging size that CLEARS THE TAP FLOOR, and it exists because none of the
				 * registry's sizes do: `xs` is h-6 (24px), `sm` h-8 (32px), `default` h-9 (36px), `lg` h-10
				 * (40px) — all under Encore's `--tap: 44px`. Only `icon` (`size-tap`) and `block`
				 * (`min-h-tap`) comply, and both force a shape: a square, or the full column width.
				 *
				 * So every inline control that is neither — the reorder Done/Cancel, the search-escape
				 * "Show all N", the back-to-queue link — had no compliant size to migrate onto, and reaching
				 * for `sm` would have silently dropped a 44px hand-rolled control to 32px. That is the
				 * regression touch-targets.test.ts caught during the phone-home migration.
				 *
				 * `min-h-tap`, not `h-tap`: the label must be allowed to grow the box at 200% text rather
				 * than overflow a fixed height.
				 */
				tap: 'min-h-tap gap-[var(--space-xs)] px-[var(--space-xl)]',
				/*
				 * The same shape one step up, for a page whose primary action IS the page's purpose — the
				 * landing screen's join button. Padding and type keep it well over the tap floor, and the
				 * radius is `--radius` (18px), the card/sheet radius rather than the button's own 10px,
				 * because at full width it reads as a surface.
				 *
				 * rebase note: this arrived on main as `size="blockLg" shape="lg"` — a separate
				 * `shape` axis that existed only to carry a radius. Folded into one size here rather than
				 * reintroducing that axis: the registry's sizes already own their radius, and a second
				 * axis for it would be two ways to say one thing.
				 */
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
