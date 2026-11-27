<script lang="ts">
	/*
	 * THE SHELL EVERY SETTINGS SCOPE WEARS — the heading, the scope line, the one failure banner, the section grid,
	 * and the flat row rules every scope draws its sections with (#1159).
	 *
	 * It exists because `/settings` is three ROUTES now (You, this room, this machine) and the rulings below are
	 * properties of the SURFACE rather than of any one scope: the nested measures, the section boundary, the row
	 * shapes and the landscape claw-back. Three copies of them would be three places for them to drift.
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
	import { Button } from '$lib/components/ui/button';
	import type { SettingsScope } from '$lib/settings-scopes';

	let {
		scope,
		back,
		failed = false,
		locked = null,
		children
	}: {
		/** Set for anyone but the host: the controls read but do not move, and this names what the host link looks like. */
		locked?: { hostLink: string } | null;
		/** Which of the three scopes this route is, read from `$lib/settings-scopes` — the list's one home. */
		scope: SettingsScope;
		/** This scope's ONE door, named. A real anchor, never `history.back()`, so the route stays shareable. */
		back: { href: string; label: string };
		/** From `createSettingsWrites`. The You scope performs no settings write, so it leaves this alone. */
		failed?: boolean;
		/** This scope's sections, rendered straight into `.panel` as its own children. */
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

		<!-- A guest's one lit surface, in the idle Spotlight look the party's "Ready for tonight" wears. -->
		{#if locked}
			<div id="host-only" class="spot host-only">
				<h2>Only the host can change these</h2>
				<p>Host: open the link Encore showed when it started, on this phone.</p>
				<code>{locked.hostLink}</code>
				<Button variant="outline" size="block" href="/host">I have the host key</Button>
			</div>
		{/if}

		<!-- `inert`, so a guest cannot move a control the server would refuse; the box above says why. -->
		<div class="panel" inert={locked !== null}>
			{@render children()}
		</div>
	</main>
</div>

<style>
	/* Nested measures, and the width is spent on a second column of SECTIONS rather than on wider controls.
	   See docs/FRONTEND.md#settings for what each token means and where each level applies. */
	.settings-page {
		--page-measure: var(--measure-grid);
	}

	main {
		/* Kept in sync with --page-measure above, so the header aligns with this column. */
		max-width: var(--measure-grid);
		margin: 0 auto;
		/* Reserves the dock. No env() term: `TabBar`, the bottom-most element inside the dock, carries the only
			   home-indicator inset, and it reaches this column through --dock-h, so a second one here is the doubled gap. */
		padding: var(--space-md) var(--space-2xl) calc(var(--dock-h, 0px) + 28px);
	}

	/* The idle Spotlight look, for a surface that cannot be a <Spotlight> (a link, or the guest's host box): the scope's
	   one lit surface. */
	main :global(.spot) {
		padding: var(--step-12) var(--step-16);
		border-radius: var(--round-spot);
		background: var(--role-raise);
		box-shadow: inset 0 0 0 2px var(--spot);
	}
	/* Its title and its line, as the Spotlight draws them. */
	main :global(.spot :is(strong, h2)) {
		display: block;
		margin: 0;
		font-size: var(--type-title);
	}
	main :global(.spot :is(small, p)) {
		display: block;
		margin: 0;
		font-size: var(--type-meta);
	}
	main :global(:is(.spot :is(small, p), .spot > svg, .door > svg:last-child)) {
		color: var(--role-ink-dim);
	}
	.host-only {
		display: grid;
		gap: var(--space-sm);
		margin-bottom: var(--space-5xl);
	}
	/* A grid item, so it is already a block. `ui-monospace` is SF Mono where it exists; Menlo is Chrome on a Mac. */
	.host-only code {
		padding: var(--space-sm);
		border-radius: var(--radius-sm);
		background: var(--bg);
		font:
			600 var(--ph-text-xs) / var(--lh-snug) ui-monospace,
			Menlo,
			monospace;
		overflow-wrap: anywhere;
	}

	.panel {
		/* A grid, not a flex column: `auto-fit` collapses the empty tracks, so at one column this is the plain stack.
			   `align-items: start` matters — `stretch` would pad the shorter section out to its neighbour. */
		display: grid;
		/* The column floor is 420px and not --measure-prose (560): two of those plus the gap need 1132, more than the
			   widest shell, so a prose floor would never pair anything. At 420 the PANEL pairs from 852 up. */
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
		align-items: start;
		/* The ROW gap is the section boundary and takes the section rung. The COLUMN gap stays --space-lg, so the pairing
			   threshold stays 2*420 + 12 = 852px of panel, which only the --bp-lg step reaches: no phone and no portrait
			   tablet ever pairs. */
		gap: var(--space-5xl) var(--space-lg);
	}
	/* Anything in a panel that is not a section is about the PANEL, so it spans: a half-width row would land beside a
	   section and read as part of it. */
	.panel > :global(:not(.settings-section)) {
		grid-column: 1 / -1;
	}

	/* FLAT SECTIONS ON THE GROUND (#1159, option A), the rules every scope draws with: a section is its `.grouphead` h2
	   over hairline rows, as on Sing and Library, with no card and no box inside a box. `.panel`'s row gap is the
	   section boundary, so the grouphead drops the top rung it carries on a block page. */
	.panel :global(.settings-section > .grouphead) {
		margin-top: 0;
	}
	/* Rows on the ground, split by the decorative rule (never a control's boundary). */
	.panel :global(.rows) {
		font-size: var(--type-body);
	}
	.panel :global(.rows > * + *) {
		border-top: 1px solid var(--role-rule);
	}
	.panel :global(.rows > *) {
		padding-block: var(--space-sm);
	}
	/* In a row the name is the ink and only the value is dim, so the label drops its own margin and dim. */
	.panel :global(.rows [data-slot='field-label']) {
		margin: 0;
		color: var(--role-ink);
		font-size: inherit;
	}
	/* Every row shape is a line: its name at the start, its control or value at the end. */
	.panel :global(:is(.ready, .door, .check, .pick)) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
	}
	.panel :global(:is(.ready, .door, .check)) {
		min-height: var(--tap);
	}
	/* A picker row: the name, then the native select showing its value, its chevron in the control colour (3:1) marking
	   it as a control now the box is gone. When both do not fit (a long value at 320), the select wraps onto its own
	   line at the right edge, so no value is cut to an ellipsis (UI-CHECKLIST G2). */
	.panel :global(.pick) {
		flex-wrap: wrap;
		row-gap: 0;
	}
	.panel :global(.pick [data-slot='native-select-wrapper']) {
		width: auto;
		max-width: 100%;
		margin-inline-start: auto;
	}
	/* `field-sizing: content` sizes the select to its current value, not its longest option; where it is unsupported the
	   row wraps as above instead. */
	.panel :global(.pick [data-slot='native-select']) {
		field-sizing: content;
		border-color: transparent;
		background: transparent;
		color: var(--role-ink-dim);
		text-align-last: right;
	}
	.panel :global(.pick [data-slot='native-select-icon']) {
		color: var(--role-control);
	}
	.panel :global(.pick .warn) {
		flex-basis: 100%;
	}
	/* A slider row: the name and its value on one line, the slider under them. The value wraps under the name when the
	   two do not fit (200% text at 320, p15). */
	.panel :global(.stack [data-slot='field-label']) {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-md);
		margin-bottom: var(--space-2xs);
	}
	.panel :global(:is(.ready, .door)) {
		color: var(--role-ink);
		text-decoration: none;
	}
	/* A door: its icon slot, its name taking the width, its chevron. */
	.panel :global(.door > :first-child) {
		flex: 0 0 1.25rem;
	}
	.panel :global(.door > :nth-child(2)) {
		flex: 1;
	}
	/* ADVISORY ONLY — a cost, a no-op, a heads-up. A REFUSAL takes a scope's own `.err`, in `--danger-ink`. */
	.panel :global(.warn) {
		margin: var(--space-xs) 0 0;
		font-size: var(--ph-text-xs);
		color: var(--warn);
	}
	/* A value breaks as ONE piece: at 320 `1 hr 30 min` split inside itself. A phrase wider than a 320 screen at 200%
	   text (the lyric size's) may break. */
	.panel :global(.value) {
		white-space: nowrap;
		color: var(--role-ink-dim);
	}
	.panel :global(.value[data-wrap]) {
		white-space: normal;
	}

	/* THE PARTY SCOPE'S TWO OWN CONTROL DRESSES, here rather than in its route because one sheet gzips ~150 B smaller
	   than two on `/settings` (#1403). The swatch carries no text, so it needs no contrast floor of its own — and
	   neither does the stage colour: what matters is the lyrics ON the stage, which the reel enforces with its own
	   stroke. A flex item of its inline label (`data-inline`), so it needs no display or vertical-align. */
	.panel :global(.swatch) {
		background: var(--swatch);
		width: 1em;
		height: 1em;
		margin-left: 0.5em;
		border-radius: var(--radius-xs);
		border: 1px solid var(--line);
	}
	/* Native `type="color"`, so eyedroppers and OS palettes come free, sized up to --tap because the browser's default
	   swatch is well under a thumb's worth of target. --control-line and NOT --line: a native colour input is a form
	   control, so this border is what identifies it and takes SC 1.4.11's 3:1 floor (worst 3.13:1, on --track-bg).
	   `.swatch` above keeps --line: it is a static span whose INFORMATION is its own fill, so its hairline is
	   decoration. */
	.panel :global(input[type='color'].colour) {
		width: 100%;
		height: var(--tap);
		padding: var(--space-2xs);
		background: var(--field-bg, transparent);
		border: 1px solid var(--control-line);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	/* THE LANDSCAPE CLAW-BACK, the arm `/`, `/library` and `song/[mediaId]` all carry as a `.grouphead`
	   re-declaration inside their own `@media (max-height: 480px)` block, on the same threshold and for the same
	   reason: a phone held sideways spends almost the whole height on chrome, and the section rung is a PORTRAIT
	   ruling. This is the one surface that spends that rung as a grid GAP rather than as `.grouphead`'s margin, which is
	   why the claw-back is spelled here instead. `row-gap` alone, never the `gap` shorthand: the COLUMN gap is what
	   fixes the 852px pairing threshold. It ties its base on specificity, so it must stay below it. */
	@media (max-height: 480px) {
		.panel {
			row-gap: var(--space-lg);
		}
	}
</style>
