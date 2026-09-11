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
		<button class="reselect-toggle" aria-expanded={open} onclick={() => (open = !open)}>
			<Icon name={open ? 'chevron-down' : 'chevron-right'} />
			Lyrics
			<span class="reselect-peek">{peek}</span>
		</button>
		{#if open}
			<div class="reselect-body">
				<p class="reselect-hint">Wrong words, or the wrong version? Pick another set — it gets re-timed.</p>
				<ul class="reselect-list">
					{#each candidates as c (c.ref)}
						<li>
							<button
								class="reselect-opt"
								class:current={c.ref === chosenRef}
								aria-current={c.ref === chosenRef}
								onclick={() => onpick?.(c.ref)}
							>
								<span class="opt-src">{sourceLabel(c)}</span>
								<span class="opt-timing">{timingLabel(c)}</span>
								{#if c.ref === chosenRef}<span class="opt-badge">Showing</span>{/if}
							</button>
						</li>
					{/each}
				</ul>

				{#if pasting}
					<div class="reselect-paste">
						<textarea
							class="reselect-textarea"
							bind:value={draft}
							rows="5"
							placeholder="Paste the correct lyrics, one line per line…"
							aria-label="Paste lyrics"></textarea>
						<div class="reselect-acts">
							<button class="chip" disabled={!draft.trim()} onclick={submitPaste}>Use these lyrics</button>
							<button class="chip ghost" onclick={() => (pasting = false)}>Cancel</button>
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
	.reselect-toggle {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		width: 100%;
		background: none;
		border: none;
		color: var(--ink);
		font: inherit;
		padding: var(--space-2xs) 0;
		cursor: pointer;
	}
	.reselect-peek {
		margin-left: auto;
		color: var(--ink-dim);
		font-size: 0.85em;
	}
	.reselect.newer .reselect-peek {
		color: var(--accent-ink);
	}
	.reselect-hint {
		color: var(--ink-dim);
		font-size: 0.85em;
		margin: var(--space-2xs) 0 var(--space-xs);
	}
	.reselect-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2xs);
	}
	.reselect-opt {
		display: flex;
		align-items: baseline;
		gap: var(--space-xs);
		width: 100%;
		text-align: left;
		background: var(--card2);
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		color: var(--ink);
		font: inherit;
		padding: var(--space-xs) var(--space-sm);
		cursor: pointer;
	}
	.reselect-opt.current {
		border-color: var(--accent-ink);
	}
	.opt-timing {
		color: var(--ink-dim);
		font-size: 0.85em;
	}
	.opt-badge {
		margin-left: auto;
		color: var(--accent-ink);
		font-size: 0.8em;
	}
	.reselect-paste-open {
		margin-top: var(--space-xs);
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
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
	.chip.ghost {
		background: none;
		border: 1px solid var(--line);
	}
</style>
