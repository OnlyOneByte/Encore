<!--
	Settings, as a page, in three SCOPES rather than one flat list.

	The scopes are the organising idea because they are the difference between a safe tweak and a
	surprise: You is one person, Party is this room, Server is every room on this machine and its worker
	fleet (an engine exists here only if a worker advertises it). A flat page hid that distinction, and
	put the server's stem splitter — set once, then left alone — above the rotation you change mid-song.

	`party` is the default, so the gear opens the room. `?tab=you` is what the header's name button
	links to, which is why identity lives here at all now: this page replaced the profile sheet, so
	there is exactly one place a name and colour can be edited instead of two that could disagree.

	No socket on this page, so a change from a second phone shows only after a reload. Cosmetic, not
	dangerous: every write is a per-field patch the server re-normalizes over CURRENT values, so a
	stale page can only change the field it sends, never clobber a newer choice it never touched.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import Icon from '$lib/ui/Icon.svelte';
	import ColourPicker from '$lib/components/ColourPicker.svelte';
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
		type PublicSinger,
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
			/** You, without the session token — the load strips it before the page is serialised. */
			me: PublicSinger;
			/** Which scope to open, already resolved server-side so first paint is the right tab. */
			tab: 'you' | 'party' | 'server';
			settings: EffectiveSettings;
			/** What an empty join address resolves to — env var, else the address this page was opened at. */
			joinOriginFallback: string;
			/** Whether this phone reached the server over https. Only the server can answer this. */
			requestIsHttps: boolean;
		};
	}
	let { data }: Props = $props();

	// ── scope tabs ───────────────────────────────────────────────────────────
	const TABS = [
		{ id: 'you', label: 'You' },
		{ id: 'party', label: 'Party' },
		{ id: 'server', label: 'Server' }
	] as const;
	type TabId = (typeof TABS)[number]['id'];

	let tab = $state<TabId>(untrack(() => data.tab));

	/*
	 * `replaceState`, not `goto`: switching scope is not a navigation step, so it must not stack history
	 * entries that make the browser's back button walk tabs instead of leaving the page. It still writes
	 * the URL, which is the point — the tab is shareable and survives a reload — and being shallow it
	 * does not re-run the server load just to render a panel that is already in memory.
	 */
	function showTab(id: TabId) {
		tab = id;
		replaceState(`?tab=${id}`, {});
	}

	/** Arrow keys move between tabs, which is what a tablist is expected to do from a keyboard. */
	function onTabKey(e: KeyboardEvent) {
		const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
		let next: TabId | null = null;
		if (delta !== 0) {
			const i = TABS.findIndex((t) => t.id === tab);
			next = TABS[(i + delta + TABS.length) % TABS.length]!.id;
		} else if (e.key === 'Home') next = TABS[0]!.id;
		else if (e.key === 'End') next = TABS[TABS.length - 1]!.id;
		if (!next) return;
		e.preventDefault();
		showTab(next);
		// Move focus with the selection, or the ring is left behind on the tab you just left.
		document.getElementById(`tab-${next}`)?.focus();
	}

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

	// An "upgrade" that is not actually better never runs, so say so rather than letting the toggle
	// look active while nothing happens.
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
	// The one free-text setting on the server scope, so it needs a draft rather than patching per
	// keystroke: `http` is not yet a valid origin, and a normalizer running on every character would
	// fight the typist.
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

	// ── you ──────────────────────────────────────────────────────────────────
	/*
	 * Your name and colour, moved here from the profile sheet so identity has ONE editor. An editable
	 * DRAFT seeded from `data.me`, not a view of it — `untrack` because a `singer:updated` echo of your
	 * own save must not rewrite the field under the cursor mid-typing.
	 *
	 * `savedName`/`savedColour` track what the server last confirmed, so `dirty` still means something
	 * after a save: the load does not re-run (the tab switch is shallow), so `data.me` stays at its
	 * mount-time value and comparing against it would leave Save enabled forever.
	 */
	let name = $state(untrack(() => data.me.displayName));
	let colour = $state(untrack(() => data.me.color));
	let savedName = $state(untrack(() => data.me.displayName));
	let savedColour = $state(untrack(() => data.me.color));
	let saving = $state(false);
	let profileError = $state('');
	let confirmingLeave = $state(false);
	let leaving = $state(false);
	/** What a leave would cost, fetched when the confirm opens so it can state the price in numbers. */
	let leaveCost = $state<{ queuedCount: number; hasPlaying: boolean } | null>(null);

	const profileDirty = $derived(name.trim() !== savedName || colour !== savedColour);
	const canSaveProfile = $derived(profileDirty && name.trim().length > 0 && !saving);

	async function saveProfile() {
		if (!canSaveProfile) return;
		saving = true;
		profileError = '';
		const patchBody = { displayName: name.trim(), color: colour };
		try {
			const res = await fetch('/api/me', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patchBody)
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				profileError = body.error ?? 'Could not save that';
				return;
			}
			savedName = patchBody.displayName;
			savedColour = patchBody.color;
			// Same destination the sheet's Save had: back to the remote, where the change is visible.
			await goto('/');
		} catch {
			profileError = 'Could not save that';
		} finally {
			saving = false;
		}
	}

	/*
	 * The cost is fetched when the confirm OPENS rather than on mount, so the number is current at the
	 * moment it is read out. Best-effort: the confirm still opens if this fails, falling back to the
	 * no-songs wording rather than blocking a leave on a count.
	 */
	async function askLeave() {
		confirmingLeave = true;
		try {
			const res = await fetch('/api/leave');
			leaveCost = res.ok ? await res.json() : null;
		} catch {
			leaveCost = null;
		}
	}

	async function leaveRoom() {
		leaving = true;
		await fetch('/api/leave', { method: 'POST' });
		// The cookie is gone, so /join is the only honest destination — and a reload here would 401 into
		// the same place with a flash of an empty page on the way.
		await goto('/join');
	}

	/**
	 * What the confirm says out loud. Counts, not adjectives — the remove-undo everywhere else in the
	 * app is a five-second toast, but after a leave the cookie is cleared and the singer forgotten, so
	 * there is nothing left to undo with.
	 */
	const leaveWarning = $derived.by(() => {
		const n = leaveCost?.queuedCount ?? 0;
		const songs =
			n === 0
				? 'You have no songs queued'
				: n === 1
					? 'Your 1 queued song will be removed'
					: `Your ${n} queued songs will be removed`;
		const playing = leaveCost?.hasPlaying ? ' The song on screen now will finish.' : '';
		return `${songs}, and you'll need to rejoin to sing again.${playing}`;
	});
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
		<p class="warn banner" role="alert">That change could not be saved. Reverted to the last good value.</p>
	{/if}

	<!--
		Three scopes, one at a time. A real tablist rather than three headings on one page: the whole
		complaint about the old layout was that the server's settings sat above the room's, and the only
		fix that survives adding a fourth room control is to stop rendering them together.
	-->
	<!--
		`tabindex="-1"` on the list itself for the same reason ColourPicker's radiogroup carries one: the
		arrow-key handler lives on the container, and an interactive role needs to be focusable to own it.
		The tabs themselves use a roving tabindex, so Tab enters the group once and arrows move inside it.
	-->
	<div class="seg" role="tablist" aria-label="Settings scope" tabindex="-1" onkeydown={onTabKey}>
		{#each TABS as t (t.id)}
			<button
				class="tab"
				class:on={tab === t.id}
				id="tab-{t.id}"
				role="tab"
				aria-selected={tab === t.id}
				aria-controls="panel-{t.id}"
				tabindex={tab === t.id ? 0 : -1}
				onclick={() => showTab(t.id)}
			>
				{t.label}
			</button>
		{/each}
	</div>

	{#if tab === 'you'}
		<!-- ── YOU ────────────────────────────────────────────────────────── -->
		<div class="panel" id="panel-you" role="tabpanel" aria-labelledby="tab-you" tabindex="-1">
			<div class="card">
				<h2 class="cardhead">Who you are</h2>
				<div class="cardbody">
					<label class="field" for="profile-name">Your name</label>
					<input
						id="profile-name"
						class="name-input"
						type="text"
						maxlength="32"
						autocomplete="off"
						placeholder="e.g. Dana"
						bind:value={name}
					/>

					<ColourPicker
						bind:value={colour}
						hint="How you'll spot yourself in the queue and on the TV."
					/>

					{#if profileError}<p class="warn" role="alert">{profileError}</p>{/if}

					<!--
						The one control on this page that needs an explicit commit. Every party and server
						setting writes the moment it changes; a name is typed, so it saves on purpose.
					-->
					<button class="btn-accent save" disabled={!canSaveProfile} onclick={saveProfile}>
						{#if saving}Saving…{:else}Save{/if}
					</button>
				</div>
			</div>

			<!--
				Its own card, below the reversible one: leaving cannot be undone, so the boundary is drawn
				rather than implied by being last in a list.
			-->
			<div class="card">
				<h2 class="cardhead">Leaving</h2>
				<div class="cardbody">
					{#if !confirmingLeave}
						<button class="leave" onclick={askLeave}>Leave the room</button>
						<p class="hint">Your queued songs go with you.</p>
					{:else}
						<p class="leave-warn" role="alert">{leaveWarning}</p>
						<div class="pair">
							<button class="stay" onclick={() => (confirmingLeave = false)}>Stay</button>
							<button class="leave confirm" disabled={leaving} onclick={leaveRoom}>
								{#if leaving}Leaving…{:else}Yes, leave{/if}
							</button>
						</div>
					{/if}
				</div>
			</div>

			<!--
				The same footer exit the other two tabs have. Save is disabled until something is dirty, so
				without this the You tab was a dead end for anyone who opened it and changed nothing — the
				header's back arrow was the only way out, which no other tab relies on.
			-->
			<button class="done" onclick={() => goto('/')}>Done</button>
		</div>
	{:else if tab === 'party'}
		<!-- ── PARTY ──────────────────────────────────────────────────────── -->
		<div class="panel" id="panel-party" role="tabpanel" aria-labelledby="tab-party" tabindex="-1">
			<div class="card">
				<h2 class="cardhead">Rotation</h2>
				<div class="cardbody">
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
					<p class="hint">A locked phone is not someone leaving, so they stay on the roster this long.</p>
				</div>
			</div>

			<div class="card">
				<h2 class="cardhead">The TV</h2>
				<div class="cardbody">
					<div class="pair">
						<div class="cell">
							<label class="field" for="tv-background">Background</label>
							<select
								id="tv-background"
								value={settings.room.tvBackgroundStyle}
								onchange={(e) => onroom({ tvBackgroundStyle: e.currentTarget.value as TvBackgroundStyle })}
							>
								{#each TV_BACKGROUND_STYLES as s (s.id)}
									<option value={s.id}>{s.label}</option>
								{/each}
							</select>
						</div>
						<div class="cell">
							<label class="field" for="tv-progress">Song progress</label>
							<select
								id="tv-progress"
								value={settings.room.tvProgressStyle}
								onchange={(e) => onroom({ tvProgressStyle: e.currentTarget.value as TvProgressStyle })}
							>
								{#each TV_PROGRESS_STYLES as s (s.id)}
									<option value={s.id}>{s.label}</option>
								{/each}
							</select>
						</div>
					</div>
					{#if tvBackgroundNote}<p class="hint">{tvBackgroundNote}</p>{/if}
					{#if tvProgressNote}<p class="hint">{tvProgressNote}</p>{/if}

					<!--
						Gated, not disabled: a visualizer picker means nothing for a black stage, and a control
						that does nothing for the current selection implies it does something.
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
					{/if}

					<!-- The hue colours BOTH the `solid` stage and the visualizer, so it reveals for either. -->
					{#if settings.room.tvBackgroundStyle === 'solid' || settings.room.tvBackgroundStyle === 'visualizer'}
						<label class="field field-swatch" for="tv-background-hue">
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
						Intro holds for · {(settings.room.songIntroMs / 1000).toFixed(1)}s
					</label>
					<!--
					  The range MUST match the server clamp exactly (MIN/MAX_SONG_INTRO_MS). A slider narrower
					  than the clamp has shipped here before: the UI silently refuses values the server takes.
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
				</div>
			</div>

			<div class="card">
				<h2 class="cardhead">Lyrics on the TV</h2>
				<div class="cardbody">
					<div class="pair">
						<div class="cell">
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
						</div>
						<div class="cell">
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
						</div>
					</div>
					{#if highlightNote}<p class="hint">{highlightNote}</p>{/if}
					{#if ballNote}<p class="hint">{ballNote}</p>{/if}

					<!--
						Say when a choice is not being honoured. The server's sync mode decides whether per-word
						timings exist at all, so under "Line sync only" a word-level treatment has nothing to
						light. A picker that silently does nothing is worse than one that explains itself.
					-->
					{#if lyricsClamped}
						<p class="warn">
							Showing <strong>{resolvedHighlight}</strong>{resolvedBall ? '' : ' with no marker'}: the
							server's <em>Lyrics timing</em> is set to line-only, so there are no word timings.
						</p>
					{/if}

					<div class="pair">
						<div class="cell">
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
						</div>
						<div class="cell">
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
						</div>
					</div>
					{#if fontNote}<p class="hint">{fontNote}</p>{/if}
					{#if caseNote}<p class="hint">{caseNote}</p>{/if}

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
						Says PERCENT OF, not a size, because that is what it is: the TV already picks a size from
						its own height and this scales it. "48px" would mean nothing on a different screen.
					-->
					<p class="hint">Relative to the size the TV picks for its own screen.</p>

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

					<div class="pair">
						<div class="cell">
							<label class="field" for="lyrics-before">Lines sung · {settings.room.lyricsLinesBefore}</label>
							<input
								id="lyrics-before"
								type="range"
								min="0"
								max={MAX_LYRICS_LINES_BEFORE}
								step="1"
								value={settings.room.lyricsLinesBefore}
								onchange={(e) => onroom({ lyricsLinesBefore: Number(e.currentTarget.value) })}
							/>
						</div>
						<div class="cell">
							<label class="field" for="lyrics-after">Lines ahead · {settings.room.lyricsLinesAfter}</label>
							<input
								id="lyrics-after"
								type="range"
								min="0"
								max={MAX_LYRICS_LINES_AFTER}
								step="1"
								value={settings.room.lyricsLinesAfter}
								onchange={(e) => onroom({ lyricsLinesAfter: Number(e.currentTarget.value) })}
							/>
						</div>
					</div>
				</div>
			</div>

			<div class="card">
				<h2 class="cardhead">Sound</h2>
				<div class="cardbody">
					<label class="field" for="guide-default">
						Guiding track · {Math.round(settings.room.guideLevelDefault * 100)}%
					</label>
					<input
						id="guide-default"
						type="range"
						min="0"
						max="100"
						step="1"
						value={Math.round(settings.room.guideLevelDefault * 100)}
						onchange={(e) => onroom({ guideLevelDefault: Number(e.currentTarget.value) / 100 })}
					/>
					<p class="hint">Starting vocal level. Singers can change it per song.</p>
					{#if settings.room.guideLevelDefault > 0}
						<p class="hint">Only songs cooked with their vocals kept can offer a guide.</p>
					{/if}
				</div>
			</div>

			<!--
				/stats is the GUEST page, so it is the one dashboard safe to reach from a surface any phone
				can open. Its sibling on the Server tab is not, which is why they are not side by side.
			-->
			<a class="dash" href="/stats">
				<Icon name="sparkle" />
				Party stats <span class="dash-note">safe to share</span>
			</a>

			<button class="done" onclick={() => goto('/')}>Done</button>
		</div>
	{:else}
		<!-- ── SERVER ─────────────────────────────────────────────────────── -->
		<div class="panel" id="panel-server" role="tabpanel" aria-labelledby="tab-server" tabindex="-1">
			<p class="scope-note">Affects every room on this server.</p>

			<div class="card">
				<h2 class="cardhead">Making karaoke</h2>
				<div class="cardbody">
					<!-- Stacked for the same measured reason as the lyrics engine below: "BS-RoFormer 1297". -->
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
				</div>
			</div>

			<div class="card">
				<h2 class="cardhead">Lyrics engine</h2>
				<div class="cardbody">
					<!--
						NOT paired two-up like the room controls, and measured rather than assumed: at 390px a
						half-width select leaves ~120px for its text, and these registries carry the app's
						longest option labels ("Forced alignment", "BS-RoFormer 1297"), which truncate there.
						The room's pairs were checked at the same width and fit. A truncated option is worse
						than a longer page, and this is the tab you visit once.
					-->
					<label class="field" for="asr-model">Reader</label>
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

					<label class="field" for="sync-mode">Timing</label>
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
				</div>
			</div>

			<div class="card">
				<h2 class="cardhead">Joining</h2>
				<div class="cardbody">
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
						What the TV's QR code points at. Empty means <strong>{data.joinOriginFallback}</strong>.
					</p>
					{#if joinError}<p class="warn" role="alert">{joinError}</p>{/if}
					{#if joinSchemeMismatch}
						<p class="warn">This party runs over plain http, so phones cannot open an https address.</p>
					{/if}
				</div>
			</div>

			<div class="card">
				<button
					class="disclose"
					aria-expanded={advancedOpen}
					aria-controls="advanced-body"
					onclick={() => (advancedOpen = !advancedOpen)}
				>
					<Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} />
					Advanced
					<span class="disclose-now">
						{settings.global.enqueueUpgrade ? 'Re-cook on' : 'Re-cook off'}
					</span>
				</button>

				{#if advancedOpen}
					<div class="cardbody" id="advanced-body">
						<label class="check">
							<input
								type="checkbox"
								checked={settings.global.enqueueUpgrade}
								onchange={(e) => onglobal({ enqueueUpgrade: e.currentTarget.checked })}
							/>
							Re-cook at higher quality after each song
						</label>
						<p class="hint">Runs from the audio already saved — no re-download.</p>

						<!-- Stacked: these default to the roformer names, the longest labels in any registry. -->
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

			<!--
				/metrics is ungated (there is no operator identity — any phone can POST /api/join), so it
				is reachable only from here. Linking it from the remote or the TV would advertise worker
				ids, model names, host details and error strings to every device in the room.
			-->
			<a class="dash" href="/metrics">
				<Icon name="clock" />
				Processing metrics <span class="dash-note">internal</span>
			</a>

			<button class="done" onclick={() => goto('/')}>Done</button>
		</div>
	{/if}
</main>
</div>

<style>
	/*
	 * The app shell caps every phone surface at --max-w. Settings opts out and sets its own cap: one
	 * scope at a time is a single column, so the useful width is a readable measure, not the whole
	 * monitor. The old two-column grid put Global beside This room, which stops making sense once the
	 * scopes are tabs.
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
		/* 44px, matching the rest of the app — this was a ~26px box around a bare back glyph. Kept as a
		   44px literal, not var(--tap): touch-targets.test.ts pins this control by the literal string. */
		display: grid;
		place-items: center;
		min-width: 44px;
		min-height: 44px;
		margin-left: -10px;
		border-radius: 8px;
	}
	.back:focus-visible {
		/* --focus, not --accent: app.css defines a global :focus-visible ring in --focus and this control
		   is inside its selector list, so ringing in --accent here would contradict every other control. */
		outline: 2px solid var(--focus);
	}
	h1 {
		margin: 0;
		font-size: 1.1rem;
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	main {
		/* A single readable column. Wider than the 480px phone cap so a desktop operator gets room for
		   the paired controls, narrower than the shell's 1080px so a select never spans a monitor. */
		max-width: 560px;
		margin: 0 auto;
		padding: 10px 18px calc(28px + env(safe-area-inset-bottom, 0px));
	}

	/* ── the scope tabs ─────────────────────────────────────────────────── */
	.seg {
		display: flex;
		gap: 4px;
		margin: 4px 0 12px;
		padding: 4px;
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
	}
	.tab {
		flex: 1;
		/* var(--tap), not a smaller literal: touch-targets.test.ts checks every `button` rule that
		   declares a box, and a 38px pill would be the one control on the page under the 44px floor. */
		min-height: var(--tap);
		border: 0;
		border-radius: var(--radius-pill);
		background: none;
		color: var(--ink-dim);
		/* 16px so iOS does not auto-zoom when the tab takes focus, same as every control below. */
		font-size: 1rem;
		font-weight: 700;
		cursor: pointer;
	}
	.tab.on {
		/* --accent-strong + --on-accent is the one accent pair that carries a label at AA (4.88:1). */
		background: var(--accent-strong);
		color: var(--on-accent);
	}

	/* ── cards ──────────────────────────────────────────────────────────── */
	/*
	 * The same `.card` shape the remote uses for every row, so this page stops reading as a different
	 * application. The uppercase head matches the remote's `.grouphead` treatment.
	 */
	.card {
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		margin-bottom: 10px;
	}
	.cardhead {
		margin: 0;
		padding: 12px 12px 0;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.cardbody {
		padding: 2px 12px 12px;
	}
	/* Only the server scope needs saying out loud; "You" and "Party" say it in the tab. */
	.scope-note {
		margin: 0 0 10px 2px;
		font-size: 0.78rem;
		color: var(--ink-dim);
	}
	/* A failed write is about the page, not one card, so it sits above them all. */
	.banner {
		margin: 0 0 10px;
	}

	/*
	 * Two controls per row where they are genuinely a pair (highlight + marker, font + case, splitter +
	 * model). This is most of what shortened the page. It collapses at 380px, because two selects in
	 * ~150px each is where the option text starts truncating.
	 */
	.pair {
		display: flex;
		gap: 10px;
	}
	.cell {
		flex: 1;
		min-width: 0;
	}
	@media (max-width: 380px) {
		.pair {
			display: block;
		}
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
	/* A trailing 1em swatch after flowing text can wrap onto its own line at 320px, reading as an orphan
	   dot. A flex row keeps text and swatch together and lets them wrap as a unit if ever needed. */
	.field-swatch {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
	}
	select,
	.text,
	.name-input,
	input[type='range'] {
		width: 100%;
		box-sizing: border-box;
	}
	select,
	.text,
	.name-input {
		padding: 9px 10px;
		border-radius: var(--radius-btn);
		border: 1px solid var(--line);
		background: var(--card2);
		color: var(--ink);
		/* 16px, not 0.9rem (14.4px): iOS Safari auto-zooms on focusing any control under 16px and never
		   zooms back out, leaving the operator stuck at 1.3x for the rest of the session. */
		font-size: 1rem;
	}
	/* A LAN address is read character by character to check it, so keep the digits monospaced and stop
	   iOS from title-casing what the user types. The name field deliberately does NOT inherit this. */
	.text {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		padding: 7px 10px;
	}
	.text[aria-invalid='true'] {
		border-color: var(--warn);
	}
	/* Your own name is the one field worth typing comfortably, so it keeps the sheet's larger box. */
	.name-input {
		padding: 12px 14px;
		font-size: 1.05rem;
		border-radius: 14px;
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
		border-radius: var(--radius-xs);
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
		border-radius: var(--radius-pill);
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
	/*
	 * Every OTHER range had no thumb sizing, so the browser drew its native ~12px thumb — ungrabbable
	 * with a thumb on a phone. A 28px visible thumb, and a --tap (44px) tall control so the whole hit
	 * area clears the touch-target minimum. Both vendor pseudo-elements, because a rule that fails to
	 * parse in one engine drops the whole selector in that engine. Scoped :not(.hue) so the hue slider
	 * keeps its own full-height gradient track. A painted track is required once appearance is none, or
	 * WebKit would leave the track invisible.
	 */
	input[type='range']:not(.hue) {
		-webkit-appearance: none;
		appearance: none;
		height: var(--tap);
		background: transparent;
		cursor: pointer;
	}
	input[type='range']:not(.hue)::-webkit-slider-runnable-track {
		height: 6px;
		border-radius: var(--radius-pill);
		background: var(--track-bg);
	}
	input[type='range']:not(.hue)::-moz-range-track {
		height: 6px;
		border-radius: var(--radius-pill);
		background: var(--track-bg);
	}
	input[type='range']:not(.hue)::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 28px;
		height: 28px;
		/* Centre the 28px thumb on the 6px track — WebKit anchors the thumb to the track top otherwise. */
		margin-top: -11px;
		border-radius: 50%;
		background: var(--accent-strong);
		border: 3px solid var(--ink);
		cursor: pointer;
	}
	input[type='range']:not(.hue)::-moz-range-thumb {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--accent-strong);
		border: 3px solid var(--ink);
		cursor: pointer;
	}
	.warn {
		margin: 6px 0 0;
		font-size: 0.76rem;
		color: var(--warn);
	}

	/* ── the one disclosure left ────────────────────────────────────────── */
	.disclose {
		width: 100%;
		min-height: var(--tap);
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 12px;
		background: none;
		border: 0;
		color: var(--ink);
		font-size: 0.9rem;
		font-weight: 700;
		text-align: left;
		cursor: pointer;
	}
	.disclose:focus-visible {
		outline: 2px solid var(--focus);
	}
	/* States what is behind the door, so it does not have to be opened to be read. */
	.disclose-now {
		margin-left: auto;
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--ink-dim);
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: var(--tap);
		font-size: 0.86rem;
	}
	.check input {
		width: 18px;
		height: 18px;
	}

	/* ── the dashboard links ────────────────────────────────────────────── */
	/*
	 * A button rather than a sentence with a link in it: these are destinations, and the old prose
	 * paragraph buried two of them in twenty words. --ink on --card2, not an accent colour: both accent
	 * tokens fail AA as text (3.95:1 and 3.52:1), which contrast.test.ts scans for.
	 */
	.dash {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: var(--tap);
		margin-bottom: 10px;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-btn);
		background: var(--card2);
		color: var(--ink);
		font-size: 0.88rem;
		font-weight: 600;
		text-decoration: none;
	}
	.dash-note {
		color: var(--ink-dim);
		font-weight: 400;
		font-size: 0.76rem;
	}

	/* ── the two footer buttons ─────────────────────────────────────────── */
	/*
	 * Done is NOT accent: every control on the Party and Server tabs has already saved by the time it is
	 * reached, so making it the loudest thing on screen would imply it commits something.
	 */
	.done {
		display: block;
		width: 100%;
		min-height: var(--tap);
		margin-top: 18px;
		padding: 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--card);
		color: var(--ink);
		font-size: 0.95rem;
		cursor: pointer;
	}
	/* Save IS accent, because it is the one thing on this page that does not happen without a tap. */
	.save {
		width: 100%;
		min-height: var(--tap);
		margin-top: 14px;
		padding: 13px;
		font-size: 1rem;
	}
	.save:disabled {
		opacity: 0.45;
	}

	/* ── leaving ────────────────────────────────────────────────────────── */
	.leave {
		width: 100%;
		min-height: var(--tap);
		padding: 13px;
		border-radius: 14px;
		cursor: pointer;
		background: transparent;
		color: var(--danger-ink);
		border: 1px solid var(--danger-line);
		font-size: 0.95rem;
	}
	.leave.confirm {
		background: var(--danger-bg);
	}
	.leave:disabled {
		opacity: 0.5;
	}
	.leave-warn {
		margin: 4px 0 10px;
		font-size: 0.88rem;
		color: var(--danger-ink);
	}
	.stay {
		flex: 1;
		min-height: var(--tap);
		padding: 13px;
		border-radius: 14px;
		cursor: pointer;
		background: var(--card2);
		color: var(--ink);
		border: 1px solid var(--line);
		font-size: 0.95rem;
	}
	.pair .leave {
		flex: 1;
	}
</style>
