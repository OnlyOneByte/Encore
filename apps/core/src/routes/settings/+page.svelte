<script lang="ts">
	// Settings, as a page. Two sections because settings have two scopes: GLOBAL belongs to the
	// deployment and its worker fleet (an engine exists here only if a worker advertises it), ROOM to
	// this party. Labelling them is the point — "affects every room" is the difference between a safe
	// tweak and a surprise, and that distinction vanishes if both share one flat list.
	//
	// No socket on this page, so a change from a second phone shows only after a reload. Cosmetic, not
	// dangerous: every write is a per-field patch the server re-normalizes over CURRENT values, so a
	// stale page can only change the field it sends, never clobber a newer choice it never touched.
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		SEPARATOR_ENGINES,
		TV_PROGRESS_STYLES,
		qualityRank,
		type EffectiveSettings,
		type GlobalSettings,
		type RoomSettings,
		type SeparatorEngineId,
		type TvProgressStyle
	} from '@encore/shared';

	interface Props {
		data: { settings: EffectiveSettings };
	}
	let { data }: Props = $props();

	// Local state, not a plain derived, because a write is applied optimistically before the server
	// answers. The effect re-adopts `data` so a load re-run (client-side nav back here, or
	// invalidation) shows fresh server values, not the mount-time snapshot.
	let settings = $state<EffectiveSettings>(untrack(() => data.settings));
	$effect(() => {
		settings = data.settings;
	});

	let advancedOpen = $state(false);
	let failed = $state(false);

	// Only engines a live cook may use appear in the primary picker; `ensemble` runs several models and
	// is upgrade-only, so offering it here would let a singer pick something the server rejects.
	const liveEngines = SEPARATOR_ENGINES.filter((e) => e.liveSelectable);

	const engineOf = (id: string) => SEPARATOR_ENGINES.find((e) => e.id === id);

	// Models are scoped to the chosen engine — the whole reason engine and model are separate axes.
	let liveModels = $derived(engineOf(settings.global.defaultEngine)?.models ?? []);
	let upgradeModels = $derived(engineOf(settings.global.upgradeEngine)?.models ?? []);

	let liveNote = $derived(liveModels.find((m) => m.id === settings.global.defaultModel)?.note ?? '');

	// A slow engine on the LIVE path is the footgun worth naming in the UI: RoFormer measured ~44min
	// per song on CPU versus ~50s for htdemucs. Someone should learn that here, not at a party.
	let liveSlow = $derived(engineOf(settings.global.defaultEngine)?.speed === 'slow');

	// An "upgrade" that is not actually better never runs, so say so rather than letting the toggle
	// look active while nothing happens.
	let tvProgressNote = $derived(
		TV_PROGRESS_STYLES.find((s) => s.id === settings.room.tvProgressStyle)?.note ?? ''
	);

	let upgradeIsBetter = $derived(
		qualityRank(settings.global.upgradeEngine, settings.global.upgradeModel) >
			qualityRank(settings.global.defaultEngine, settings.global.defaultModel)
	);

	/**
	 * Apply a patch optimistically, then reconcile on the authoritative response — the same shape the
	 * queue uses, so a tap renders instantly and a rejected write rolls back rather than leaving a
	 * value on screen that the server refused.
	 */
	async function patch(scope: 'global' | 'room', body: Record<string, unknown>) {
		const before = settings;
		settings =
			scope === 'global'
				? { ...settings, global: { ...settings.global, ...body } }
				: { ...settings, room: { ...settings.room, ...body } };
		failed = false;
		try {
			const res = await fetch(scope === 'global' ? '/api/settings' : '/api/settings/room', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) throw new Error('rejected');
			settings = await res.json();
		} catch {
			settings = before;
			failed = true;
		}
	}

	const onglobal = (body: Partial<GlobalSettings>) => patch('global', body);
	const onroom = (body: Partial<RoomSettings>) => patch('room', body);

	function pickEngine(id: string) {
		const engine = engineOf(id);
		if (!engine) return;
		// Switching engine must also move the model, or the pair would be invalid and the server would
		// normalize it back — which reads to the user as "my choice didn't stick".
		onglobal({ defaultEngine: id as SeparatorEngineId, defaultModel: engine.models[0]!.id });
	}

	function pickUpgradeEngine(id: string) {
		const engine = engineOf(id);
		if (!engine) return;
		onglobal({ upgradeEngine: id as SeparatorEngineId, upgradeModel: engine.models[0]!.id });
	}
