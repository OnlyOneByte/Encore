<script lang="ts">
	/*
	 * THE SHELL EVERY SETTINGS SCOPE WEARS — the heading, the scope line, the one failure banner, and the card grid.
	 *
	 * It exists because `/settings` is three ROUTES now (You, this room, this machine) and the measured rulings below
	 * are properties of the SURFACE rather than of any one scope: the three nested measures, the card-to-card section
	 * boundary, the two card-rhythm deltas keyed on `data-slot`, and the landscape claw-back. (The third delta,
	 * `.save-slot`'s, stays on the You scope — it belongs to the one card in settings that has a commit control.)
	 * Three copies of that cascade is three places for it to drift, and the arithmetic in these comments is what
	 * makes it re-derivable at all.
	 *
	 * It also owns the destructive Alert, because the thing that produces `failed` — the optimistic patch in
	 * `$lib/settings-writes.svelte.ts` — is shared by the two scopes that write settings, and a banner about a
	 * refused write belongs at the top of the column it was refused in.
	 *
	 * See docs/FRONTEND.md#settings.
	 */
	import type { Snippet } from 'svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import * as Alert from '$lib/components/ui/alert';
	import type { SettingsScope } from '$lib/settings-scopes';

	let {
		scope,
		back,
		failed = false,
		children
	}: {
		/** Which of the three scopes this route is, read from `$lib/settings-scopes` — the list's one home. */
		scope: SettingsScope;
		/** This scope's ONE door, named. A real anchor, never `history.back()`, so the route stays shareable. */
		back: { href: string; label: string };
		/** From `createSettingsWrites`. The You scope performs no settings write, so it leaves this alone. */
		failed?: boolean;
		/** This scope's cards, rendered straight into `.panel` as its own children. */
		children: Snippet;
	} = $props();
</script>

<svelte:head><title>{scope.label} · Settings · Encore</title></svelte:head>

