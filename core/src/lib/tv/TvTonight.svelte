<!--
  "Tonight": the room's night as up to four slides, one fact each, in place of the lobby. It never ranks anyone and
  never names a singer who said "Don't keep my nights" (the server leaves them out). See docs/FRONTEND.md#tonight-on-the-tv.
-->
<script lang="ts" module>
	/** How long each slide stands. */
	export const SLIDE_MS = 6000;
</script>

<script lang="ts">
	import type { Tonight, TonightSinger, TonightSong } from '$lib/contract';
	import { nearestPaletteStop } from '$lib/contract/presentation/player-palette';

	let { tonight, onend }: { tonight: Tonight; onend: () => void } = $props();

	/** "Who sang" shows this many names; the rest are a count of names already allowed on screen. */
	const NAMES_SHOWN = 18;

	type Slide =
		| { kind: 'totals' }
		| { kind: 'song'; eyebrow: string; song: TonightSong }
		| { kind: 'everyone'; names: TonightSinger[]; more: number };

	/** The word for `n` of it: "song" or "songs". */
	const plural = (n: number, one: string) => (n === 1 ? one : `${one}s`);

	// Each slide only when it is true.
	const slides = $derived.by((): Slide[] => {
		const out: Slide[] = [{ kind: 'totals' }];
		if (tonight.first) out.push({ kind: 'song', eyebrow: 'First song', song: tonight.first });
		if (tonight.everyone.length)
			out.push({
				kind: 'everyone',
				names: tonight.everyone.slice(0, NAMES_SHOWN),
				more: Math.max(0, tonight.everyone.length - NAMES_SHOWN)
			});
		if (tonight.last) out.push({ kind: 'song', eyebrow: 'Last song', song: tonight.last });
		return out;
	});
	const totals = $derived(
		[
			[tonight.songs, 'song'],
			[tonight.singers, 'singer'],
			[tonight.cheers, 'cheer']
		].filter((t): t is [number, string] => t[0] !== undefined)
	);

	let index = $state(0);
	const slide = $derived(slides[Math.min(index, slides.length - 1)]!);

	$effect(() => {
		const count = slides.length;
		index = 0;
		let at = 0;
		const timer = setInterval(() => {
			at++;
			if (at >= count) {
				clearInterval(timer);
				onend();
			} else index = at;
		}, SLIDE_MS);
		return () => clearInterval(timer);
	});

	const stop = (colour: string) => nearestPaletteStop(colour);
</script>

<section
	class="absolute inset-0 flex flex-col font-bold"
	style="z-index:var(--z-tv-screen);padding:var(--tv-safe-y) var(--tv-safe-x);background:var(--bg);font-size:var(--tv-name)"
	data-testid="tv-tonight"
	aria-label="Tonight"
	data-slide={slide.kind}
>
	<!-- The pager sits beside the title: the connection dot owns the top-right corner. -->
	<header class="flex items-center gap-6">
		<h1>Tonight</h1>
		{#each slides as s, i (i)}<i
				class="block rounded-full"
				style="width:2.4rem;height:.25rem;background:var(--ink)"
				style:opacity={i === index ? 1 : 0.2}
				data-kind={s.kind}
			></i>{/each}
	</header>

	{#key index}
		<!-- One fact, in the space between the header and the footer line. -->
		<div class="stage flex flex-1 flex-col justify-center gap-4">
			{#if slide.kind === 'totals'}
				<ul class="flex flex-wrap gap-4" style="column-gap:3rem" data-testid="tonight-totals">
					{#each totals as [n, word] (word)}
						<li class="dim"><b class="big block leading-none" style:color="var(--ink)">{n}</b> {plural(n, word)}</li>
					{/each}
				</ul>
			{:else if slide.kind === 'song'}
				{@const s = stop(slide.song.singer.color)}
				<!-- The Spotlight band, full bleed: the owner's palette stop, with its certified ink. -->
				<div
					style="margin:0 calc(-1 * var(--tv-safe-x));padding:2.2rem var(--tv-safe-x)"
					style:background={s.fill}
					style:color={s.on_fill}
					data-testid="tonight-song"
				>
					<p>{slide.eyebrow}</p>
					<p class="big leading-none">{slide.song.title}</p>
					<p>{slide.song.singer.name}</p>
				</div>
			{:else}
				<p class="dim">Who sang tonight</p>
				<ul
					class="flex flex-wrap gap-4"
					style="column-gap:3rem;font-size:var(--tv-hero)"
					data-testid="tonight-everyone"
				>
					{#each slide.names as person, i (i)}
						<li class="flex items-center gap-3">
							<span class="rounded-full" style="width:.6em;height:.6em" style:background={stop(person.color).fill}
							></span>{person.name}
						</li>
					{/each}
				</ul>
				{#if slide.more}<p class="dim">{slide.more} more {plural(slide.more, 'singer')}</p>{/if}
			{/if}
		</div>
	{/key}

	<p class="dim font-normal" style="align-self:flex-end;font-size:var(--tv-body)">Your own night is on your phone</p>
</section>

<style>
	/* Layout is the utilities /tv already ships, and one-off boxes are inline: CLAIM 13 caps /tv's CSS bytes. */
	/* /tv has no preflight: the browser's heading size and paragraph margins would come back. */
	:where(h1, p, ul) {
		margin: 0;
		padding: 0;
		font-size: inherit;
		list-style: none;
	}
	.big {
		font-size: var(--tv-takeover-name);
		font-weight: 900;
		overflow-wrap: anywhere;
	}
	.dim {
		color: var(--ink-dim);
	}
	@media (prefers-reduced-motion: no-preference) {
		.stage {
			animation: rise var(--motion-slow) both;
		}
	}
</style>
