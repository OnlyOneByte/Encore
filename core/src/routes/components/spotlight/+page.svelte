<script lang="ts">
	import Spotlight from '$lib/ui/Spotlight.svelte';
	import GuideSegments from '$lib/ui/GuideSegments.svelte';
	import { PALETTE_STOPS } from '$lib/contract/presentation/player-palette';

	// Fixture data, a person's chosen colour: one warm stop, one cool, so both ink kinds are on screen.
	const THEO = PALETTE_STOPS[0]!.fill;
	const ANA = PALETTE_STOPS[30]!.fill;

	let replay = $state(0);
	let handoff = $state<'on-deck' | 'your-turn'>('on-deck');
	let busy = $state(false);
	let guide = $state<number | null>(0);
	let dropped = $state<number | null>(0.3);

	function busyFor(ms: number) {
		busy = true;
		setTimeout(() => (busy = false), ms);
	}
</script>

<main class="story">
	<h1>Spotlight</h1>
	<div class="tools">
		<button type="button" data-testid="replay" onclick={() => replay++}>Replay</button>
		<button
			type="button"
			data-testid="handoff-toggle"
			onclick={() => (handoff = handoff === 'on-deck' ? 'your-turn' : 'on-deck')}>Hand off</button
		>
		<button type="button" data-testid="busy-short" onclick={() => busyFor(150)}>Busy 150 ms</button>
		<button type="button" data-testid="busy-long" onclick={() => busyFor(900)}>Busy 900 ms</button>
	</div>

	{#key replay}
		<div class="grid">
			<div data-testid="spot-idle">
				<Spotlight title="Pick a song" meta="Sing" busy={busy} busyLabel="Searching" />
			</div>
			<div data-testid="spot-on-deck">
				<Spotlight moment="on-deck" title="You're next" meta="After Maya · about 1 min" colour={THEO}>
					<p class="song">Mayday</p>
					<div class="row">
						<span>Guide</span>
						<GuideSegments level={guide} onpick={(l) => void (guide = l)} />
					</div>
				</Spotlight>
			</div>
			<div data-testid="spot-handoff">
				<Spotlight moment={handoff} title={handoff === 'on-deck' ? "You're next" : "You're up"} meta="Ana" colour={ANA}>
					<p class="song">The Chosen</p>
				</Spotlight>
			</div>
			<div data-testid="spot-error">
				<Spotlight moment="error" title="Your song didn't play" meta="Mayday">
					<p class="song">Try again, or pick another.</p>
				</Spotlight>
			</div>
		</div>
	{/key}

	<h2>Guide segments</h2>
	<div class="row plain" data-testid="guide-plain">
		<span>Guide</span>
		<GuideSegments level={guide} onpick={(l) => void (guide = l)} />
	</div>
	<div class="row plain" data-testid="guide-dropped">
		<span>Guide, link down</span>
		<GuideSegments level={dropped} onpick={() => false} />
	</div>
	<div class="row plain" data-testid="guide-custom">
		<span>Guide at 60%</span>
		<GuideSegments level={0.6} onpick={() => {}} />
	</div>

	<div class="light" data-theme="light" data-testid="light">
		<Spotlight title="Pick a song" meta="Light theme" />
		<div class="row plain">
			<span>Guide</span>
			<GuideSegments level={1} onpick={() => {}} />
		</div>
	</div>
</main>

<style>
	.story {
		padding: var(--step-4);
		display: flex;
		flex-direction: column;
		gap: var(--step-5);
	}
	h1,
	h2 {
		margin: 0;
		font-size: var(--type-title);
	}
	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: var(--step-2);
	}
	.tools button {
		min-height: var(--tap);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
		gap: var(--step-4);
	}
	.song {
		margin: 0;
		font-size: var(--type-title);
		font-weight: 600;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--step-3);
		margin-top: var(--step-2);
		font-weight: 700;
	}
	.light {
		display: flex;
		flex-direction: column;
		gap: var(--step-3);
		padding: var(--step-4);
		background: var(--role-ground);
		color: var(--role-ink);
	}
</style>
