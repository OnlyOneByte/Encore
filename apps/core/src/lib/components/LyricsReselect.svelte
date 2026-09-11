<script lang="ts">
	// The LYRICS RE-SELECT control (#640) — the fallback for when the auto-chosen lyrics are wrong.
	//
	// Presentational, exactly like GuidingTrack: it owns the disclosure, the candidate list with
	// provenance, the paste box and the "a better version exists" hint, and reports raw choices up
	// (`onpick(ref)` / `onpaste(text)`). The POST to /api/lyrics-reselect, the optimistic status and the
	// error toast live with the caller, because those are room/network concerns this control does not own.
	//
	// It renders `nowMedia.lyricsCandidates` directly — the phone already receives the full candidate set
	// with provenance over the wire, so no new read path. `chosenCandidate` marks the current pick and
	// `hasNewerCandidateThanOverride` decides the hint; both are pure shared helpers.
	import type { LyricsCandidate } from '@encore/shared';
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Item from '$lib/components/ui/item';

	interface Props {
		/** Every stored candidate for the current song, in the set's own order. */
		candidates: LyricsCandidate[];
		/** The ref currently shown (chosenCandidate(media)?.ref), so the list can mark it. */
		chosenRef?: string;
		/** The human override ref, when one is pinned — used to phrase the "pinned" state honestly. */
		overrideRef?: string;
		/** True when the ranker now prefers a candidate other than the pinned one (Q2=C hint). */
		newerExists?: boolean;
		/** Re-time an already-stored candidate. */
		onpick?: (ref: string) => void;
		/** Re-time pasted words as a new manual candidate. */
		onpaste?: (text: string) => void;
	}
	let { candidates, chosenRef, overrideRef, newerExists = false, onpick, onpaste }: Props = $props();

	let open = $state(false);
	let pasting = $state(false);
	let draft = $state('');

	/*
	 * #913: the toggle carried `aria-expanded` and named NOTHING — the body had no id, so a screen
	 * reader was told a state without being told what holds it. Per-instance (`$props.id()`), because
	 * two of these can share a screen and a hardcoded id would make the second one point at the first.
	 */
	const uid = $props.id();
	const bodyId = `reselect-body-${uid}`;

	// A short, honest provenance label per candidate — the same distinction the TV overlay draws
	// (authored words vs an auto-transcribed guess), so a singer picks with the same information.
	function sourceLabel(c: LyricsCandidate): string {
		if (c.textSource === 'lrclib') return 'Synced lyrics';
		if (c.textSource === 'captions') return c.textConfidence === 'low' ? 'Auto captions' : 'Captions';
		if (c.textSource === 'asr') return 'Auto-transcribed';
		if (c.textSource === 'manual') return 'Your lyrics';
		return c.textSource;
	}
	function timingLabel(c: LyricsCandidate): string {
		return c.timing === 'word' ? 'word-by-word' : c.timing === 'line' ? 'line-by-line' : 'no timing';
	}

	// Only worth showing when there is a real choice: more than one candidate, or a paste path. A song
	// with a single candidate still offers paste (the auto text may simply be wrong).
	const hasChoice = $derived(candidates.length > 0);
	const peek = $derived(newerExists ? 'A better match is available' : overrideRef ? 'Your pick' : 'Auto-selected');

	function submitPaste() {
		const text = draft.trim();
		if (!text) return;
		onpaste?.(text);
		pasting = false;
		draft = '';
		open = false;
	}
</script>

