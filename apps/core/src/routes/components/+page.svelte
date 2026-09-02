<script lang="ts">
	// M3-C1 component preview (dev-only gallery). Not a product surface.
	import SongCard from '$lib/components/SongCard.svelte';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import NowPlaying from '$lib/components/NowPlaying.svelte';
	import LyricsOverlay from '$lib/tv/LyricsOverlay.svelte';
	import type { LyricsDoc } from '$lib/tv/lyrics';
	import { onMount } from 'svelte';

	// M8-C2 demo: a word-timed fixture + an auto-advancing position so the karaoke sweep is visible
	// here in the dev gallery (the real /tv route feeds position from player telemetry).
	const demoLyrics: LyricsDoc = {
		language: 'en',
		lines: [
			{
				start: 0,
				end: 2.6,
				text: 'Is this the real life',
				words: [
					{ word: 'Is', start: 0.0, end: 0.4 },
					{ word: 'this', start: 0.4, end: 0.8 },
					{ word: 'the', start: 0.8, end: 1.1 },
					{ word: 'real', start: 1.1, end: 1.8 },
					{ word: 'life', start: 1.8, end: 2.6 }
				]
			},
			{
				start: 2.8,
				end: 5.4,
				text: 'Is this just fantasy',
				words: [
					{ word: 'Is', start: 2.8, end: 3.1 },
					{ word: 'this', start: 3.1, end: 3.5 },
					{ word: 'just', start: 3.5, end: 4.0 },
					{ word: 'fantasy', start: 4.0, end: 5.4 }
				]
			}
		],
		words: []
	};
	let demoPos = $state(0);
	onMount(() => {
		const t0 = performance.now();
		let raf = 0;
		const loop = () => {
			demoPos = ((performance.now() - t0) / 1000) % 6; // loop 0→6s
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	});
</script>

<main style="padding:14px 16px 200px;">
	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);">SongCard</h2>
	<SongCard title="Mr. Brightside" sub="The Killers · 3:43" />
	<SongCard title="Bohemian Rhapsody" sub="Queen · make-karaoke ✨" processing />

	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">QueueRow</h2>
	<QueueRow seq={1} title="Take On Me" singerName="Sam" singerColor="#33d6a6" up subtitle="now playing" />
	<QueueRow seq={3} title="Dancing Queen" singerName="You" singerColor="#ff5cae" mine subtitle="after Liam" />
	<QueueRow seq={4} title="Sweet Caroline" singerName="Liam" singerColor="#5cb8ff" />
	<QueueRow seq={5} title="Wonderwall" singerName="You" singerColor="#ff5cae" mine pending />

	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">ProcessingCard</h2>
	<ProcessingCard seq={2} title="Bohemian Rhapsody" singerName="You" singerColor="#ff5cae" status="separating" pct={68} />

	<NowPlaying title="Take On Me" sub="a-ha · Sam is singing" />

	<h2 style="font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-top:18px;">LyricsOverlay (M8-C2 · TV)</h2>
	<div style="position:relative;height:280px;border-radius:16px;overflow:hidden;background:radial-gradient(120% 90% at 50% 20%, #241a3d, #0b0b12);">
		<LyricsOverlay doc={demoLyrics} positionSec={demoPos} playing visible />
	</div>
</main>
