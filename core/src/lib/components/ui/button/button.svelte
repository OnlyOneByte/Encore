<script lang="ts" module>
	/* Vendored from the shadcn-svelte registry, then edited. Each edit is the diff to re-apply after any
	   `add --overwrite`, and each is pinned by a guard so a reverted edit reds rather than shipping: `transition-all` is
	   absent from the base (it animates layout and cannot honour Reduce Motion), `size: icon` is `size-tap` because every
	   registry size is under the 44px floor, the `press` axis, `outline`'s boundary is --control-line rather than the
	   registry's --line-valued `border-border`/`dark:border-input` (SC 1.4.11), and the role-named variants below. See
	   docs/FRONTEND.md#shared-components. */
	import { type VariantProps, tv } from 'tailwind-variants';
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

	export const buttonVariants = tv({
		/* `no-underline text-inherit` are on the BASE because a Button may render as an anchor and Preflight is off, so
		   the UA's `a:link` style is never reset — every anchor-shaped button would paint underlined in the browser's link
		   colour. `tailwind-merge` keeps a variant's own colour over these. */
		base: "min-h-tap rounded-md border border-transparent bg-clip-padding text-[length:var(--ph-text-md)] font-medium focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap outline-none select-none no-underline text-inherit disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				/* THE ONE QUEUEING ACTION, on every SongRow. It used to be two variants — this accent fill for "make karaoke",
				   and an `iconReady` green outline for "add a turn" — and the split was wrong on both axes it claimed. The green
				   was --ok, which is simultaneously that row's READINESS signal, so the screen's primary action wore a status
				   colour and read as a badge. The outline also sat on the READY row, where adding a turn IS the point, so the
				   weights were inverted. And because `canProcess` (src/lib/readiness.ts) admits only 'unacquired' and 'failed',
				   the green + also painted on a PROCESSING row, asserting readiness on a song that is by definition not ready.
				   One verb, one fill. The COST difference rides on the MARK (sparkle = strips the vocals first, plus = instant)
				   and on the aria-label, which is where SongRow already says it in words. --ok is now reserved for the ready
				   STATE and appears once per row, in the worded pill. Measured: --accent on the --card row surface is 3.38:1,
				   over SC 1.4.11's 3:1 for a control boundary, and --on-accent on --accent is 5.09:1. */
				iconPrimary:
					'bg-[var(--accent)] text-[var(--on-accent)] disabled:bg-[var(--card2)] disabled:text-[var(--ink-dim)] disabled:opacity-35',
				/* The phone home's identity control (name + colour dot to /settings/you). `min-w-0 shrink` cancels the
				   base's `shrink-0`, which is what the name's ellipsis depends on — a non-shrinking button cannot narrow.
				   `min-h-tap` because it declares no height and would otherwise inherit the 36px default. */
				identity:
					'min-w-0 shrink justify-start gap-[var(--space-sm)] px-[var(--space-xs)] font-normal text-[length:inherit] hover:bg-muted min-h-tap',
				/* The +/- semitone pair. `whitespace-normal` cancels the base's nowrap: "semitone" is one unbreakable token,
				   and at 200% text nowrap forces the row past the 320px reflow floor. DASHED means inert, written as the RESTING
				   state upgraded by `enabled:` rather than a `disabled:` override, so it does not depend on utility order.
				   --control-line and NOT --line on the ENABLED state: this is the one variant with `bg-transparent`, so the
				   border is the entire control — SC 1.4.11's 3:1 applies to it exactly as it does to a text field, and --line
				   was 1.23:1 on the --card (--popover) surface the keycaps sat on when this was measured, inside the now-deleted
				   now-playing sheet. It also fixes an inversion that fell out of the old
				   pair: the live keycap's border (--line, 1.23:1) was DIMMER than its own inert one (--line-strong, 1.57:1),
				   so the enabled control read as the weaker of the two. --control-line is 3.97:1 there. The dashed inert state
				   KEEPS --line-strong: 1.4.11 exempts inactive components by name, and it now sits correctly below the live
				   border rather than above it. */
				keycap:
					'border-dashed border-[var(--line-strong)] bg-transparent text-[var(--ink-dim)] whitespace-normal [overflow-wrap:anywhere] enabled:border-solid enabled:border-[var(--control-line)] enabled:text-[var(--ink)]',
				/* A disclosure trigger styled as a section eyebrow — a LABEL treatment, so no stock variant
				   is close. `whitespace-normal` for the same 200%-text reason as `keycap`. `bg-transparent` for the
				   same reason `ghost` carries it, and it was MISSING until this variant got its first caller
				   (/library's `Sort & filter`): it declares only a hover background, so with Preflight off the UA's
				   mid-grey `buttonface` painted the rest of the time and an eyebrow LABEL rendered as a grey slab
				   that reads as disabled. */
				eyebrow:
					'min-h-tap justify-start gap-[7px] px-[var(--space-3xs)] text-[length:var(--ph-text-xs)] font-bold tracking-[0.14em] uppercase whitespace-normal bg-transparent text-[var(--ink-dim)] hover:text-[var(--ink)] hover:bg-transparent',
				/* DISABLED IS A SURFACE SWAP, NEVER A SUBTREE OPACITY: compositing a fill and its ink together against the page
				   quietly drops a label under 4.5:1 while every contrast guard keeps passing (SC 1.4.3). So this swaps to the
				   inert pair --card2 under --ink-dim and cancels the base's inherited `disabled:opacity-50`. */
				default:
					'bg-primary text-primary-foreground hover:bg-primary/80 disabled:bg-[var(--card2)] disabled:text-[var(--ink-dim)] disabled:opacity-100',
				/* --control-line replaces the registry's `border-border` AND its `dark:border-input`, both of which resolve to
				   --line. This variant's only fill is `bg-background` (--bg), which measures 1.14:1 on the --card surfaces it
				   ships on (ProcessingCard, QueueRow, LyricsReselect, /settings, /admin) — so the fill identifies nothing and
				   the border is the whole control, the same case as `keycap`. The `dark:` spelling has to go too, not just be
				   left alongside: `dark:` here is the plain prefers-color-scheme media query (no `.dark` class exists in this
				   app), so leaving `dark:border-input` would put the boundary back on --line for exactly the devices that ask
				   for a dark UI. The `bg-input/30` FILLS stay on --input: --input remains aliased to --line because it feeds
				   fills as well as boundaries, so retargeting the token would be a fill change app-wide rather than a
				   boundary fix. See docs/FRONTEND.md's --control-line rule. */
				outline:
					'border-[var(--control-line)] bg-background shadow-xs hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:bg-input/30 dark:hover:bg-input/50',
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
				   because app.css scans only this directory for utilities and one written in a page is emitted nowhere.
				   A block cannot grow past its column, so at 200% text on a 320px phone its row has to fold instead:
				   `flex-wrap` drops a trailing Badge or note to its own line rather than centring the excess out of both
				   sides of the box, and `whitespace-normal` (as on `keycap`) lets a label longer than the box wrap.
				   Without them p15 measured `/settings` over by 28px and `/settings/server` by 52px. The row gap exists
				   only once a row has wrapped; the inset and `text-center` keep a wrapped label off the border, centred. */
				block: 'w-full min-h-tap flex-wrap gap-y-[var(--space-3xs)] whitespace-normal px-[var(--space-sm)] text-center',
				/* A content-hugging size that clears the 44px tap floor, which no registry size does (they run 24–40px).
				   Reaching for `sm` silently drops a compliant control to 32px. `min-h-tap` rather than `h-tap`, so the label can
				   grow the box at 200% text instead of overflowing it. */
				/* The inline inset is `lg`, DOWN from the retired `xl` (14) rather than up to `2xl`. Of this size's twelve
				   call sites, three are `{#each}` groups inside /library's `flex-wrap` `.chips` rows, so the rendered
				   count grows with the library and a chip's label can be a whole artist name — 4px per chip is width
				   this app has to defend under SC 1.4.10 at 320px, and narrowing can only ever help there. `blockLg`
				   below keeps `2xl` because it is a full-width SURFACE, not a chip. */
				tap: 'min-h-tap gap-[var(--space-xs)] px-[var(--space-lg)]',
				/* The same shape one step up, for a page whose primary action IS the page's purpose. The
				   radius is --radius, the card/sheet one, because at full width it reads as a surface. */
				blockLg: 'w-full p-[var(--space-2xl)] text-[length:var(--ph-text-lg)] rounded-[var(--radius)]',
				default:
					'h-9 gap-1.5 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-[length:var(--ph-text-xs)] in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
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
