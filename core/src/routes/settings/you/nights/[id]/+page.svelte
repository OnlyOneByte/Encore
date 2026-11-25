<!-- "Your night" (proposal 29 PR 3): a few slides in your colour, one fact each. Tap the right of the screen for the
	next, the left for the one before; the arrow keys do the same. The dock stays, so a song or "You're up" is never
	hidden by it. docs/FRONTEND.md#your-night -->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { nearestPaletteStop } from '$lib/contract/presentation/player-palette';
	import { setlistDetail, type Slide } from '$lib/night-story';
	import { saveNightPicture, type PictureSlide } from '$lib/night-picture';

	interface Props {
		data: { name: string; colour: string; day: string; from: string; to: string; slides: Slide[] };
	}
	let { data }: Props = $props();

	const stop = $derived(nearestPaletteStop(data.colour));
	let at = $state(0);
	const slide = $derived(data.slides[at]!);
	const heading = $derived(`${data.day} at Encore`);
	let saveNote = $state('');

	const first = $derived(at === 0);
	const last = $derived(at === data.slides.length - 1);
	/** A no-op at either end: the buttons stay focusable (aria-disabled), so focus never drops to the page there. */
	function go(step: number) {
		at = Math.min(data.slides.length - 1, Math.max(0, at + step));
	}
	let story: HTMLElement;
	/** Arrows only while focus is on the story or nowhere: never from the dock's own controls. */
	function onkeydown(e: KeyboardEvent) {
		const t = e.target;
		// "Nowhere" is <body> or the root: after the navigation that opens the story, focus sits on the root.
		const nowhere = t === document.body || t === document.documentElement;
		if (!nowhere && !(t instanceof Node && story.contains(t))) return;
		if (e.key === 'ArrowRight') go(1);
		else if (e.key === 'ArrowLeft') go(-1);
	}

	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	/** The current slide as lines for the picture: what is on screen, nothing more. */
	function pictureOf(s: Slide): PictureSlide {
		if (s.kind === 'cover')
			return {
				kick: `${data.name}, here's your night`,
				big: plural(s.songs, 'song', 'songs'),
				sub: [`${data.from} to ${data.to}`]
			};
		if (s.kind === 'loudest')
			return {
				kick: 'The room loved',
				big: String(s.cheers),
				sub: [s.cheers === 1 ? 'cheer for' : 'cheers for'],
				song: s.title,
				after: s.ofSeveral ? ['Your loudest song tonight'] : []
			};
		return {
			kick: 'Your setlist',
			rows: s.rows.map((r) => [r.title, setlistDetail(r)] as [string, string]),
			sub: s.keyLine ? [s.keyLine] : []
		};
	}
	async function save() {
		saveNote = '';
		try {
			await saveNightPicture(pictureOf(slide), { heading, fill: stop.fill, ink: stop.on_fill });
		} catch {
			saveNote = 'Could not make the picture — try again.';
		}
	}
</script>

<svelte:window onkeydown={onkeydown} />

<section
	class="story"
	bind:this={story}
	style:--spot={stop.fill}
	style:--on-spot={stop.on_fill}
	aria-label="Your night"
