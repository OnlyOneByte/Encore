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
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import ColourPicker from '$lib/components/ColourPicker.svelte';
	import {
		SEPARATOR_ENGINES,
		TV_PROGRESS_STYLES,
		TV_BACKGROUND_STYLES,
		TV_VISUALIZERS,
		ASR_MODELS,
		// The registry's own by-id lookups. This page is their sole caller: every id->record lookup
		// here goes through the accessor rather than hand-rolling `X.find((s) => s.id === …)`, so the
		// registry owns the shape and there is no parallel find to drift. (liveModels stays a plain
		// .find — it is a runtime worker list, not a registry.)
		getAsrModel,
		getTvProgressStyle,
		getTvBackgroundStyle,
		getTvVisualizer,
		getEngine,
		getFetcher,
		getSyncMode,
		getLyricsBallStyle,
		getLyricsHighlight,
		getLyricsFont,
		getLyricsCase,
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
		MIN_SONG_INTRO_MS,
		MAX_SONG_INTRO_MS,
		SONG_INTRO_STEP_MS,
		MIN_PRESENCE_GRACE_MINUTES,
		MAX_PRESENCE_GRACE_MINUTES,
		QUEUE_ORDERS,
		getQueueOrder,
		FETCHERS,
		type PublicSinger,
		type QueueOrderId,
		type EffectiveSettings,
		type FetcherId,
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

	// The last value the SERVER confirmed. `settings` moves optimistically on a drag frame
	// (`liveRoom`) so the readout tracks the thumb; this snapshot does not, so a rejected commit
	// rolls back to what the server actually holds rather than to the dragged value it refused.
	let committed = untrack(() => data.settings);

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
		committed = data.settings;
	});

	// The chosen algorithm's own note, so the consequence is stated by the registry rather than
	// duplicated here — the same reason the TV-progress and lyrics pickers read theirs.
	const queueOrderNote = $derived(getQueueOrder(settings.room.queueOrder)?.note ?? '');

	let advancedOpen = $state(false);
	let failed = $state(false);

	// Only engines a live cook may use appear in the primary picker; `ensemble` runs several models and
	// is upgrade-only, so offering it here would let a singer pick something the server rejects.
	const liveEngines = SEPARATOR_ENGINES.filter((e) => e.liveSelectable);

	const engineOf = (id: string) => getEngine(id);

	// Models are scoped to the chosen engine — the whole reason engine and model are separate axes.
	let liveModels = $derived(engineOf(settings.global.defaultEngine)?.models ?? []);
	let upgradeModels = $derived(engineOf(settings.global.upgradeEngine)?.models ?? []);

	let liveNote = $derived(liveModels.find((m) => m.id === settings.global.defaultModel)?.note ?? '');

	// A slow engine on the LIVE path is the footgun worth naming in the UI: RoFormer measured ~44min
	// per song on CPU versus ~50s for htdemucs. Someone should learn that here, not at a party.
	let liveSlow = $derived(engineOf(settings.global.defaultEngine)?.speed === 'slow');

	// ── room quality ceiling ───────────────────────────────────────────────────
	/*
	 * The room-scoped cook-quality cap, offered as REAL pairings rather than a raw `qualityRank`
	 * integer. Each option is one live-selectable engine+model, valued by its rank, and the empty
	 * option means "no cap" (`null`). Built from the same registry + `qualityRank` that
	 * `resolveCookSeparator` reads, so the choices the operator sees are exactly the ceilings the
	 * resolver can honour — never an invented number. Sorted low→high because the control caps quality
	 * DOWNWARD, so the cheaper/faster ceilings read first.
	 *
	 * `rank === 0` pairings are excluded: an unranked model can never win `resolveCookSeparator`, so
	 * offering it as a ceiling would name a floor nothing sits at.
	 */
	const qualityCeilings = liveEngines
		.flatMap((engine) =>
			engine.models.map((model) => ({
				rank: qualityRank(engine.id, model.id),
				label: `${engine.label} · ${model.label}`
			}))
		)
		.filter((c) => c.rank > 0)
		.sort((a, b) => a.rank - b.rank);

	// The global default's own rank, so the ceiling control can say when a chosen cap sits AT OR ABOVE
	// it — the cap is downward-only, so such a cap changes nothing and the copy must say so rather than
	// implying it raised quality.
	let defaultRank = $derived(qualityRank(settings.global.defaultEngine, settings.global.defaultModel));
	let capAboveDefault = $derived(settings.room.maxQualityRank !== null && settings.room.maxQualityRank >= defaultRank);

	// ── audio acquisition ───────────────────────────────────────────────────────
	// The downloader every new cook's source audio comes through. `local` is excluded: it names one
	// media's already-present bytes, not a default a room could pick (see fetchers.ts / the schema
	// comment). Sourced note, same as the splitter and reader pickers.
	const defaultFetchers = FETCHERS.filter((f) => f.id !== 'local');
	let fetcherNote = $derived(getFetcher(settings.global.defaultFetcher)?.note ?? '');

	// ── lyrics ───────────────────────────────────────────────────────────────
	// The two knobs on the words rather than the audio. Same shape as the splitter pair above: the
	// note comes from the registry so a model cannot appear here without its tradeoff stated.
	let asrNote = $derived(getAsrModel(settings.global.asrModel)?.note ?? '');
	let syncNote = $derived(getSyncMode(settings.global.syncMode)?.note ?? '');

	// The same footgun as a slow splitter, and worth naming in the same place: a bigger reader is the
	// one lever on wrong words, and it is also the one that turns a two-minute cook into a long wait on
	// a CPU box. Nobody should discover that at a party.
	let asrSlow = $derived(['slow', 'slowest'].includes(getAsrModel(settings.global.asrModel)?.speed ?? ''));

	let tvProgressNote = $derived(getTvProgressStyle(settings.room.tvProgressStyle)?.note ?? '');

	let tvBackgroundNote = $derived(getTvBackgroundStyle(settings.room.tvBackgroundStyle)?.note ?? '');
	// The swatch and the input both show the room's stored colour directly. Since #425 there is no
	// generator between the choice and the render — the phone cannot promise a colour the TV then
	// renders differently, because they are the same string.
	let tvBackgroundPreview = $derived(settings.room.tvBackgroundColor);
	let tvVisualizerNote = $derived(getTvVisualizer(settings.room.tvVisualizer)?.note ?? '');
	/*
	 * The stage picker no longer needs a painted track. It was a hue slider whose gradient had to be
	 * generated from stageHueToHex — "what you drag through is what you can get" — precisely because a
	 * hue angle was not the colour you got: the stage tier darkened hues near the active-word pink, so
	 * hardcoded stops would have lied where the guard bit. #425 removed the generator, so the control is
	 * a plain colour input whose own swatch IS the stored value and cannot disagree with the TV.
	 */

	// An "upgrade" that is not actually better never runs, so say so rather than letting the toggle
	// look active while nothing happens.
	let upgradeIsBetter = $derived(
		qualityRank(settings.global.upgradeEngine, settings.global.upgradeModel) >
			qualityRank(settings.global.defaultEngine, settings.global.defaultModel)
	);

	let ballNote = $derived(getLyricsBallStyle(settings.room.lyricsBall)?.note ?? '');
	let highlightNote = $derived(getLyricsHighlight(settings.room.lyricsHighlight)?.note ?? '');
	// Ask the SAME resolver the TV uses, rather than re-testing syncMode here. If the two ever
	// disagreed, this page would be confidently wrong about what is on screen.
	let resolved = $derived(resolveLyricsPresentation(settings));
	let lyricsClamped = $derived(resolved.clamped);
	let resolvedHighlight = $derived(getLyricsHighlight(resolved.highlight)?.label.toLowerCase() ?? resolved.highlight);
	let resolvedBall = $derived(resolved.ball !== 'off');

	let fontNote = $derived(getLyricsFont(settings.room.lyricsFont)?.note ?? '');
	let caseNote = $derived(getLyricsCase(settings.room.lyricsCase)?.note ?? '');

	/**
	 * Apply a patch optimistically, then reconcile on the authoritative response — the same shape the
	 * queue uses, so a tap renders instantly and a rejected write rolls back rather than leaving a
	 * value on screen that the server refused.
	 */
	async function patch(scope: 'global' | 'room', body: Record<string, unknown>) {
		const before = committed;
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
			committed = settings;
		} catch {
			settings = before;
			failed = true;
		}
	}

	const onglobal = (body: Partial<GlobalSettings>) => patch('global', body);
	const onroom = (body: Partial<RoomSettings>) => patch('room', body);

	// Move ONE room field on screen without a write, so the readout label (the only display of the
	// value) tracks the thumb during a drag. `onchange` still commits via `onroom`; the rollback
	// baseline is `committed`, so an intermediate drag value never becomes the value we revert to.
	function liveRoom<K extends keyof RoomSettings>(field: K, value: RoomSettings[K]) {
		settings = { ...settings, room: { ...settings.room, [field]: value } };
	}

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
	<PageHeader title="Settings" icon="gear" back={{ href: '/', label: 'Back to the remote' }} />

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

						<ColourPicker bind:value={colour} hint="How you'll spot yourself in the queue and on the TV." />

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
							oninput={(e) => liveRoom('presenceGraceMinutes', Number(e.currentTarget.value))}
							onchange={(e) => onroom({ presenceGraceMinutes: Number(e.currentTarget.value) })}
						/>
						<p class="hint">A locked phone is not someone leaving, so they stay on the roster this long.</p>
					</div>
				</div>

				<div class="card">
					<h2 class="cardhead">Cook quality</h2>
					<div class="cardbody">
						<label class="field" for="quality-ceiling">Cap this room at</label>
						<!--
						A ceiling, offered as real engine+model pairings valued by their rank, not a raw
						integer. The value is the `qualityRank`; the empty option is `null` = no cap. The
						resolver picks the best live pairing AT OR UNDER this, so these are exactly the
						ceilings it can honour.
					-->
						<select
							id="quality-ceiling"
							value={settings.room.maxQualityRank ?? ''}
							onchange={(e) =>
								onroom({
									maxQualityRank: e.currentTarget.value === '' ? null : Number(e.currentTarget.value)
								})}
						>
							<option value="">No cap — use the server default</option>
							{#each qualityCeilings as c (c.rank)}
								<option value={c.rank}>Up to {c.label}</option>
							{/each}
						</select>
						<!--
						Downward-only, and this is where a party learns it: the server's default is already
						bounded by what the worker fleet can run, so a room can only ask for the same or less.
					-->
						<p class="hint">
							Only ever lowers cook quality below the server's default, to keep a busy queue moving. It cannot raise it.
						</p>
						{#if capAboveDefault}
							<p class="warn">
								This cap is at or above the server's current default, so it changes nothing. Pick a lower one to
								actually cap this room.
							</p>
						{/if}
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

						<!-- The colour is BOTH the `solid` stage and the visualizer's palette, so it reveals for either. -->
						{#if settings.room.tvBackgroundStyle === 'solid' || settings.room.tvBackgroundStyle === 'visualizer'}
							<label class="field field-swatch" for="tv-background-color">
								Background colour
								<span class="swatch" style="background: {tvBackgroundPreview}" aria-hidden="true"></span>
							</label>
							<!--
							A real colour input, not the hue slider this was until #425: the room names a colour
							outright now rather than an angle rendered at a pinned lightness. oninput/onchange are
							split for the same reason every slider here splits them (#134) — the native picker fires
							`input` continuously while you drag inside it, so the swatch has to track live, while only
							the committed `change` writes and broadcasts room-wide.
						-->
							<input
								id="tv-background-color"
								class="colour"
								type="color"
								value={settings.room.tvBackgroundColor}
								oninput={(e) => liveRoom('tvBackgroundColor', e.currentTarget.value)}
								onchange={(e) => onroom({ tvBackgroundColor: e.currentTarget.value })}
							/>

							<label class="field" for="tv-background-dim">
								Dim · {Math.round(settings.room.tvBackgroundDim * 100)}%
							</label>
							<!--
							Dims the stage colour toward black (#782, owner ruling Q2 = A) — a lightness control, not
							a layer over the video. Split oninput/onchange like every other slider here (#134): the
							readout above is the only display of the value, so it must track the thumb live, while
							only the committed `change` writes and broadcasts. Stored 0..1, shown as a percent; the
							range spans the full 0..100 the server clamp accepts.
						-->
							<input
								id="tv-background-dim"
								type="range"
								min="0"
								max="100"
								step="1"
								value={Math.round(settings.room.tvBackgroundDim * 100)}
								oninput={(e) => liveRoom('tvBackgroundDim', Number(e.currentTarget.value) / 100)}
								onchange={(e) => onroom({ tvBackgroundDim: Number(e.currentTarget.value) / 100 })}
							/>
							<p class="hint">How far the stage colour is darkened toward black. 0% is the colour itself.</p>
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
							oninput={(e) => liveRoom('songIntroMs', Number(e.currentTarget.value))}
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
								Showing <strong>{resolvedHighlight}</strong>{resolvedBall ? '' : ' with no marker'}: the server's
								<em>Lyrics timing</em> is set to line-only, so there are no word timings.
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
							oninput={(e) => liveRoom('lyricsScalePct', Number(e.currentTarget.value))}
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
							oninput={(e) => liveRoom('lyricsLeadMs', Number(e.currentTarget.value))}
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
									oninput={(e) => liveRoom('lyricsLinesBefore', Number(e.currentTarget.value))}
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
									oninput={(e) => liveRoom('lyricsLinesAfter', Number(e.currentTarget.value))}
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
							oninput={(e) => liveRoom('guideLevelDefault', Number(e.currentTarget.value) / 100)}
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

						<label class="field" for="fetcher">Where audio comes from</label>
						<select
							id="fetcher"
							value={settings.global.defaultFetcher}
							onchange={(e) => onglobal({ defaultFetcher: e.currentTarget.value as FetcherId })}
						>
							{#each defaultFetchers as f (f.id)}
								<option value={f.id}>{f.label}</option>
							{/each}
						</select>
						{#if fetcherNote}<p class="hint">{fetcherNote}</p>{/if}
						<!--
						Explicit blast radius, matched to the splitter warning above it: this is the acquirer
						EVERY new cook downloads its source through, and a worker that cannot run it fails the
						fetch before any separation starts.
					-->
						<p class="warn">
							Changes where every new cook gets its audio. A worker that cannot run it will fail the download.
						</p>
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

	main {
		/* A single readable column. Wider than the 480px phone cap so a desktop operator gets room for
		   the paired controls, narrower than the shell's 1080px so a select never spans a monitor. */
		max-width: 560px;
		margin: 0 auto;
		padding: var(--space-md) var(--space-3xl) calc(28px + env(safe-area-inset-bottom, 0px));
	}

	/* ── the scope tabs ─────────────────────────────────────────────────── */
	.seg {
		display: flex;
		gap: var(--space-2xs);
		margin: var(--space-2xs) 0 var(--space-lg);
		padding: var(--space-2xs);
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
		font-size: var(--ph-text-base);
		font-weight: 700;
		cursor: pointer;
	}
	.tab.on {
		/* --accent + --on-accent is the certified pair that carries a label: 5.09:1 (#840, XR-COL-12 —
		   the fill and its ink are set together, never separately). */
		background: var(--accent);
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
		margin-bottom: var(--space-md);
	}
	.cardhead {
		margin: 0;
		padding: var(--space-lg) var(--space-lg) 0;
		font-size: var(--ph-text-2xs);
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.cardbody {
		padding: var(--space-3xs) var(--space-lg) var(--space-lg);
	}
	/* Only the server scope needs saying out loud; "You" and "Party" say it in the tab. */
	.scope-note {
		margin: 0 0 var(--space-md) var(--space-3xs);
		font-size: 0.78rem;
		color: var(--ink-dim);
	}
	/* A failed write is about the page, not one card, so it sits above them all. */
	.banner {
		margin: 0 0 var(--space-md);
	}

	/*
	 * Two controls per row where they are genuinely a pair (highlight + marker, font + case, splitter +
	 * model). This is most of what shortened the page. It collapses at 380px, because two selects in
	 * ~150px each is where the option text starts truncating.
	 */
	.pair {
		display: flex;
		gap: var(--space-md);
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
		margin: var(--space-lg) 0 var(--space-2xs);
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
		padding: 9px var(--space-md);
		border-radius: var(--radius-btn);
		border: 1px solid var(--line);
		background: var(--card2);
		color: var(--ink);
		/* The tap floor for every settings field (#863): the padding here sized the box to 41px (select,
		   UA default) and 35px (.text), both short of var(--tap). A native select's box is browser-owned,
		   so this is verified on a real render by gate:measured rather than trusted. box-sizing:border-box
		   above keeps the padding inside the floor. .name-input's own larger padding stays above it. */
		min-height: var(--tap);
		/* 16px, not 0.9rem (14.4px): iOS Safari auto-zooms on focusing any control under 16px and never
		   zooms back out, leaving the operator stuck at 1.3x for the rest of the session. */
		font-size: var(--ph-text-base);
	}
	/* A LAN address is read character by character to check it, so keep the digits monospaced and stop
	   iOS from title-casing what the user types. The name field deliberately does NOT inherit this. */
	.text {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		padding: 7px var(--space-md);
	}
	.text[aria-invalid='true'] {
		border-color: var(--warn);
	}
	/* Your own name is the one field worth typing comfortably, so it keeps the sheet's larger box. */
	.name-input {
		padding: var(--space-lg) var(--space-xl);
		font-size: 1.05rem;
		border-radius: 14px;
	}
	.hint {
		margin: var(--space-xs) 0 0;
		font-size: 0.76rem;
		color: var(--ink-dim);
	}
	/*
	 * A live swatch beside the label, so the choice is visible without walking to the TV. It carries no
	 * text, so it needs no contrast bar of its own — and since #425 there is no bar on the stage colour
	 * either: the bar that matters is the lyrics ON the stage, and the reel enforces it itself with a
	 * stroked outline rather than the stage being restricted to spare it.
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
	 * The stage colour input. A native `type="color"` — the whole point of #425 is that any colour is
	 * now reachable, so a bespoke control would only narrow what the platform already offers (including
	 * eyedroppers and OS palettes). Sized to the project's --tap (44px) minimum for the same reason the
	 * ranges are (#133): the browser's default colour swatch is well under a thumb's worth of target.
	 */
	input[type='color'].colour {
		width: 100%;
		height: var(--tap);
		padding: var(--space-2xs);
		background: var(--field-bg, transparent);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
	/*
	 * Every range had no thumb sizing, so the browser drew its native ~12px thumb — ungrabbable with a
	 * thumb on a phone. A 28px visible thumb, and a --tap (44px) tall control so the whole hit area
	 * clears the touch-target minimum. Both vendor pseudo-elements, because a rule that fails to parse
	 * in one engine drops the whole selector in that engine. A painted track is required once appearance
	 * is none, or WebKit would leave the track invisible.
	 *
	 * These were scoped `:not(.hue)` until #425, to spare the stage's hue slider its own full-height
	 * gradient track. That slider is gone — the stage is a colour input now — so the exclusion went with
	 * it rather than being left behind as a selector matching nothing.
	 */
	input[type='range'] {
		-webkit-appearance: none;
		appearance: none;
		height: var(--tap);
		background: transparent;
		cursor: pointer;
	}
	input[type='range']::-webkit-slider-runnable-track {
		height: 6px;
		border-radius: var(--radius-pill);
		background: var(--track-bg);
	}
	input[type='range']::-moz-range-track {
		height: 6px;
		border-radius: var(--radius-pill);
		background: var(--track-bg);
	}
	input[type='range']::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 28px;
		height: 28px;
		/* Centre the 28px thumb on the 6px track — WebKit anchors the thumb to the track top otherwise. */
		margin-top: -11px;
		border-radius: 50%;
		background: var(--accent);
		border: 3px solid var(--ink);
		cursor: pointer;
	}
	input[type='range']::-moz-range-thumb {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--accent);
		border: 3px solid var(--ink);
		cursor: pointer;
	}
	.warn {
		margin: var(--space-xs) 0 0;
		font-size: 0.76rem;
		color: var(--warn);
	}

	/* ── the one disclosure left ────────────────────────────────────────── */
	.disclose {
		width: 100%;
		min-height: var(--tap);
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: 0 var(--space-lg);
		background: none;
		border: 0;
		color: var(--ink);
		font-size: var(--ph-text-md);
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
		gap: var(--space-sm);
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
		gap: var(--space-sm);
		min-height: var(--tap);
		margin-bottom: var(--space-md);
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
		margin-top: var(--space-3xl);
		padding: var(--space-lg);
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
		margin-top: var(--space-xl);
		padding: 13px;
		font-size: var(--ph-text-base);
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
		margin: var(--space-2xs) 0 var(--space-md);
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