<div class="settings-page">
	<!-- THE SCOPE IS PART OF THE ADDRESS AND PART OF THE HEADING. The header is `position: sticky`, so this line is
		the one statement of what a change here costs that cannot scroll away from the control being changed —
		measured at the bottom of the old Party panel (scrollY 1267), the sticky header read "Settings", the only card
		title on screen read "Sound", the bottom TabBar lit no tab, and the in-page strip that named the scope was
		1157px above the top of the screen. -->
	<PageHeader title={scope.label} icon="gear" back={back} note="{scope.blastRadius}." />

	<main>
		{#if failed}
			<Alert.Root variant="destructive">
				<Alert.Title>That change could not be saved. Reverted to the last good value.</Alert.Title>
			</Alert.Root>
		{/if}

		<div class="panel">
			{@render children()}
		</div>
	</main>
</div>

<style>
	/* Three nested measures, and the width is spent on a second column of CARDS rather than on wider controls.
	   See docs/FRONTEND.md#settings for what each token means and where each level applies. */
	.settings-page {
		--page-measure: var(--measure-grid);
		/* Not --measure-prose (560): two of those plus the gap need 1132, more than the widest shell, so a prose
			   threshold would never pair anything. At 420 the PANEL pairs from 852 up — which is a panel width and not a
			   viewport one; see the `.panel` note below for what that costs in viewports. */
		--settings-col: 420px;
	}

	main {
		/* Kept in sync with --page-measure above, so the header aligns with this column. */
		max-width: var(--measure-grid);
		margin: 0 auto;
		/* Reserves the dock. No env() term: `TabBar`, the bottom-most element inside the dock, carries the only
			   home-indicator inset, and it reaches this column through --dock-h, so a second one here is the doubled gap. */
		padding: var(--space-md) var(--space-2xl) calc(var(--dock-h, 0px) + 28px);
	}

	/* A label binds to its own control, fixed in the CASCADE rather than by restructuring every row into Field.Root
	   wrappers: the card's gap is the intra-group distance and a label that FOLLOWS a control takes the inter-group
	   distance back as a margin. Keyed on `data-slot`, which survives a re-vendor, and `:global()` because scoped CSS
	   cannot reach ui/card's box — nor, from here, the cards a scope route renders into `.panel`.
	   BOTH SLOTS, because one card-content on this surface does not answer to that name: the machine scope's
	   Collapsible spreads `data-slot="collapsible-content"` over card-content's own literal (see the `hidden` rule
	   below for the full mechanism), so a rule keyed on card-content alone MISSES the three controls behind the
	   disclosure. Measured before this pair: that one nested box kept Card.Content's vendored 24px `gap-6` while all
	   eleven cards' own card-contents ran at 8, which rendered 36px between groups against 20px everywhere else and
	   28px inside a group against 12 — the widest rhythm break on the surface, on the one column a guest has to open
	   a door to reach. Adding the slot took the open disclosure from 318.2px of content to 254.2 and `#reprocessing`
	   from 483.6 to 419.6. `:is()` resolves to its most specific argument, an attribute selector, so the slot match
	   stays 0,1,0 and the cascade below is unchanged. */
	main :global(:is([data-slot='card-content'], [data-slot='collapsible-content'])) {
		gap: var(--space-sm);
	}
	/* THE MARGIN IS A DELTA, NOT THE BOUNDARY. card-content is a FLEX column, and flex does not collapse margins, so
	   what the guest sees is `gap + margin-top` — the 8px above plus this. That arithmetic is the whole reason this
	   spends `lg` and not `4xl`: at `4xl` the rendered boundary was 8 + 20 = 28px against the 24px card-to-card row
	   gap below, so the container read TIGHTER than the thing nested inside it (0.86x) — the same inversion the
	   `.panel` gap was raised to fix, one level down and in the other direction. At `lg` it renders 8 + 12 = 20px,
	   which sits under the 24px container (1.20x). It was `xl` (8 + 14 = 22, 1.09x) until app.css retired that rung;
	   a 32px `.panel` is still refused on purpose.

	   IT IS ALSO A NO-OP IN PORTRAIT, and saying otherwise was the false arithmetic a re-derivation caught:
	   `field-label.svelte` declares `margin: var(--space-lg) 0 var(--space-2xs)` on EVERY `[data-slot='field-label']`
	   in the app, so the 12px is already there and this rule re-declares the same figure at a higher specificity.
	   What that specificity buys is the LANDSCAPE arm at the foot of this block, which could not otherwise claw a
	   label's margin down past the component's own declaration. A corollary: a card's FIRST label is NOT untouched —
	   it is not matched by `* +`, but field-label's own margin still puts 12px above it, measured on #rotation,
	   #sound, #quality, #karaoke, #lyrics-engine, #joining and #you.

	   THE LADDER THIS SURFACE ACTUALLY DRAWS, every figure a rendered sibling-to-sibling distance measured at
	   390x844, NOT a declared one:
	     12px  INSIDE a group, label -> its own control: the 8px gap plus the label's own 4px `margin-bottom`
	     14px  control -> `Field.Description`: the 8px gap plus the description's own 6px `margin-top`
	     20px  BETWEEN groups where the next group leads with a label, `.ring-field` or `.save-slot`: 8 + 12
	     24px  card to card, `.panel`'s row gap
	   AND AN INVERSION, pre-existing and recorded rather than fixed here: where the next group leads with a WRAPPER
	   that carries no label of its own — `.pair` or `.check` — nothing adds a margin, so the boundary renders at the
	   bare 8px gap, TIGHTER than the 12px inside a group. Four sites, measured: #sound slider -> `.check`, #tv
	   `.pair` -> `.check`, #lyrics `.pair` -> `.pair` and slider -> `.pair`. It is the same "one boundary drawn two
	   ways" defect the `.ring-field` arm below exists to fix, and the fix is the same shape — add those wrappers to
	   that arm. It is NOT taken in this pass because it moves four rendered boundaries by 12px each and with them
	   every card height, scrollHeight, reach and co-visibility figure this file and docs/FRONTEND.md record; it wants
	   its own measured pass rather than a re-derivation of thirty numbers inside a comment fix. */
	main :global(:is([data-slot='card-content'], [data-slot='collapsible-content']) > * + [data-slot='field-label']) {
		margin-top: var(--space-lg);
	}
	/* ColourRing's label is a FIELD label (app.css's `.control-label`) but not a `[data-slot='field-label']`, so the
	   rule above cannot reach it and the boundary has to be taken on its WRAPPER, which is the card-content child.
	   Without this the You card drew the same boundary two ways: 20px above a second `Field.Label` (8px gap + 12px)
	   against 8px above the ring. The old dress hid that; one register does not. Unlike the rule above this one is
	   NOT a no-op: `.ring-field` has no margin of its own, so the 12px here is the whole boundary. */
	main :global(:is([data-slot='card-content'], [data-slot='collapsible-content']) > * + .ring-field) {
		margin-top: var(--space-lg);
	}

	/* A DESCRIPTION MAY HOLD AN UNBREAKABLE TOKEN, and one here does: the Joining hint prints the join address
	   (`Empty means <strong>http://192.168.1.20:3000</strong>`), which has no break opportunity. `anywhere` and not
	   `break-word`, because the two differ on exactly the property that matters — `anywhere` reduces the element's
	   MIN-CONTENT width, and `.panel`'s `1fr` track takes its minimum from min-content, so without it one long
	   address widens the whole grid track rather than only its own line. MEASURED at 320px with the root font-size
	   doubled, which is SC 1.4.10's case: a 22-character address rendered 295px of unbreakable text, the panel's
	   track grew from 254px to 295, the document scrolled sideways to 345, and the `internal` badge and the
	   disclosure's state readout were carried out past the right edge with it — three offenders, one cause. */
	main :global([data-slot='field-description']) {
		overflow-wrap: anywhere;
	}

	/* THE DISCLOSURE ACTUALLY CLOSES, and this one rule is what closes it. The machine scope nests a `Card.Content`
	   inside a `Collapsible.Content`, so bits-ui's `{...props}` — `hidden`, `data-state` and its own `data-slot` —
	   spreads onto card-content's box AFTER that component's literal `data-slot="card-content"`, which is why the
	   element carrying `hidden` reports `data-slot="collapsible-content"`.
	   WHY `hidden` WAS NOT ENOUGH: app.css imports `tailwindcss/theme.css` and `tailwindcss/utilities.css` only, so
	   Preflight — which is where Tailwind's own `[hidden]:where(:not([hidden='until-found'])) { display: none }`
	   lives — is never loaded, and `Card.Content`'s own `flex` utility is AUTHOR origin, which out-ranks the UA
	   sheet's `[hidden] { display: none }`. Measured before this rule: `aria-expanded="false"`, `hidden` present,
	   computed `display: flex`, 318.2px of content, and `#upgrade-model` a live 228x44 box — a door reading
	   "Re-process off" directly above the three controls it claimed to be hiding, and `document.scrollHeight`
	   identical in both states. THAT 318.2 IS THE 24px-GAP COLUMN: the gap rule above has since named this slot too,
	   so the same state measures 254.2 today, and closing the door now reclaims 255px rather than 319 (scrollHeight
	   1720 closed against 1975 open). */
	main :global([data-slot='collapsible-content'][hidden]) {
		display: none;
	}

	.panel {
		/* A grid, not a flex column: `auto-fit` collapses the empty tracks, so at one column this is the plain stack.
			   `align-items: start` matters — `stretch` would pad the shorter card out to its neighbour. */
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--settings-col)), 1fr));
		align-items: start;
		/* TWO VALUES, and the split is the point. The ROW gap is the card-to-card SECTION boundary and takes the
			   section rung. Both figures below are RENDERED boundaries, not declared margins, because the margin above
			   is a delta on card-content's 8px flex gap: at --space-lg a card boundary was 12px while a group boundary
			   INSIDE one card rendered at 28px (8 + 20), so the container read less than half the thing nested in it —
			   0.43x. It is 24px against 20px (8 + 12) now, 1.20x; the intra-card rule came down 4xl -> xl to get there,
			   then to lg when app.css retired `xl`. The COLUMN gap stays --space-lg so the pairing threshold stays the
			   measured 2*420 + 12 = 852px of PANEL width that docs/FRONTEND.md records; 24px both ways would move it to
			   864. A panel is `--max-w` less the shell gutter and this column's own inset — 64px at every width — so
			   852 of panel needs 916 of `--max-w`, and only the --bp-lg step (1080) clears it. MEASURED one track at a
			   time across the ladder: 256px at 320, 316 at 380, 326 at 390 (viewport-bound, under the cap), then 416px
			   from 520 through 767 where `--max-w` 480 binds, 696px from 768 through 1199 where it steps to 760, and
			   `502px 502px` from 1200 where it steps to 1080. 416 AND NOT 696 AT 520 — the step is at --bp-md, not at
			   --bp-sm, which is the same 480 -> 760 rung docs/FRONTEND.md records for the findbox. No phone and no
			   portrait tablet ever pairs. */
		gap: var(--space-5xl) var(--space-lg);
	}
	/* Anything in a panel that is not a card is about the PANEL, so it spans: a half-width footer button would land
	   beside a card and read as part of it. Keyed on shadcn's attribute, so a new control gets this free. */
	.panel > :global(:not([data-slot='card'])) {
		grid-column: 1 / -1;
	}
	/* EVERY CARD IS ADDRESSABLE — each of the eleven carries an `id`, so "the Sound card" is a place and not a
	   scroll position. There is deliberately NO `scroll-margin-block-start` here yet: nothing in the tree links to a
	   card fragment, and the offset that would be needed is the sticky header's rendered bottom at rest, which is
	   content-driven (its own margin plus a box no token declares) rather than a rung. The first real fragment link
	   is what should bring that number, measured, with it. */

	/* THE LANDSCAPE CLAW-BACK, the arm `/`, `/library` and `song/[mediaId]` all carry as a `.grouphead`
	   re-declaration inside their own `@media (max-height: 480px)` block — named by rule rather than by line,
	   because one of the three line numbers that stood here had already drifted while the other two were being kept
	   fresh by hand — on the same threshold and for the same reason: a phone held sideways spends almost the whole
	   height on chrome, and the section rung is a PORTRAIT ruling. This is the one surface that spends that rung as
	   a grid GAP rather than as `.grouphead`'s margin, which is why the claw-back is spelled here instead. Without
	   this arm the rung is pure unconditional cost here — RE-DERIVED at 844x390 on the three scope routes, with both
	   portrait rungs forced back on: the room panel grows 1812.7 -> 1924.7px (+112), the machine panel
	   1342.6 -> 1430.6 (+88) and You 744 -> 766 (+22), which is 28.7% of that viewport's height on the worst one.
	   BOTH boundaries move together, because clawing only the row gap back to 12px would re-invert the surface
	   against the 20px rendered intra-card boundary above. `--space-3xs` is spelled as a DELTA on card-content's 8px
	   flex gap, not as a register: 8 + 2 renders 10px between groups.
	   WHAT THIS ARM DOES NOT COMPRESS, re-derived at 844x390 rather than assumed, because the claim that stood here
	   ("8 inside a group, 10 between groups, 12 between cards") was arithmetic on declared values and the surface
	   does not render it: this rule reaches a label's `margin-top` only, so the label's own 4px `margin-bottom` is
	   untouched and the INTRA-group boundary stays at 8 + 4 = 12px. Measured, the sideways ladder is 12px inside a
	   group, 10px between groups where the next one leads with a label, 8px between groups where it leads with a
	   `.pair` or `.check` (the portrait inversion named above, carried through), and 12px card to card. So landscape
	   is not monotone: a group reads LOOSER than the boundary between two groups, and a card boundary is
	   indistinguishable from an intra-group one. It is kept because the arm's job is the 28.7% of viewport height it
	   gives back, which it does, and because the one rung that could fix it is the 4px `margin-bottom` inside
	   `field-label.svelte` — a component every surface in the app renders, not a settings decision. Portrait renders
	   12 / 14 / 20 / 24 with the same 8px inversion; both ladders are listed in full above the base rules.
	   `row-gap` alone, never the `gap` shorthand: the COLUMN gap is what fixes the 852px pairing threshold, and a
	   sideways phone is nowhere near it.
	   Both rules tie their base on specificity (0,3,1 for the card-content pair — `:is()` resolves to its widest
	   argument and changes nothing — and 0,2,0 for `.panel`) and therefore win on SOURCE ORDER only; a media query
	   adds nothing. So this arm has to stay BELOW both bases, and a later rule re-declaring either one would silently
	   out-cascade it. The host pair is spelled here too, or the three controls behind the disclosure would keep the
	   portrait 12px margin while every other card on the surface clawed back to 2. */
	@media (max-height: 480px) {
		main :global(:is([data-slot='card-content'], [data-slot='collapsible-content']) > * + [data-slot='field-label']),
		main :global(:is([data-slot='card-content'], [data-slot='collapsible-content']) > * + .ring-field) {
			margin-top: var(--space-3xs);
		}
		.panel {
			row-gap: var(--space-lg);
		}
	}
</style>
