<script lang="ts">
	// M3-C1 component preview (dev-only gallery). Not a product surface.
	import SongCard from '$lib/components/SongCard.svelte';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import NowPlaying from '$lib/components/NowPlaying.svelte';
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
</main>
