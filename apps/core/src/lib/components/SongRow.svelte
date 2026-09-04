<script lang="ts">
	// A search row. ONE row shape for all three readiness states, because they are one kind of thing
	// (a song) at three points on one axis — not three kinds of thing. The state decides the badge
	// line and which actions appear; the layout never changes, so a row that finishes cooking morphs
	// in place instead of jumping between lists.
	import type { Readiness } from '$lib/readiness';

	interface Props {
		title: string;
		artist?: string;
		readiness: Readiness;
		pct?: number; // cooking progress, 0..100
		etaSec?: number;
		/** Already in the rotation — the add action becomes a confirmation instead of a repeat. */
		inQueue?: boolean;
		onadd?: () => void;
		/** Request stem separation. Absent when it makes no sense (already ready / already cooking). */
		onmake?: () => void;
	}
	let { title, artist, readiness, pct = 0, etaSec, inQueue = false, onadd, onmake }: Props = $props();

	// The sub-line's job is to answer "what do I get if I tap this?" — the raw case has to say
	// "with vocals" out loud, or a singer queues a plain YouTube video and cannot tell why the
	// original singer is still audible.
	const sub = $derived.by(() => {
		if (readiness === 'ready') return `🎤 instrumental ready${artist ? ' · ' + artist : ''}`;
		if (readiness === 'cooking') {
			const eta = etaSec && etaSec > 0 ? ` · ~${Math.max(1, Math.round(etaSec / 60))} min` : '';
			return `Separating vocals… ${pct}%${eta}`;
		}
		return artist ? `${artist} · sings with the original vocals` : 'sings with the original vocals';
	});
</script>

<!--
	The row is a container, NOT a button. It used to be a role="button" div wrapping two real buttons,
	which announced one control to a screen reader while offering three, and let a keyboard user add the
	same song twice (Enter on the row, then Tab-Enter on the button). The two buttons carry the actions.
-->
<div class="row card" class:ready={readiness === 'ready'} class:cooking={readiness === 'cooking'}>
	<div class="thumb"></div>
	<div class="meta">
		<div class="t">{title}{#if readiness === 'cooking'}<span class="sparkle"> ✨</span>{/if}</div>
		<div class="s" class:ok={readiness === 'ready'} class:warn={readiness === 'cooking'}>{sub}</div>
		{#if readiness === 'cooking'}
			<!-- GPU-composited fill: scaleX from the left edge, never animates layout width -->
			<div class="bar"><i style="transform:scaleX({pct / 100})"></i></div>
		{/if}
	</div>
	{#if onmake}
		<!--
			ONE action, not two. A raw row used to offer `✨ Karaoke` and `＋ Turn` side by side at equal
			weight, and either one alone was a dead end: queueing without cooking held a rotation slot
			that could never become ready (silently skipped every pass, forever), and cooking without
			queueing filled the library but gave the singer no turn. The primary action is the whole
			intent — take a turn AND start the cook — and the held-slot rule keeps the singer's fair
			position while it separates. See $lib/cook-and-queue.ts.
		-->
		<button class="sing" title="Take a turn now and strip the vocals — you keep your place in line while it cooks"
			onclick={() => onmake?.()}>✨ Sing this</button>
	{:else}
		<button class="add" class:queued={inQueue} aria-label={inQueue ? 'already in the queue' : 'add a turn'}
			disabled={inQueue}
			onclick={() => onadd?.()}>{inQueue ? '✓ Queued' : '＋ Turn'}</button>
	{/if}
</div>

<style>
	.row {
		display: flex; align-items: center; gap: 11px; padding: 10px; margin-bottom: 8px;
		cursor: pointer; transition: transform 0.12s ease, background 0.12s ease;
	}
	.row:active { transform: scale(0.98); background: var(--card2); }
	.add:disabled { cursor: default; opacity: 0.7; }
	/* readiness is legible at a glance from the border alone, before any text is read */
	.row.ready { border-color: var(--ok); }
	.row.cooking { background: linear-gradient(var(--card), var(--card-tint)); border-color: var(--line-tint); }
	.thumb {
		width: 56px; height: 40px; border-radius: 8px; flex: 0 0 auto;
		background: linear-gradient(135deg, var(--track-bg), var(--card)); position: relative;
	}
	.thumb::after { content: '▶'; position: absolute; inset: 0; display: grid; place-items: center; color: #fff8; font-size: 0.8rem; }
	.meta { min-width: 0; flex: 1; }
	.t { font-weight: 600; font-size: 0.93rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.sparkle { color: var(--warn); }
	.s { font-size: 0.76rem; color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.s.ok { color: var(--ok); }
	.s.warn { color: var(--warn); }
	.bar { height: 4px; border-radius: 4px; background: var(--card-tint2); overflow: hidden; margin-top: 6px; }
	.bar > i { display: block; height: 100%; width: 100%; background: var(--grad); border-radius: 4px; transform-origin: left center; transition: transform 0.4s ease; }
	.add {
		min-height: 44px;
		flex: 0 0 auto; border: 0; border-radius: 10px; padding: 9px 12px; font-weight: 700;
		font-size: 0.82rem; background: var(--grad); color: #fff; cursor: pointer;
	}
	.add:active { transform: scale(0.94); }
	.add.queued { background: var(--card2); border: 1px solid var(--ok); color: var(--ok); }
	/*
	 * The raw row's single primary action. It takes the gradient because it IS the primary intent on
	 * this row — and because the weight used to sit on the wrong button: `.add` (gradient) was the
	 * dead end (a turn that could never become ready) while the cook was styled as a secondary
	 * outline. The hierarchy was not missing, it was inverted.
	 */
	.sing {
		min-height: 44px;
		flex: 0 0 auto; border: 0; border-radius: 10px; padding: 9px 14px; font-weight: 700;
		font-size: 0.82rem; background: var(--grad); color: #fff; cursor: pointer;
	}
	.sing:active { transform: scale(0.94); }
</style>
