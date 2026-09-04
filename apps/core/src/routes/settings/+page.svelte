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
	import Icon from '$lib/ui/Icon.svelte';
	import {
		SEPARATOR_ENGINES,
		TV_PROGRESS_STYLES,
		TV_BACKGROUND_STYLES,
		TV_VISUALIZERS,
		ASR_MODELS,
		SYNC_MODES,
		LYRICS_BALL_STYLES,
		LYRICS_HIGHLIGHTS,
		LYRICS_FONTS,
		LYRICS_CASES,
		MAX_LYRICS_LEAD_MS,
		MIN_LYRICS_SCALE_PCT,
		MAX_LYRICS_SCALE_PCT,
		MAX_LYRICS_LINES_BEFORE,
		MAX_LYRICS_LINES_AFTER,
		qualityRank,
		normalizeJoinOrigin,
		resolveLyricsPresentation,
		stageHueToHex,
		SINGER_HUE_STEP,
		MIN_SONG_INTRO_MS,
		MAX_SONG_INTRO_MS,
		SONG_INTRO_STEP_MS,
		MIN_PRESENCE_GRACE_MINUTES,
		MAX_PRESENCE_GRACE_MINUTES,
		QUEUE_ORDERS,
		getQueueOrder,
		type QueueOrderId,
		type EffectiveSettings,
		type GlobalSettings,
		type LyricsBallStyleId,
		type LyricsCaseId,
		type LyricsFontId,
		type LyricsHighlightId,
		type RoomSettings,
		type SeparatorEngineId,
		type TvProgressStyle,
		type TvBackgroundStyle,
		type TvVisualizerId
	} from '@encore/shared';

	interface Props {
		data: {
			settings: EffectiveSettings;
			/** What an empty join address resolves to — env var, else the address this page was opened at. */
			joinOriginFallback: string;
			/** Whether this phone reached the server over https. Only the server can answer this. */
			requestIsHttps: boolean;
		};
	}
	let { data }: Props = $props();

	// Local state, not a plain derived, because a write is applied optimistically before the server
	// answers. The effect re-adopts `data` so a load re-run (client-side nav back here, or
	// invalidation) shows fresh server values, not the mount-time snapshot.
	let settings = $state<EffectiveSettings>(untrack(() => data.settings));

	// Minutes read badly past an hour ("120 minutes"), and 0 needs saying in words rather than as a
	// number that looks like a missing value.
	const graceLabel = $derived.by(() => {
		const m = settings.room.presenceGraceMinutes;
		if (m === 0) return 'no grace';
		if (m < 60) return `${m} min`;
		const h = Math.floor(m / 60);
		const rem = m % 60;
		return rem === 0 ? `${h} hr` : `${h} hr ${rem} min`;
	});
	$effect(() => {
		settings = data.settings;
	});

	// The chosen algorithm's own note, so the consequence is stated by the registry rather than
	// duplicated here — the same reason the TV-progress and lyrics pickers read theirs.
	const queueOrderNote = $derived(getQueueOrder(settings.room.queueOrder)?.note ?? '');

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

	// ── lyrics ───────────────────────────────────────────────────────────────
	// The two knobs on the words rather than the audio. Same shape as the splitter pair above: the
	// note comes from the registry so a model cannot appear here without its tradeoff stated.
	let asrNote = $derived(ASR_MODELS.find((m) => m.id === settings.global.asrModel)?.note ?? '');
	let syncNote = $derived(SYNC_MODES.find((m) => m.id === settings.global.syncMode)?.note ?? '');

	// The same footgun as a slow splitter, and worth naming in the same place: a bigger reader is the
	// one lever on wrong words, and it is also the one that turns a two-minute cook into a long wait on
	// a CPU box. Nobody should discover that at a party.
	let asrSlow = $derived(
		['slow', 'slowest'].includes(ASR_MODELS.find((m) => m.id === settings.global.asrModel)?.speed ?? '')
	);

	// An "upgrade" that is not actually better never runs, so say so rather than letting the toggle
	// look active while nothing happens.
	let tvProgressNote = $derived(
		TV_PROGRESS_STYLES.find((s) => s.id === settings.room.tvProgressStyle)?.note ?? ''
	);

	let tvBackgroundNote = $derived(
		TV_BACKGROUND_STYLES.find((s) => s.id === settings.room.tvBackgroundStyle)?.note ?? ''
	);
	// The swatch shows the ACTUAL rendered stage colour, generated by the same shared function the TV
	// uses — so the phone cannot promise a colour the TV then renders differently.
	let tvBackgroundPreview = $derived(stageHueToHex(settings.room.tvBackgroundHue));
	let tvVisualizerNote = $derived(
		TV_VISUALIZERS.find((v) => v.id === settings.room.tvVisualizer)?.note ?? ''
	);
	/*
	 * The slider track, painted with the real reachable colours — the join page's principle ("what you
	 * drag through is what you can get"), applied at the stage tier.
	 *
	 * Generated from stageHueToHex rather than written as static oklch() stops, because the stage tier
	 * has a guard that darkens hues near the active-word pink. Hardcoded stops would show a colour the
	 * TV will not actually produce right where the guard bites.
	 */
	const HUE_TRACK_STOPS = Array.from({ length: Math.round(360 / SINGER_HUE_STEP) + 1 }, (_, i) =>
		stageHueToHex(i * SINGER_HUE_STEP)
	);
	const hueTrack = `linear-gradient(to right, ${HUE_TRACK_STOPS.join(', ')})`;

	let upgradeIsBetter = $derived(
		qualityRank(settings.global.upgradeEngine, settings.global.upgradeModel) >
			qualityRank(settings.global.defaultEngine, settings.global.defaultModel)
	);

	let ballNote = $derived(LYRICS_BALL_STYLES.find((s) => s.id === settings.room.lyricsBall)?.note ?? '');
	let highlightNote = $derived(
		LYRICS_HIGHLIGHTS.find((h) => h.id === settings.room.lyricsHighlight)?.note ?? ''
	);
	// Ask the SAME resolver the TV uses, rather than re-testing syncMode here. If the two ever
	// disagreed, this page would be confidently wrong about what is on screen.
	let resolved = $derived(resolveLyricsPresentation(settings));
	let lyricsClamped = $derived(resolved.clamped);
	let resolvedHighlight = $derived(
		LYRICS_HIGHLIGHTS.find((h) => h.id === resolved.highlight)?.label.toLowerCase() ?? resolved.highlight
	);
	let resolvedBall = $derived(resolved.ball !== 'off');

	let fontNote = $derived(LYRICS_FONTS.find((f) => f.id === settings.room.lyricsFont)?.note ?? '');
	let caseNote = $derived(LYRICS_CASES.find((c) => c.id === settings.room.lyricsCase)?.note ?? '');

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

	// ── joining ──────────────────────────────────────────────────────────────
	// The one free-text setting, so it needs a draft rather than patching per keystroke: `http` is not
	// yet a valid origin, and a normalizer running on every character would fight the typist.
	let joinDraft = $state(untrack(() => data.settings.global.joinOrigin));
	let joinError = $state('');
	// Re-adopt only when the PERSISTED value moves (a load re-run, or a write from another phone).
	// A plain `$effect` mirroring `settings` would also fire when an unrelated field is patched and
	// would discard whatever the user had half-typed here.
	let syncedJoin = untrack(() => data.settings.global.joinOrigin);
	$effect(() => {
		const stored = settings.global.joinOrigin;
		if (stored !== syncedJoin) {
			syncedJoin = stored;
			joinDraft = stored;
		}
	});

	// An https join address on a plain-http party is the mistake worth naming: the QR would be
	// unopenable from the LAN. The reverse (http address behind an https tunnel) still opens, so it is
	// not warned about.
	let joinSchemeMismatch = $derived(settings.global.joinOrigin.startsWith('https://') && !data.requestIsHttps);

	function commitJoinOrigin() {
		const normalized = normalizeJoinOrigin(joinDraft);
		if (normalized === null) {
			// Refused locally rather than sent: the server would normalize an unusable value back to the
			// current one, which reads to the user as "my typing vanished" with no reason given.
			joinError = 'Not an address a phone can open. Include http:// or https://, e.g. http://192.168.1.20:3000.';
			return;
		}
		joinError = '';
		// Show what will actually be stored — a pasted `/tv` or trailing slash is dropped.
		joinDraft = normalized;
		syncedJoin = normalized;
		if (normalized === settings.global.joinOrigin) return;
		onglobal({ joinOrigin: normalized });
	}
