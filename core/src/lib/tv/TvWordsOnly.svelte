<!--
  WORDS ONLY (proposal 34): what a copy set to Words only adds to the stage, loaded only by such a screen, so the room's
  TV ships none of it. The line naming who is next, and the overlay's fit (the size cap and the row check that steps
  the type down). docs/FRONTEND.md#words-only.
-->
<script module lang="ts">
	export interface WordsFit {
		/** The cap, as custom properties: the largest type at which `rowCount` lines of `wrapRows` rows fill the band. */
		style(rowCount: number, wrapRows: number, shrink: number): string;
		/** Does a shown line take more than its `wrapRows` rows (`oneRow` is a row's leading)? */
		over(rows: HTMLCollection, from: number, to: number, wrapRows: number, oneRow: number): boolean;
	}
	// The 1.9 is LyricsOverlay's `--lyrics-row-h`; the two must agree. The sung row draws its words as inline-block
	// spans, a little taller than its leading, so the box takes SLACK_EM more and the cap counts it. A single word longer
	// than a row breaks rather than running off the side.
	const SLACK_EM = 0.5;
	/** @public Read through the TV page's lazy `import()`, which knip cannot follow. */
	export const wordsFit: WordsFit = {
		style: (rowCount, wrapRows, shrink) =>
			`; --lyrics-slack: ${SLACK_EM}em; --lyrics-fit: calc((100vh - var(--tv-chrome-h) - var(--tv-top-reserve)) * ${shrink} / ${rowCount * wrapRows * 1.9 + SLACK_EM}); overflow-wrap: anywhere`,
		over(rows, from, to, wrapRows, oneRow) {
			for (let i = Math.max(0, from); i <= to && i < rows.length; i++) {
				const r = rows[i] as HTMLElement;
				const second = r.querySelector<HTMLElement>('.romanization')?.offsetHeight ?? 0;
				if (r.offsetHeight - second > (wrapRows + 0.5) * oneRow) return true;
			}
			return false;
		}
	};
</script>

<script lang="ts">
	let { name, color }: { name: string; color?: string } = $props();
</script>

<p class="words-next">
	<span class="dot" style:background={color} aria-hidden="true"></span>
	<b>{name}</b> is next
</p>

<style>
	/* Who is next, in "Up next"'s place and type, on one line. */
	.words-next {
		position: absolute;
		right: var(--tv-safe-x);
		top: calc(var(--tv-safe-y) + 2.6vh);
		z-index: var(--z-tv-card);
		max-width: 40vw;
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--tv-body);
		font-weight: 700;
		color: var(--ink-dim);
	}
	b {
		color: var(--ink);
		font-weight: 800;
	}
	.dot {
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		border-radius: 50%;
		margin-right: 0.4em;
	}
	/* The overlay's fit-mode rows: `visibility`, not `display`, so a row past the two keeps its box and the reel's
	   offsets and glide stay as they are. */
	:global(.lyrics .row.beyond) {
		visibility: hidden;
	}
</style>