>
	<span class="fill" aria-hidden="true"></span>
	<div class="bars" aria-hidden="true">
		{#each data.slides, i (i)}<i class={{ done: i < at, now: i === at }}></i>{/each}
	</div>
	<div class="top">
		<span>{heading}</span>
		<a class="close" href={resolve('/settings/you')} aria-label="Close your night">×</a>
	</div>
	<p class="vh" role="status">Slide {at + 1} of {data.slides.length}</p>

	{#key at}
		<div class="slide" data-slide={slide.kind}>
			{#if slide.kind === 'cover'}
				<p class="kick">{data.name}, here's your night</p>
				<h1 class="hero">{plural(slide.songs, 'song', 'songs')}</h1>
				<p class="sub">{data.from} to {data.to}</p>
			{:else if slide.kind === 'loudest'}
				<p class="kick">The room loved</p>
				<p class="big">{slide.cheers}</p>
				<p class="sub">{slide.cheers === 1 ? 'cheer for' : 'cheers for'}</p>
				<p class="song">{slide.title}</p>
				{#if slide.ofSeveral}<p class="sub">Your loudest song tonight</p>{/if}
			{:else}
				<h1 class="kick">Your setlist</h1>
				<ol class="list">
					{#each slide.rows as row, i (i)}
						<li><span class="t">{row.title}</span><span class="d">{setlistDetail(row)}</span></li>
					{/each}
				</ol>
				{#if slide.keyLine}<p class="sub">{slide.keyLine}</p>{/if}
			{/if}
		</div>
	{/key}

	<!-- Two halves to tap, as real buttons so a keyboard and a screen reader get them too. aria-disabled at the ends,
		never `disabled`, which would drop the focus of whoever pressed into the last slide. -->
	<button class="tap back" aria-label="Previous slide" aria-disabled={first} onclick={() => go(-1)}></button>
	<button class="tap next" aria-label="Next slide" aria-disabled={last} onclick={() => go(1)}></button>

	<div class="foot">
		{#if saveNote}<p class="note" role="alert">{saveNote}</p>{/if}
		<button class="save" onclick={save}>Save picture</button>
	</div>
</section>

<style>
	/* Fills what the dock leaves: the dock stays, so the room's now-line and "You're up" are never under the story. */
	.story {
		position: relative;
		isolation: isolate;
		display: flex;
		flex-direction: column;
		/* The dock's height is reserved INSIDE the story, under the footer: without it the page ended behind the dock, so
		   at full scroll the sticky footer sat over the last setlist row (#1281 review). 91px is the layout's own seed
		   for --dock-h, which lands after hydration: a 0 fallback made the centred slide jump on a cold load. */
		min-height: 100dvh;
		padding-bottom: var(--dock-h, 91px);
		color: var(--on-spot);
	}
	/* The flood is a layer, so lighting the phone is an opacity change (the Spotlight rule: transform and opacity only).
	   Fixed, so it fills the screen past the shell's gutters; the dock sits above it. */
	.fill {
		position: fixed;
		inset: 0;
		z-index: -1;
		background: var(--spot);
	}
	.bars {
		display: flex;
		gap: var(--step-4);
		padding: var(--step-12) var(--step-16) 0;
	}
	.bars i {
		flex: 1;
		height: 3px;
		border-radius: 2px;
		background: color-mix(in srgb, var(--on-spot) 18%, transparent);
	}
	.bars i.done,
	.bars i.now {
		background: var(--on-spot);
	}
	.top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: var(--step-4) var(--step-16) 0;
		font-size: var(--type-meta);
		font-weight: 700;
	}
	.top span,
	.sub,
	.kick,
	.list .d {
		/* 0.8, not lower: the Spotlight's floor for 4.5:1 on every singer stop (spotlight-tokens.test.ts). */
		opacity: 0.8;
	}
	.close {
		position: relative;
		z-index: 2;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		margin-inline-end: calc(-1 * var(--step-8));
		color: inherit;
		font-size: var(--type-lead);
		font-weight: 700;
		text-decoration: none;
	}
	.close:focus-visible,
	.save:focus-visible,
	.tap:focus-visible {
		outline: 3px solid var(--on-spot);
		outline-offset: 2px;
	}
	.slide {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		padding: var(--step-24) var(--step-16);
		min-width: 0;
	}
	.slide p,
	.slide h1 {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.kick {
		font-size: var(--type-title);
		font-weight: 700;
	}
	.hero {
		margin-top: var(--step-8);
		font-size: var(--type-hero);
		font-weight: 800;
		letter-spacing: -0.03em;
		line-height: var(--lh-none);
	}
	.big {
		font-size: calc(var(--type-hero) * 1.43);
		font-weight: 800;
		letter-spacing: -0.04em;
		line-height: var(--lh-none);
		font-variant-numeric: tabular-nums;
	}
	.song {
		margin-top: var(--step-12);
		font-size: var(--type-display);
		font-weight: 800;
		letter-spacing: -0.02em;
		line-height: var(--lh-tight);
	}
	.sub {
		margin-top: var(--step-8);
		font-size: var(--type-title);
		font-weight: 600;
	}
	.list {
		margin: var(--step-24) 0 0;
		padding: 0;
		list-style: none;
	}
	.list li {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--step-12);
		min-height: 48px;
		padding-top: var(--step-12);
		border-top: 2px solid color-mix(in srgb, var(--on-spot) 18%, transparent);
		font-size: var(--type-title);
		font-weight: 700;
	}
	.list .t {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.list .d {
		flex: none;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	/* The halves sit over the slide, under the header and the footer, which keep their own taps. */
	.tap {
		position: absolute;
		top: 72px;
		bottom: 96px;
		width: 50%;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
	}
	.tap[aria-disabled='true'] {
		cursor: default;
	}
	.back {
		left: 0;
	}
	.next {
		right: 0;
	}
	/* Sticky above the dock, so on a long night Save stays on screen while the setlist scrolls under it (tenet 4). */
	.foot {
		position: sticky;
		bottom: var(--dock-h, 91px);
		z-index: 2;
		padding: var(--step-16);
		background: var(--spot);
	}
	.note {
		margin: 0 0 var(--step-8);
		font-size: var(--type-meta);
		font-weight: 600;
	}
	.save {
		width: 100%;
		min-height: 52px;
		border: 0;
		border-radius: var(--round-pill);
		background: var(--on-spot);
		color: var(--spot);
		font: inherit;
		font-size: var(--type-title);
		font-weight: 800;
		cursor: pointer;
	}
	@media (prefers-reduced-motion: no-preference) {
		.fill {
			animation: flood var(--motion-slow) var(--ease-out) both;
		}
		.hero,
		.big {
			animation: pop-in var(--motion-slow) var(--ease-out) both;
		}
	}
	@keyframes flood {
		from {
			opacity: 0;
		}
	}
	@keyframes pop-in {
		from {
			opacity: 0;
			transform: scale(0.92);
		}
	}
</style>