</script>

<svelte:head><title>Settings · Encore</title></svelte:head>

<div class="settings-page">
<header>
	<!-- A real link, so back is the browser's back and the route is shareable. -->
	<a class="back" href="/" aria-label="Back to the remote"><Icon name="arrow-left" /></a>
	<h1><Icon name="gear" /> Settings</h1>
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

		<h3 class="sub">Lyrics</h3>

		<label class="field" for="asr-model">Lyrics reader</label>
		<select
			id="asr-model"
			value={settings.global.asrModel}
			onchange={(e) => onglobal({ asrModel: e.currentTarget.value as GlobalSettings['asrModel'] })}
		>
			{#each ASR_MODELS as model (model.id)}
				<option value={model.id}>{model.label} · {model.params}</option>
			{/each}
		</select>
		{#if asrNote}<p class="hint">{asrNote}</p>{/if}
		{#if asrSlow}
			<p class="warn">A big reader needs real memory and adds minutes to every cook on a CPU box.</p>
		{/if}

		<label class="field" for="sync-mode">Lyrics timing</label>
		<select
			id="sync-mode"
			value={settings.global.syncMode}
			onchange={(e) => onglobal({ syncMode: e.currentTarget.value as GlobalSettings['syncMode'] })}
		>
			{#each SYNC_MODES as mode (mode.id)}
				<option value={mode.id}>{mode.label}</option>
			{/each}
		</select>
		{#if syncNote}<p class="hint">{syncNote}</p>{/if}

		<h3 class="sub">Joining</h3>

		<label class="field" for="join-origin">Address phones join at</label>
		<input
			id="join-origin"
			class="text"
			type="text"
			inputmode="url"
			autocomplete="off"
			spellcheck="false"
			placeholder={data.joinOriginFallback}
			aria-describedby="join-origin-hint"
			aria-invalid={joinError ? 'true' : undefined}
			bind:value={joinDraft}
			onchange={commitJoinOrigin}
		/>
		<p class="hint" id="join-origin-hint">
			What the TV prints and puts in its QR code. Set it when the TV cannot reach the server at its own
			address — leave it empty and the TV advertises <strong>{data.joinOriginFallback}</strong>.
		</p>
		{#if joinError}<p class="warn" role="alert">{joinError}</p>{/if}
		{#if joinSchemeMismatch}
			<p class="warn">
				This party is running over plain http, so phones cannot open an https address.
			</p>
		{/if}

		<button class="disclose" onclick={() => (advancedOpen = !advancedOpen)} aria-expanded={advancedOpen}>
			<Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} /> Advanced
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

		<label class="field" for="queue-order">Who sings next</label>
		<select
			id="queue-order"
			value={settings.room.queueOrder}
			onchange={(e) => onroom({ queueOrder: e.currentTarget.value as QueueOrderId })}
		>
			{#each QUEUE_ORDERS as o (o.id)}
				<option value={o.id}>{o.label}</option>
			{/each}
		</select>
		{#if queueOrderNote}<p class="hint">{queueOrderNote}</p>{/if}
		<p class="hint">Changing this re-orders the songs waiting. It never interrupts the one playing.</p>

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

		<label class="field" for="tv-background">TV background</label>
		<select
			id="tv-background"
			value={settings.room.tvBackgroundStyle}
			onchange={(e) => onroom({ tvBackgroundStyle: e.currentTarget.value as TvBackgroundStyle })}
		>
			{#each TV_BACKGROUND_STYLES as s (s.id)}
				<option value={s.id}>{s.label}</option>
			{/each}
		</select>
		{#if tvBackgroundNote}<p class="hint">{tvBackgroundNote}</p>{/if}

		<!--
			The hue slider is shown ONLY for `solid`, because it is the only style that reads the hue.
			Leaving it visible for the others would imply it does something it does not.
		-->
		<!--
			Shown ONLY for the visualizer style, for the same reason the hue slider is gated: a control that
			does nothing for the current selection implies it does something.
		-->
		{#if settings.room.tvBackgroundStyle === 'visualizer'}
			<label class="field" for="tv-visualizer">Which visualizer</label>
			<select
				id="tv-visualizer"
				value={settings.room.tvVisualizer}
				onchange={(e) => onroom({ tvVisualizer: e.currentTarget.value as TvVisualizerId })}
			>
				{#each TV_VISUALIZERS as v (v.id)}
					<option value={v.id}>{v.label}</option>
				{/each}
			</select>
			{#if tvVisualizerNote}<p class="hint">{tvVisualizerNote}</p>{/if}
			<p class="hint">
				These follow the music's pace, not the sound itself — the TV does not listen to the audio. No
				bars or waveform for that reason: they would only be pretending to show it.
			</p>
		{/if}

		<!--
			The hue colours BOTH the `solid` stage and the visualizer, so the slider reveals for either.
		-->
		{#if settings.room.tvBackgroundStyle === 'solid' || settings.room.tvBackgroundStyle === 'visualizer'}
			<label class="field" for="tv-background-hue">
				Background colour
				<span class="swatch" style="background: {tvBackgroundPreview}" aria-hidden="true"></span>
			</label>
			<input
				id="tv-background-hue"
				class="hue"
				type="range"
				min="0"
				max={360 - SINGER_HUE_STEP}
				step={SINGER_HUE_STEP}
				value={settings.room.tvBackgroundHue}
				style="--track: {hueTrack}; --thumb: {tvBackgroundPreview}"
				onchange={(e) => onroom({ tvBackgroundHue: Number(e.currentTarget.value) })}
			/>
			<p class="hint">
				Every colour here is pinned dark on purpose — the words sit on top of it, and a bright stage
				makes them hard to read from the couch. The visualizer is held to the same limit.
			</p>
		{/if}

		<label class="check">
			<input
				type="checkbox"
				checked={settings.room.songIntroEnabled}
				onchange={(e) => onroom({ songIntroEnabled: e.currentTarget.checked })}
			/>
			Song intro before each turn
		</label>
		<p class="hint">A card naming the song, artist and singer.</p>

		<label class="field" class:dim={!settings.room.songIntroEnabled} for="song-intro-ms">
			Song intro duration · {(settings.room.songIntroMs / 1000).toFixed(1)}s
		</label>
		<!--
		  The range MUST match the server clamp exactly (MIN/MAX_SONG_INTRO_MS). A slider narrower than
		  the clamp has shipped here before: the UI silently refuses values the server would have taken.
		-->
		<input
			id="song-intro-ms"
			type="range"
			min={MIN_SONG_INTRO_MS}
			max={MAX_SONG_INTRO_MS}
			step={SONG_INTRO_STEP_MS}
			disabled={!settings.room.songIntroEnabled}
			value={settings.room.songIntroMs}
			onchange={(e) => onroom({ songIntroMs: Number(e.currentTarget.value) })}
		/>
		<p class="hint">
			{settings.room.songIntroEnabled
				? 'How long the TV holds on the card before the song starts.'
				: 'Intro is off — the TV cuts straight into the next song.'}
		</p>

		<label class="field" for="presence-grace">
			Keep people in the room for · {graceLabel}
		</label>
		<input
			id="presence-grace"
			type="range"
			min={MIN_PRESENCE_GRACE_MINUTES}
			max={MAX_PRESENCE_GRACE_MINUTES}
			step="15"
			value={settings.room.presenceGraceMinutes}
			onchange={(e) => onroom({ presenceGraceMinutes: Number(e.currentTarget.value) })}
		/>
		<p class="hint">
			A locked phone does not mean someone left, so they stay on the roster — greyed — until this
			runs out. The clock only starts once they have no songs left in the queue.
		</p>

		<h3 class="sub">Lyrics on the TV</h3>

		<label class="field" for="lyrics-highlight">Highlight</label>
		<select
			id="lyrics-highlight"
			value={settings.room.lyricsHighlight}
			onchange={(e) => onroom({ lyricsHighlight: e.currentTarget.value as LyricsHighlightId })}
		>
			{#each LYRICS_HIGHLIGHTS as h (h.id)}
				<option value={h.id}>{h.label}</option>
			{/each}
		</select>
		{#if highlightNote}<p class="hint">{highlightNote}</p>{/if}

		<label class="field" for="lyrics-ball">Marker</label>
		<select
			id="lyrics-ball"
			value={settings.room.lyricsBall}
			onchange={(e) => onroom({ lyricsBall: e.currentTarget.value as LyricsBallStyleId })}
		>
			{#each LYRICS_BALL_STYLES as s (s.id)}
				<option value={s.id}>{s.label}</option>
			{/each}
		</select>
		{#if ballNote}<p class="hint">{ballNote}</p>{/if}

		<!--
			Say when a choice is not being honoured. The global sync mode decides whether per-word timings
			exist at all, so under "Line sync only" a word-level treatment has nothing to light and a
			marker has no word to sit on. A picker that silently does nothing is worse than one that
			explains itself — and this names the setting to change, since it is on this same page above.
		-->
		{#if lyricsClamped}
			<p class="warn">
				Showing <strong>{resolvedHighlight}</strong>{resolvedBall ? '' : ' with no marker'} instead: this
				deployment's timing is set to “Line sync only”, so there are no per-word timings to follow.
				Change <em>Lyrics timing</em> under Global to get word-level lyrics back.
			</p>
		{/if}

		<label class="field" for="lyrics-lead">
			Highlight runs ahead · {(settings.room.lyricsLeadMs / 1000).toFixed(2)}s
		</label>
		<input
			id="lyrics-lead"
			type="range"
			min="0"
			max={MAX_LYRICS_LEAD_MS}
			step="50"
			value={settings.room.lyricsLeadMs}
			onchange={(e) => onroom({ lyricsLeadMs: Number(e.currentTarget.value) })}
		/>
		<p class="hint">
			{settings.room.lyricsLeadMs === 0
				? 'Lit exactly on the beat — which reads as late, because you have to see a word before singing it.'
				: 'How far ahead of the music the words light up. Nudge it up if the room is singing behind.'}
		</p>

		<label class="field" for="lyrics-scale">Text size · {settings.room.lyricsScalePct}%</label>
		<input
			id="lyrics-scale"
			type="range"
			min={MIN_LYRICS_SCALE_PCT}
			max={MAX_LYRICS_SCALE_PCT}
			step="5"
			value={settings.room.lyricsScalePct}
			onchange={(e) => onroom({ lyricsScalePct: Number(e.currentTarget.value) })}
		/>
		<!--
			Says PERCENT OF, not a size, because that is what it is: the TV already picks a size from its
			own height, and this scales that. Saying "48px" would be a number that means nothing on a
			different screen.
		-->
		<p class="hint">
			Relative to the size the TV picks for its own screen. {settings.room.lyricsScalePct === 100
				? 'Right now, exactly that.'
				: settings.room.lyricsScalePct > 100
					? 'Bigger, so fewer words fit a line.'
					: 'Smaller, so more of the verse fits.'}
		</p>

		<label class="field" for="lyrics-font">Font</label>
		<select
			id="lyrics-font"
			value={settings.room.lyricsFont}
			onchange={(e) => onroom({ lyricsFont: e.currentTarget.value as LyricsFontId })}
		>
			{#each LYRICS_FONTS as f (f.id)}
				<option value={f.id}>{f.label}</option>
			{/each}
		</select>
		{#if fontNote}<p class="hint">{fontNote}</p>{/if}

		<label class="field" for="lyrics-case">Letter case</label>
		<select
			id="lyrics-case"
			value={settings.room.lyricsCase}
			onchange={(e) => onroom({ lyricsCase: e.currentTarget.value as LyricsCaseId })}
		>
			{#each LYRICS_CASES as c (c.id)}
				<option value={c.id}>{c.label}</option>
			{/each}
		</select>
		{#if caseNote}<p class="hint">{caseNote}</p>{/if}

		<label class="field" for="lyrics-before">Lines already sung · {settings.room.lyricsLinesBefore}</label>
		<input
			id="lyrics-before"
			type="range"
			min="0"
			max={MAX_LYRICS_LINES_BEFORE}
			step="1"
			value={settings.room.lyricsLinesBefore}
			onchange={(e) => onroom({ lyricsLinesBefore: Number(e.currentTarget.value) })}
		/>

		<label class="field" for="lyrics-after">Lines coming up · {settings.room.lyricsLinesAfter}</label>
		<input
			id="lyrics-after"
			type="range"
			min="0"
			max={MAX_LYRICS_LINES_AFTER}
			step="1"
			value={settings.room.lyricsLinesAfter}
			onchange={(e) => onroom({ lyricsLinesAfter: Number(e.currentTarget.value) })}
		/>
		<!--
			One hint for the pair, because the interesting cases are combinations. Zero on both is legal
			and is the one worth naming, since it looks like a mistake and is not.
		-->
		<p class="hint">
			{settings.room.lyricsLinesBefore === 0 && settings.room.lyricsLinesAfter === 0
				? 'Just the line being sung, nothing around it.'
				: settings.room.lyricsLinesBefore === 0
					? 'The current line sits at the top, with what is coming below it.'
					: settings.room.lyricsLinesAfter === 0
						? 'The current line sits at the bottom — no preview of what is next.'
						: 'How much of the verse shows around the line being sung.'}
		</p>
		<label class="field" for="guide-default">
			Guiding track · {Math.round(settings.room.guideLevelDefault * 100)}%
		</label>
		<input
			id="guide-default"
			type="range"
			min="0"
			max="100"
			step="5"
			value={Math.round(settings.room.guideLevelDefault * 100)}
			onchange={(e) => onroom({ guideLevelDefault: Number(e.currentTarget.value) / 100 })}
		/>
		<p class="hint">
			{settings.room.guideLevelDefault === 0
				? 'Songs start with the original vocals removed. A singer can still fade them back in for one song from the now-playing sheet.'
				: 'How loud the original singer starts out under the backing track. A faint guide helps a room doing songs it half-knows; anyone can still override it per song.'}
		</p>
		{#if settings.room.guideLevelDefault > 0}
			<p class="hint">
				Only applies to songs whose vocals were separated and kept — older cooks offer no guide.
			</p>
		{/if}
	</section>

	<!--
		The only entry point to the internal dashboards, and deliberately HERE rather than on a guest
		surface. /metrics is ungated (there is no operator identity — any phone can POST /api/join), so
		linking it from the phone remote or the TV would advertise worker ids, model names, host details
		and error strings to every device in the room. Settings is already the operator's surface.
	-->
	<section>
		<h2>Diagnostics</h2>
		<p class="hint">
			<a class="diag" href="/metrics">Processing metrics</a> — how long each step takes, and how fast
			each model runs on this machine. <a class="diag" href="/stats">Party stats</a> is the guest
			page, safe to share.
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
		/* 44px, matching the rest of the app — this was a ~26px box around a bare ← glyph. */
		display: grid;
		place-items: center;
		min-width: 44px;
		min-height: 44px;
		margin-left: -10px;
		border-radius: 8px;
	}
	.back:focus-visible {
		outline: 2px solid var(--accent, currentColor);
	}
	h1 {
		margin: 0;
		font-size: 1.1rem;
		display: inline-flex;
		align-items: center;
		gap: 8px;
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
	/* Groups the two lyrics pickers under Global without implying a third scope — it is a subheading
	   inside Global, so it sits between h2 and .field in weight. */
	.sub {
		margin: 20px 0 0;
		font-size: 0.82rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.field {
		display: block;
		margin: 12px 0 4px;
		font-size: 0.82rem;
		color: var(--ink-dim);
	}
	/* The duration is inert while the intro is off; the label recedes with its control. */
	.field.dim {
		opacity: 0.5;
	}
	select,
	.text,
	input[type='range'] {
		width: 100%;
		max-width: 420px;
		box-sizing: border-box;
	}
	select,
	.text {
		padding: 9px 10px;
		border-radius: 10px;
		border: 1px solid var(--line);
		background: var(--card);
		color: var(--ink);
		font-size: 0.9rem;
	}
	/* A LAN address is read character by character to check it, so keep the digits monospaced and stop
	   iOS from title-casing what the user types. */
	.text {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.86rem;
	}
	.text[aria-invalid='true'] {
		border-color: var(--warn);
	}
	.hint {
		margin: 6px 0 0;
		font-size: 0.76rem;
		color: var(--ink-dim);
	}
	/*
	 * A live swatch beside the label, so the choice is visible without walking to the TV. It carries no
	 * text, so it needs no contrast bar of its own — the bar that matters is the lyrics ON the stage,
	 * which `stageHueToHex` already enforces.
	 */
	.swatch {
		display: inline-block;
		width: 1em;
		height: 1em;
		margin-left: 0.5em;
		border-radius: 4px;
		border: 1px solid var(--line);
		vertical-align: -0.15em;
	}
	/*
	 * The hue track shows the ACTUAL reachable stage colours (see `hueTrack`), matching the join page's
	 * colour picker rather than inventing a second slider idiom. Every stop is dark, because every
	 * reachable stage colour is dark — a generic rainbow track would promise colours that do not exist
	 * here. The thumb carries the current pick so it stays findable against a uniformly dark track.
	 */
	input[type='range'].hue {
		-webkit-appearance: none;
		appearance: none;
		height: 22px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--track);
	}
	input[type='range'].hue::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--thumb, #fff);
		border: 3px solid var(--ink);
		cursor: pointer;
	}
	input[type='range'].hue::-moz-range-thumb {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--thumb, #fff);
		border: 3px solid var(--ink);
		cursor: pointer;
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
		display: inline-flex;
		align-items: center;
		gap: 6px;
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
	/* --ink + underline, not an accent colour: both accent tokens fail AA as text on a card
	   (3.95:1 and 3.52:1), and the underline carries the link affordance without relying on hue. */
	.diag {
		color: var(--ink);
		text-decoration: underline;
		text-underline-offset: 0.2em;
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
