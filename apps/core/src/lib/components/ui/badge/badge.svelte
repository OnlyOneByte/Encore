<!--
  ── ENCORE DEVIATIONS (#913 S6) ───────────────────────────────────────────────────────────────────
  The registry's appearance and tone set are REPLACED by Encore's chip, because the chips this
  migrates are a semantic STATE system rather than decoration: eleven rules in SongRow mapping a
  song's readiness and kind onto `--ok` / `--warn` / `--danger` / `--accent-ink`, each a certified
  surface+border+ink triple. shadcn offers four generic tones, none of which carry those meanings.

  1. `transition-all` and `transition-colors` removed. motion.test.ts bans motion utility names
     tree-wide — the same deletion already applied to every other vendored component here.
  2. `h-5 … text-xs` replaced by Encore's own metrics, so no chip changes size.
  3. Appearance is scoped CSS, not utilities: `app.css` sets `source(none)` with a single `@source`
     over this directory, and scoped CSS needs no minting at all.
  4. A `wrap` axis exists because ONE chip carries a phrase instead of a token; the reason is on the
     variant, taken from #857.
-->
<script lang="ts" module>
	import { type VariantProps, tv } from "tailwind-variants";

	export const badgeVariants = tv({
		base: "encore-chip",
		variants: {
			variant: {
				/*
				 * Encore's tones, not the registry's default/secondary/destructive/outline. Each is a
				 * CERTIFIED triple — surface, border and ink set together, never separately — lifted
				 * verbatim from SongRow's chip rules so the migration changes no colour.
				 */
				neutral: "",
				ok: "encore-chip-ok",
				warn: "encore-chip-warn",
				bad: "encore-chip-bad",
				accent: "encore-chip-accent",
				tag: "encore-chip-accent encore-chip-tag",
			},
			/*
			 * A chip that carries a PHRASE rather than a token must wrap (#857). Every other chip here is
			 * short enough to fit one line at 200% text; "Longer than a song" is ~230px doubled, wider
			 * than the row holds, and a blanket `white-space: nowrap` made its min-content width its FULL
			 * width — so it could not shrink and pushed the browse page past a 320px viewport.
			 */
			wrap: {
				true: "encore-chip-wrap",
				false: "",
			},
		},
		defaultVariants: {
			variant: "neutral",
			wrap: false,
		},
	});

	export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAnchorAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		href,
		class: className,
		variant = "neutral",
		wrap = false,
		children,
		...restProps
	}: WithElementRef<HTMLAnchorAttributes> & {
		variant?: BadgeVariant;
		wrap?: boolean;
	} = $props();
</script>

<svelte:element
	this={href ? "a" : "span"}
	bind:this={ref}
	data-slot="badge"
	{href}
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
		font-size: 0.65rem;
		font-weight: 600;
		padding: var(--space-3xs) 7px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--card2);
		color: var(--ink-dim);
		white-space: nowrap;
	}
	/*
	 * Claw back list height on the narrowest phone. A guest reviewing the 320px frame could see only
	 * about four songs before the player bar and called it irritating to scroll — and comparing uploads
	 * is the entire point, so how many fit at once IS the feature. Smaller chips buy roughly a fifth of
	 * a row back without shrinking the title or the 44px target.
	 *
	 * This lived in SongRow until #913 S6. It is the CHIP's own metrics at a viewport, so it moved with
	 * the chip; a scoped rule in that row can no longer reach the element this component renders.
	 */
	@media (max-width: 380px) {
		.encore-chip {
			font-size: 0.62rem;
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
	/*
	 * A quiet accent wash — enough to read as a set apart from the neutral fact chips beside it, but
	 * never a status colour: a tag is a describing word, not a warning. Reuses accent tokens rather
	 * than a new hex.
	 */
	/* A tag is a describing word, so it reads as a word: capitalised, never a status colour. */
	.encore-chip-tag {
		text-transform: capitalize;
	}
	.encore-chip-accent {
		background: var(--card-tint2);
		border-color: var(--line-tint);
		color: var(--accent-ink);
	}
</style>