</script>

<svelte:head><title>Settings · Encore</title></svelte:head>

<div class="settings-page">
<header>
	<!-- A real link, so back is the browser's back and the route is shareable. -->
	<a class="back" href="/" aria-label="Back to the remote">←</a>
	<h1>⚙️ Settings</h1>
</header>

<main>
	{#if failed}
		<p class="warn" role="alert">That change could not be saved. Reverted to the last good value.</p>
	{/if}

	<!-- ── GLOBAL ─────────────────────────────────────────────────────────── -->
	<section>
		<h2>Global</h2>
		<p class="scope-note">Affects every room on this server.</p>

		<label class="field" for="engine">Stem splitter</label>
		<select
			id="engine"
			value={settings.global.defaultEngine}
			onchange={(e) => pickEngine(e.currentTarget.value)}
		>
			{#each liveEngines as engine (engine.id)}
				<option value={engine.id}>{engine.label}</option>
			{/each}
		</select>

		<label class="field" for="model">Model</label>
		<select
			id="model"
			value={settings.global.defaultModel}
			onchange={(e) => onglobal({ defaultModel: e.currentTarget.value })}
		>
			{#each liveModels as model (model.id)}
				<option value={model.id}>{model.label}</option>
			{/each}
		</select>
		{#if liveNote}<p class="hint">{liveNote}</p>{/if}
		{#if liveSlow}
			<p class="warn">Slow on CPU — around 45 minutes per song. Better suited to upgrades.</p>
		{/if}

		<button class="disclose" onclick={() => (advancedOpen = !advancedOpen)} aria-expanded={advancedOpen}>
			{advancedOpen ? '▾' : '▸'} Advanced
		</button>

		{#if advancedOpen}
			<div class="advanced">
				<label class="check">
					<input
						type="checkbox"
						checked={settings.global.enqueueUpgrade}
						onchange={(e) => onglobal({ enqueueUpgrade: e.currentTarget.checked })}
					/>
					Re-cook at higher quality after each song
				</label>
				<p class="hint">Runs from the audio already saved — no re-download.</p>

				<label class="field" for="upgrade-engine">Upgrade splitter</label>
				<select
					id="upgrade-engine"
					value={settings.global.upgradeEngine}
					onchange={(e) => pickUpgradeEngine(e.currentTarget.value)}
				>
					{#each SEPARATOR_ENGINES as engine (engine.id)}
						<option value={engine.id}>{engine.label}</option>
					{/each}
				</select>

				<label class="field" for="upgrade-model">Upgrade model</label>
				<select
					id="upgrade-model"
					value={settings.global.upgradeModel}
					onchange={(e) => onglobal({ upgradeModel: e.currentTarget.value })}
				>
					{#each upgradeModels as model (model.id)}
						<option value={model.id}>{model.label}</option>
					{/each}
				</select>

				{#if settings.global.enqueueUpgrade && !upgradeIsBetter}
					<p class="warn">This is not better than the splitter above, so no upgrade will run.</p>
				{/if}
			</div>
		{/if}
	</section>

	<!-- ── ROOM ───────────────────────────────────────────────────────────── -->
	<section>
		<h2>This room</h2>
		<p class="scope-note">Only this party.</p>

		<label class="field" for="tv-progress">TV song progress</label>
		<select
			id="tv-progress"
			value={settings.room.tvProgressStyle}
			onchange={(e) => onroom({ tvProgressStyle: e.currentTarget.value as TvProgressStyle })}
		>
			{#each TV_PROGRESS_STYLES as s (s.id)}
				<option value={s.id}>{s.label}</option>
			{/each}
		</select>
		{#if tvProgressNote}<p class="hint">{tvProgressNote}</p>{/if}

		<label class="field" for="interstitial">
			Next-up reveal · {(settings.room.interstitialMs / 1000).toFixed(1)}s
		</label>
		<input
			id="interstitial"
			type="range"
			min="0"
			max="15000"
			step="500"
			value={settings.room.interstitialMs}
			onchange={(e) => onroom({ interstitialMs: Number(e.currentTarget.value) })}
		/>
		<p class="hint">
			{settings.room.interstitialMs === 0
				? 'Straight into the next song.'
				: 'How long the TV shows who is up next.'}
		</p>
	</section>

	<button class="done" onclick={() => goto('/')}>Done</button>
</main>
</div>

<style>
	/*
	 * The app shell caps every phone surface at --max-w (480px). Settings is the one surface you sit
	 * down with rather than thumb through mid-song, so it opts out once there is real width. The
	 * controls stay on a readable measure — a select stretched across a 2560px monitor is worse, not
	 * better — so the extra space shows both scopes at once instead of inflating every widget.
	 */
	:global(.app-shell:has(.settings-page)) {
		max-width: none;
	}

	header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 16px 18px 10px;
		border-bottom: 1px solid var(--line);
		position: sticky;
		top: 0;
		background: var(--bg);
		z-index: 1;
	}
	.back {
		color: var(--ink-dim);
		text-decoration: none;
		font-size: 1.2rem;
		padding: 4px 6px;
		border-radius: 8px;
	}
	.back:focus-visible {
		outline: 2px solid var(--accent, currentColor);
	}
	h1 {
		margin: 0;
		font-size: 1.1rem;
	}
	main {
		max-width: 1040px;
		margin: 0 auto;
		padding: 4px 18px calc(28px + env(safe-area-inset-bottom, 0px));
	}
	section + section {
		margin-top: 24px;
		padding-top: 18px;
		border-top: 1px solid var(--line);
	}

	/*
	 * Wide enough for two readable columns: the scopes sit side by side, and the rule that separated
	 * them stacked becomes the gap between them. Below this, the single column is the phone layout.
	 */
	@media (min-width: 860px) {
		main {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 0 48px;
			align-items: start;
			padding-top: 12px;
		}
		section + section {
			margin-top: 0;
			padding-top: 0;
			border-top: 0;
		}
		.warn[role='alert'],
		.done {
			grid-column: 1 / -1;
		}
		.done {
			justify-self: center;
			max-width: 320px;
		}
	}
	h2 {
		margin: 16px 0 2px;
		font-size: 0.95rem;
	}
	.scope-note {
		margin: 0 0 10px;
		font-size: 0.78rem;
		color: var(--ink-dim);
	}
	.field {
		display: block;
		margin: 12px 0 4px;
		font-size: 0.82rem;
		color: var(--ink-dim);
	}
	select,
	input[type='range'] {
		width: 100%;
		max-width: 420px;
		box-sizing: border-box;
	}
	select {
		padding: 9px 10px;
		border-radius: 10px;
		border: 1px solid var(--line);
		background: var(--card);
		color: var(--ink);
		font-size: 0.9rem;
	}
	.hint {
		margin: 6px 0 0;
		font-size: 0.76rem;
		color: var(--ink-dim);
	}
	.warn {
		margin: 6px 0 0;
		font-size: 0.76rem;
		color: var(--warn);
	}
	.disclose {
		margin-top: 16px;
		background: none;
		border: 0;
		padding: 6px 0;
		color: var(--ink);
		font-size: 0.85rem;
		cursor: pointer;
	}
	.advanced {
		margin-top: 4px;
		padding-left: 10px;
		border-left: 2px solid var(--line);
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.86rem;
		margin-top: 8px;
	}
	.check input {
		width: 18px;
		height: 18px;
	}
	.done {
		display: block;
		width: 100%;
		margin-top: 28px;
		padding: 12px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--card);
		color: var(--ink);
		font-size: 0.95rem;
		cursor: pointer;
	}
</style>
