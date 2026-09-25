<script lang="ts">
	// The LYRICS RE-SELECT control — the fallback for when the auto-chosen lyrics are wrong. PRESENTATIONAL, like
	// GuidingTrack: the request, the optimistic status and the error toast belong to the caller, being room concerns.
	import type { LyricsCandidate } from '$lib/contract';
	// Provenance wording stays in the contract: a local copy is how one surface comes to say "Captions" where
	// another says "Auto captions".
	import { lyricsSourceLabel } from '$lib/contract';
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
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
		onpick?: (ref: string) => void;
		onpaste?: (text: string) => void;
	}
	let { candidates, chosenRef, overrideRef, newerExists = false, onpick, onpaste }: Props = $props();

	let open = $state(false);
	let pasting = $state(false);
	let draft = $state('');

	/* PER-INSTANCE, because two of these can share a screen and a hardcoded id would make the second one's
	   `aria-controls` point at the first. Without it the toggle announces a state and not what holds it. */
	const uid = $props.id();
	const bodyId = `reselect-body-${uid}`;

	function timingLabel(c: LyricsCandidate): string {
		return c.timing === 'word' ? 'word-by-word' : c.timing === 'line' ? 'line-by-line' : 'no timing';
	}

	// A single candidate still counts as a choice, because the paste path is always available: the auto text may be wrong.
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
			<div id={bodyId}>
				<!--
						THE ROW IS A BUTTON, through Item's `child` snippet, because the whole row is the pick action and Item.Root renders
						a div. The static token must come FIRST and `{props.class}` second so both survive. It must also stay a real
						`class="…"` attribute rather than a `class:` directive: the tap-floor guard's control scan reads only the attribute
						form, so the directive would remove this component's primary control from its population.
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
										<!-- A PLAIN span, never Item.Title: that primitive is `w-fit`, so `fit-content` resolves against its own
												min-content and a nowrap child grows the title past the row instead of ellipsising inside it. As a direct child
												of the content COLUMN this span stretches to the column's width, which is what engages the ellipsis. -->
										<span class="opt-src">{lyricsSourceLabel(c)}</span>
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
						<Textarea bind:value={draft} rows={5} placeholder="Paste the lyrics…" aria-label="Paste lyrics" />
						<div class="reselect-acts">
							<Button data-act="confirm" disabled={!draft.trim()} onclick={submitPaste}>Use these lyrics</Button>
							<Button data-act="cancel" variant="outline" onclick={() => (pasting = false)}>Cancel</Button>
						</div>
					</div>
				{:else}
					<button class="reselect-paste-open" onclick={() => (pasting = true)}>
						<Icon name="chevron-right" /> Paste my own
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.reselect {
		margin: var(--space-md) 0 var(--space-3xs);
	}
	/* THE DISCLOSURE IS HAND-ROLLED DELIBERATELY: the vendored Collapsible's content reads geometry in a watcher that
	   fires the moment its element gets a ref, and the mount rung replaces that accessor with a throw, so the deferred
	   read fails whatever mounted it. The toggle supplies by hand the one thing the primitive would give it — `aria-controls`. */
	.reselect-toggle {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		width: 100%;
		/* Named, because padding alone puts a one-line toggle at about 25px, well under the standard. */
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
		/* A flex item's floor is its min-content width, so without this the peek's own text sets the row's minimum. */
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
	/* Item.Root supplies this row's BOX, so what is left is what a native button still needs with Preflight off: the
	   surface, the ink, a solid border-style in place of the UA's `outset`, and the tap floor. */
	.reselect-opt {
		/* Named rather than inherited from the primitive's padding: that clears 44px only by arithmetic on a size variant
		   a re-vendor can change, and this is the component's primary control. */
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
		/* Named, for the same reason as the toggle above. */
		min-height: var(--tap);
		background: none;
		border: none;
		color: var(--ink-dim);
		font: inherit;
		padding: var(--space-2xs) 0;
		cursor: pointer;
	}
	/* The field's own appearance is ui/textarea's; only this call site's spacing is here, on the wrapper. */
	.reselect-paste > :global([data-slot='textarea']) {
		margin-top: var(--space-xs);
	}
	.reselect-acts {
		display: flex;
		gap: var(--space-xs);
		margin-top: var(--space-xs);
	}
	/* The paste actions carry NO local rule: everything comes from the Button primitive. They are addressed by `data-act`
	   rather than a styling class, and a scoped rule cannot reach a class handed to a child anyway. */
</style>