{#if hasChoice}
	<div class="reselect" class:newer={newerExists}>
		<button class="reselect-toggle" aria-expanded={open} aria-controls={bodyId} onclick={() => (open = !open)}>
			<Icon name={open ? 'chevron-down' : 'chevron-right'} />
			<span class="reselect-label">Lyrics</span>
			<span class="reselect-peek">{peek}</span>
		</button>
		{#if open}
			<div class="reselect-body" id={bodyId}>
				<p class="reselect-hint">Wrong words, or the wrong version? Pick another set — it gets re-timed.</p>
				<!--
					#913: the list is Item.Group / Item.Root / Item.Content / Item.Description / Badge — the same
					row grammar the admin library list uses, so `.reselect-list`, `.reselect-opt`'s box, `.opt-timing`
					and `.opt-badge` are gone as local rules.

					THE ROW IS STILL A BUTTON, through Item's own `child` snippet: the whole row is the pick action,
					and Item.Root renders a div. The static `reselect-opt` token is FIRST and `{props.class}` second
					so both survive — a bare `class="reselect-opt"` after the spread would drop Item's classes, and
					before it would be dropped BY them. It stays a real `class="…"` attribute rather than a
					`class:reselect-opt={true}` directive because `markupControls` (test-helpers, used by
					touch-targets.test.ts) reads only `class="…"`, so the directive form would quietly remove this
					control — the primary one in the component — from the tap-floor guard's population.
				-->
				<Item.Group>
					{#each candidates as c (c.ref)}
						<Item.Root variant="outline">
							{#snippet child({ props })}
								<button
									{...props}
									class="reselect-opt {props.class}"
									class:current={c.ref === chosenRef}
									aria-current={c.ref === chosenRef}
									onclick={() => onpick?.(c.ref)}
								>
									<Item.Content>
										<!--
											A PLAIN span, not Item.Title, and that is the truncation fix rather than a preference.
											Item.Title is `w-fit` + `flex`: `width: fit-content` resolves against its own min-content,
											so a `white-space: nowrap` child makes the TITLE grow past the row instead of ellipsising
											inside it. (Its `line-clamp-1` cannot save that — `.flex{display:flex}` is emitted after
											`.line-clamp-1{display:-webkit-box}` in the built bundle, so the clamp never applies.) As a
											direct child of Item.Content — a flex COLUMN — this span stretches to the column's width
											instead, which is what makes the ellipsis engage.
										-->
										<span class="opt-src">{sourceLabel(c)}</span>
										<Item.Description>{timingLabel(c)}</Item.Description>
									</Item.Content>
									{#if c.ref === chosenRef}
										<Item.Actions><Badge variant="accent">Showing</Badge></Item.Actions>
									{/if}
								</button>
							{/snippet}
						</Item.Root>
					{/each}
				</Item.Group>

				{#if pasting}
					<div class="reselect-paste">
						<textarea
							class="reselect-textarea"
							bind:value={draft}
							rows="5"
							placeholder="Paste the correct lyrics, one line per line…"
							aria-label="Paste lyrics"></textarea>
						<div class="reselect-acts">
							<Button data-act="confirm" disabled={!draft.trim()} onclick={submitPaste}>Use these lyrics</Button>
							<Button data-act="cancel" variant="outline" onclick={() => (pasting = false)}>Cancel</Button>
						</div>
					</div>
				{:else}
					<button class="reselect-paste-open" onclick={() => (pasting = true)}>
						<Icon name="chevron-right" /> None of these — paste my own
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	/* Mirrors the Vocal-range disclosure idiom next to it: a toggle with a peek, a body that opens
	   below. Colours are the app's own design tokens so the control reads correctly on every theme. */
	.reselect {
		margin: var(--space-md) 0 var(--space-3xs);
	}
	/*
	 * THE DISCLOSURE IS STILL HAND-ROLLED, AND THAT IS MEASURED RATHER THAN PREFERRED (#913).
	 *
	 * `ui/collapsible` is vendored and NowPlayingHero uses it, so one idiom on this screen was the
	 * intent. It cannot be had here: Bits UI's CollapsibleContent reads `getBoundingClientRect()` in a
	 * watcher that fires the moment its element gets a ref, and the mount rung replaces that accessor
	 * with a throw because happy-dom fabricates a zero (XR-VER-03, test-setup/svelte-dom-preload.ts).
	 * Measured on a scratch component: the disclosure WORKS — the trigger gets `aria-expanded`, the
	 * content gets an id and the trigger gets a matching `aria-controls` for free — and then the deferred
	 * read throws and fails the test that mounted it. That is what took NowPlayingHero's four disclosure
	 * claims off this rung and into `e2e/probes/p16-hero-live-controls.mjs`.
	 *
	 * lyrics-reselect-640.test.ts MOUNTS this component for all four of its claims — the candidate list,
	 * the marked pick, `onpick`, `onpaste` and the peek. Adopting Collapsible would trade those four for
	 * an e2e probe, so the toggle stays a real <button> and supplies by hand the one thing Collapsible
	 * would have given it: `aria-controls={bodyId}` against the body's `id`.
	 */
	.reselect-toggle {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		width: 100%;
		/* Was `padding: var(--space-2xs) 0` and no floor — ~25px on one text line, well under the
		   standard. NowPlayingHero's equivalent toggle already names the token; this one now does too. */
		min-height: var(--tap);
		background: none;
		border: none;
		color: var(--ink);
		font: inherit;
		padding: var(--space-2xs) 0;
		cursor: pointer;
	}
	/* Fixed, so the peek beside it is the part that gives way when the row runs out of room. */
	.reselect-label {
		flex: 0 0 auto;
	}
	.reselect-peek {
		margin-left: auto;
		/* A flex item's floor is its min-content width, so without this the peek's own text sets the
		   row's minimum and the ellipsis never engages. Same pairing as the hero's `.tools-peek`. */
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ink-dim);
		font-size: var(--ph-text-sm);
	}
	.reselect.newer .reselect-peek {
		color: var(--accent-ink);
	}
	.reselect-hint {
		color: var(--ink-dim);
		font-size: var(--ph-text-sm);
		margin: var(--space-2xs) 0 var(--space-xs);
	}
	/*
	 * Item.Root supplies this row's BOX — the flex line, the radius, the 1px border, the padding and the
	 * gap — so what is left here is what a native <button> still needs with Preflight off (#853): the
	 * surface, the ink, a solid border-style in place of the UA's `outset`, and the tap floor. Same
	 * division as item.svelte's own note: the primitive keeps the box, the row keeps every colour.
	 */
	.reselect-opt {
		/* The PRIMARY control of this component, and it was ~31px: one text line inside
		   `padding: var(--space-xs) var(--space-sm)`. Item's `py-3.5` alone would clear 44px today, but
		   only by arithmetic on a size variant a re-vendor can change, so the floor is named. */
		min-height: var(--tap);
		background: var(--card2);
		border-style: solid;
		color: var(--ink);
		text-align: left;
		cursor: pointer;
	}
	.reselect-opt.current {
		border-color: var(--accent-ink);
	}
	.opt-src {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}
	.reselect-paste-open {
		margin-top: var(--space-xs);
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		/* Was ~25px, the same padding-with-no-floor shape as the toggle above. */
		min-height: var(--tap);
		background: none;
		border: none;
		color: var(--ink-dim);
		font: inherit;
		padding: var(--space-2xs) 0;
		cursor: pointer;
	}
	.reselect-textarea {
		width: 100%;
		margin-top: var(--space-xs);
		background: var(--card2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		color: var(--ink);
		font: inherit;
		padding: var(--space-xs);
		resize: vertical;
	}
	.reselect-acts {
		display: flex;
		gap: var(--space-xs);
		margin-top: var(--space-xs);
	}
	/*
	 * #640/#913: these two actions used to be native buttons carrying `chip` / `chip ghost` with NO
	 * `.chip` base rule anywhere — the migration moved SongRow's `.chip` into ui/badge, and Badge renders
	 * a span, never a button, so the markup pointed at a class that no longer existed. With Preflight off
	 * and no global control reset they rendered as ~21px native OS buttons in the wrong font on a dark
	 * sheet. They are the shared Button primitive now, so the surface, the 44px --tap floor, the focus
	 * ring and the disabled treatment all come from one place and no local rule is needed.
	 *
	 * They are addressed by `data-act` rather than by a styling class: a class that exists only so a test
	 * can find it is what left the orphaned `.chip` here in the first place, and a scoped rule cannot
	 * reach a class handed to a child component anyway (ui-scoped-style-reach-913 enforces that).
	 */
</style>
