<script lang="ts">
	// Settings overlay for the phone remote.
	//
	// A sheet rather than a route for two reasons. A page at /settings would share a prefix with the
	// /api/settings namespace, which the dev proxy and Caddy both forward wholesale — that 404s on a
	// direct load or hard reload while client-side nav hides the breakage. And mid-party nobody wants
	// to lose their search results to change a dropdown.
	//
	// Two sections because settings have two scopes. GLOBAL belongs to the deployment and its worker
	// fleet (an engine only exists if a worker advertises it). ROOM belongs to this party. Labelling
	// them is the point: "affects every room" is the difference between a safe tweak and a surprise.
	//
	// Reachability follows QueueSheet: Escape closes, the backdrop is clickable, and every control is
	// a real focusable element. No gesture is the only way to do anything.
	import {
		SEPARATOR_ENGINES,
		qualityRank,
		type EffectiveSettings,
		type GlobalSettings,
		type RoomSettings,
		type SeparatorEngineId
	} from '@encore/shared';

	interface Props {
		open: boolean;
		settings: EffectiveSettings;
		/** Persist a global patch. The caller owns the request; this component only reports intent. */
		onglobal: (patch: Partial<GlobalSettings>) => void;
		/** Persist a room patch. */
		onroom: (patch: Partial<RoomSettings>) => void;
		onclose: () => void;
	}
	let { open, settings, onglobal, onroom, onclose }: Props = $props();

	let advancedOpen = $state(false);

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
	let upgradeIsBetter = $derived(
		qualityRank(settings.global.upgradeEngine, settings.global.upgradeModel) >
			qualityRank(settings.global.defaultEngine, settings.global.defaultModel)
	);

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

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if open}
	<!-- Backdrop: a button so it is reachable and announced, not a div with a click handler. -->
	<button class="backdrop" aria-label="Close settings" onclick={onclose}></button>

	<section class="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
		<header>
			<h2 id="settings-title">⚙️ Settings</h2>
			<button class="close" onclick={onclose} aria-label="Close settings">✕</button>
		</header>

		<div class="body">
			<!-- ── GLOBAL ─────────────────────────────────────────────────────── -->
			<div class="scope">
				<h3>Global</h3>
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
			</div>

			<!-- ── ROOM ───────────────────────────────────────────────────────── -->
			<div class="scope">
				<h3>This room</h3>
				<p class="scope-note">Only this party.</p>

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
			</div>
		</div>
	</section>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		border: 0;
		padding: 0;
		z-index: 40;
	}
	.sheet {
		position: fixed;
		inset: auto 0 0 0;
		max-height: 82vh;
		overflow-y: auto;
		background: var(--card);
		border-top: 1px solid var(--line);
		border-radius: 18px 18px 0 0;
		box-shadow: var(--shadow);
		z-index: 41;
		padding-bottom: env(safe-area-inset-bottom, 8px);
	}
	header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 18px 8px;
		position: sticky;
		top: 0;
		background: var(--card);
		border-bottom: 1px solid var(--line);
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.close {
		margin-left: auto;
		background: none;
		border: 0;
		color: var(--ink-dim);
		font-size: 1rem;
		padding: 6px 8px;
		cursor: pointer;
	}
	.body {
		padding: 4px 18px 18px;
	}
	.scope + .scope {
		margin-top: 22px;
		padding-top: 16px;
		border-top: 1px solid var(--line);
	}
	h3 {
		margin: 14px 0 2px;
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
</style>
