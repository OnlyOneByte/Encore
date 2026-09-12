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
	import { Button } from '$lib/components/ui/button';
	import { untrack } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import Icon from '$lib/ui/Icon.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import ColourPicker from '$lib/components/ColourPicker.svelte';
	import { Input } from '$lib/components/ui/input';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Slider } from '$lib/components/ui/slider';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import * as Collapsible from '$lib/components/ui/collapsible';
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

	/*
	 * S4: `onTabKey` was deleted here. It implemented ArrowLeft/Right with wraparound, Home, End,
	 * and moved focus to follow the selection — all of which Bits UI's tablist does, verified by a real
	 * mount rather than assumed. `showTab` below is what remains Encore's: the URL sync.
	 */

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
	// The swatch and the input both show the room's stored colour directly. there is no
	// generator between the choice and the render — the phone cannot promise a colour the TV then
	// renders differently, because they are the same string.
	let tvBackgroundPreview = $derived(settings.room.tvBackgroundColor);
	let tvVisualizerNote = $derived(getTvVisualizer(settings.room.tvVisualizer)?.note ?? '');
	/*
	 * The stage picker no longer needs a painted track. It was a hue slider whose gradient had to be
	 * generated from stageHueToHex — "what you drag through is what you can get" — precisely because a
	 * hue angle was not the colour you got: the stage tier darkened hues near the active-word pink, so
	 * hardcoded stops would have lied where the guard bit. An earlier change removed the generator, so the control is
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
		// The cookie is gone, so `/` — the landing/join page (Q2-A) — is the only honest destination,
		// and a reload here would 401 into the same place with a flash of an empty page on the way.
		await goto('/');
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
		S4: a Bits UI tablist. The roving tabindex, ArrowLeft/Right, Home and End that used to live
		in `onTabKey` are the primitive's now — verified by mounting it rather than trusted: ArrowRight,
		End and Home each move BOTH `aria-selected` and the tabindex, which is the pairing the old
		handler had to remember to do by hand ("move focus with the selection, or the ring is left behind
		on the tab you just left").

		`showTab` stays, because the URL sync is Encore's and no primitive can know about it: it is what
		makes a scope survive a reload and a shared link.
	-->
		<Tabs.Root value={tab} onValueChange={(v) => showTab(v as TabId)}>
			<Tabs.List aria-label="Settings scope">
				{#each TABS as t (t.id)}
					<!--
						The explicit id is load-bearing: Bits UI would generate its own, and both
						`SEL.settingsTab(id)` (`#tab-<id>`) and capture.mjs, which clicks it and then reads
						`aria-selected`, resolve THIS spelling.
					-->
					<Tabs.Trigger id="tab-{t.id}" value={t.id}>{t.label}</Tabs.Trigger>
				{/each}
			</Tabs.List>

			<Tabs.Content value="you">
			<!-- ── YOU ────────────────────────────────────────────────────────── -->
			<div class="panel" id="panel-you" role="tabpanel" aria-labelledby="tab-you" tabindex="-1">
				<Card.Root>
	<Card.Header>
		<Card.Title>Who you are</Card.Title>
	</Card.Header>
	<Card.Content>
						<Field.Label for="profile-name">Your name</Field.Label>
						<Input
							id="profile-name"
							variant="comfortable"
							type="text"
							maxlength={32}
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
						<div class="save-slot">
							<Button size="block" disabled={!canSaveProfile} onclick={saveProfile}>
								{#if saving}Saving…{:else}Save{/if}
							</Button>
						</div>
					</Card.Content>
</Card.Root>

				<!--
				Its own card, below the reversible one: leaving cannot be undone, so the boundary is drawn
				rather than implied by being last in a list.
			-->
				<Card.Root>
	<Card.Header>
		<Card.Title>Leaving</Card.Title>
	</Card.Header>
	<Card.Content>
						{#if !confirmingLeave}
							<button class="leave" onclick={askLeave}>Leave the room</button>
							<Field.Description>Your queued songs go with you.</Field.Description>
						{:else}
							<p class="leave-warn" role="alert">{leaveWarning}</p>
							<div class="pair">
								<button class="stay" onclick={() => (confirmingLeave = false)}>Stay</button>
								<button class="leave confirm" disabled={leaving} onclick={leaveRoom}>
									{#if leaving}Leaving…{:else}Yes, leave{/if}
								</button>
							</div>
						{/if}
					</Card.Content>
</Card.Root>

				<!--
				The same footer exit the other two tabs have. Save is disabled until something is dirty, so
				without this the You tab was a dead end for anyone who opened it and changed nothing — the
				header's back arrow was the only way out, which no other tab relies on.
			-->
				<button class="done" onclick={() => goto('/')}>Done</button>
			</div>
			</Tabs.Content>
			<Tabs.Content value="party">
			<!-- ── PARTY ──────────────────────────────────────────────────────── -->
			<div class="panel" id="panel-party" role="tabpanel" aria-labelledby="tab-party" tabindex="-1">
				<Card.Root>
	<Card.Header>
		<Card.Title>Rotation</Card.Title>
	</Card.Header>
	<Card.Content>
						<Field.Label for="queue-order">Who sings next</Field.Label>
						<NativeSelect
							id="queue-order"
							value={settings.room.queueOrder}
							onchange={(e) => onroom({ queueOrder: e.currentTarget.value as QueueOrderId })}
						>
							{#each QUEUE_ORDERS as o (o.id)}
								<option value={o.id}>{o.label}</option>
							{/each}
						</NativeSelect>
						{#if queueOrderNote}<Field.Description>{queueOrderNote}</Field.Description>{/if}

						<Field.Label for="presence-grace">
							Keep people in the room for · {graceLabel}
						</Field.Label>
						<Slider
							id="presence-grace"
							type="single"
							min={MIN_PRESENCE_GRACE_MINUTES}
							max={MAX_PRESENCE_GRACE_MINUTES}
							step={15}
							value={settings.room.presenceGraceMinutes}
							onValueChange={(v) => liveRoom('presenceGraceMinutes', v)}
							onValueCommit={(v) => onroom({ presenceGraceMinutes: v })}
						/>
						<Field.Description>A locked phone is not someone leaving, so they stay on the roster this long.</Field.Description>
					</Card.Content>
</Card.Root>

				<Card.Root>
	<Card.Header>
		<Card.Title>Cook quality</Card.Title>
	</Card.Header>
	<Card.Content>
						<Field.Label for="quality-ceiling">Cap this room at</Field.Label>
						<!--
						A ceiling, offered as real engine+model pairings valued by their rank, not a raw
						integer. The value is the `qualityRank`; the empty option is `null` = no cap. The
						resolver picks the best live pairing AT OR UNDER this, so these are exactly the
						ceilings it can honour.
					-->
						<NativeSelect
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
						</NativeSelect>
						<!--
						Downward-only, and this is where a party learns it: the server's default is already
						bounded by what the worker fleet can run, so a room can only ask for the same or less.
					-->
						<Field.Description>
							Only ever lowers cook quality below the server's default, to keep a busy queue moving. It cannot raise it.
						</Field.Description>
						{#if capAboveDefault}
							<p class="warn">
								This cap is at or above the server's current default, so it changes nothing. Pick a lower one to
								actually cap this room.
							</p>
						{/if}
					</Card.Content>
</Card.Root>

				<Card.Root>
	<Card.Header>
		<Card.Title>The TV</Card.Title>
	</Card.Header>
	<Card.Content>
						<div class="pair">
							<div class="cell">
								<Field.Label for="tv-background">Background</Field.Label>
								<NativeSelect
									id="tv-background"
									value={settings.room.tvBackgroundStyle}
									onchange={(e) => onroom({ tvBackgroundStyle: e.currentTarget.value as TvBackgroundStyle })}
								>
									{#each TV_BACKGROUND_STYLES as s (s.id)}
										<option value={s.id}>{s.label}</option>
									{/each}
								</NativeSelect>
							</div>
							<div class="cell">
								<Field.Label for="tv-progress">Song progress</Field.Label>
								<NativeSelect
									id="tv-progress"
									value={settings.room.tvProgressStyle}
									onchange={(e) => onroom({ tvProgressStyle: e.currentTarget.value as TvProgressStyle })}
								>
									{#each TV_PROGRESS_STYLES as s (s.id)}
										<option value={s.id}>{s.label}</option>
									{/each}
								</NativeSelect>
							</div>
						</div>
						{#if tvBackgroundNote}<Field.Description>{tvBackgroundNote}</Field.Description>{/if}
						{#if tvProgressNote}<Field.Description>{tvProgressNote}</Field.Description>{/if}

						<!--
						Gated, not disabled: a visualizer picker means nothing for a black stage, and a control
						that does nothing for the current selection implies it does something.
					-->
						{#if settings.room.tvBackgroundStyle === 'visualizer'}
							<Field.Label for="tv-visualizer">Which visualizer</Field.Label>
							<NativeSelect
								id="tv-visualizer"
								value={settings.room.tvVisualizer}
								onchange={(e) => onroom({ tvVisualizer: e.currentTarget.value as TvVisualizerId })}
							>
								{#each TV_VISUALIZERS as v (v.id)}
									<option value={v.id}>{v.label}</option>
								{/each}
							</NativeSelect>
							{#if tvVisualizerNote}<Field.Description>{tvVisualizerNote}</Field.Description>{/if}
						{/if}

						<!-- The colour is BOTH the `solid` stage and the visualizer's palette, so it reveals for either. -->
						{#if settings.room.tvBackgroundStyle === 'solid' || settings.room.tvBackgroundStyle === 'visualizer'}
							<Field.Label data-inline for="tv-background-color">
								Background colour
								<span class="swatch" style="background: {tvBackgroundPreview}" aria-hidden="true"></span>
							</Field.Label>
							<!--
							A real colour input, not the hue slider this was until the stage-colour change: the room names a colour
							outright now rather than an angle rendered at a pinned lightness. oninput/onchange are
							split for the same reason every slider here splits them — the native picker fires
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

							<Field.Label for="tv-background-dim">
								Dim · {Math.round(settings.room.tvBackgroundDim * 100)}%
							</Field.Label>
							<!--
							Dims the stage colour toward black (owner ruling Q2 = A) — a lightness control, not
							a layer over the video. Split oninput/onchange like every other slider here: the
							readout above is the only display of the value, so it must track the thumb live, while
							only the committed `change` writes and broadcasts. Stored 0..1, shown as a percent; the
							range spans the full 0..100 the server clamp accepts.
						-->
							<Slider
								id="tv-background-dim"
								type="single"
								min={0}
								max={100}
								step={1}
								value={Math.round(settings.room.tvBackgroundDim * 100)}
								onValueChange={(v) => liveRoom('tvBackgroundDim', v / 100)}
								onValueCommit={(v) => onroom({ tvBackgroundDim: v / 100 })}
							/>
							<Field.Description>How far the stage colour is darkened toward black. 0% is the colour itself.</Field.Description>
						{/if}

						<label class="check" for="song-intro-on">
							<Checkbox
								id="song-intro-on"
								checked={settings.room.songIntroEnabled}
								onCheckedChange={(v) => onroom({ songIntroEnabled: v })}
							/>
							Song intro before each turn
						</label>
						<Field.Description>A card naming the song, artist and singer.</Field.Description>

						<Field.Label data-dim={!settings.room.songIntroEnabled || undefined} for="song-intro-ms">
							Intro holds for · {(settings.room.songIntroMs / 1000).toFixed(1)}s
						</Field.Label>
						<!--
					  The range MUST match the server clamp exactly (MIN/MAX_SONG_INTRO_MS). A slider narrower
					  than the clamp has shipped here before: the UI silently refuses values the server takes.
					-->
						<Slider
							id="song-intro-ms"
							type="single"
							min={MIN_SONG_INTRO_MS}
							max={MAX_SONG_INTRO_MS}
							step={SONG_INTRO_STEP_MS}
							disabled={!settings.room.songIntroEnabled}
							value={settings.room.songIntroMs}
							onValueChange={(v) => liveRoom('songIntroMs', v)}
							onValueCommit={(v) => onroom({ songIntroMs: v })}
						/>
					</Card.Content>
</Card.Root>

				<Card.Root>
	<Card.Header>
		<Card.Title>Lyrics on the TV</Card.Title>
	</Card.Header>
	<Card.Content>
						<div class="pair">
							<div class="cell">
								<Field.Label for="lyrics-highlight">Highlight</Field.Label>
								<NativeSelect
									id="lyrics-highlight"
									value={settings.room.lyricsHighlight}
									onchange={(e) => onroom({ lyricsHighlight: e.currentTarget.value as LyricsHighlightId })}
								>
									{#each LYRICS_HIGHLIGHTS as h (h.id)}
										<option value={h.id}>{h.label}</option>
									{/each}
								</NativeSelect>
							</div>
							<div class="cell">
								<Field.Label for="lyrics-ball">Marker</Field.Label>
								<NativeSelect
									id="lyrics-ball"
									value={settings.room.lyricsBall}
									onchange={(e) => onroom({ lyricsBall: e.currentTarget.value as LyricsBallStyleId })}
								>
									{#each LYRICS_BALL_STYLES as s (s.id)}
										<option value={s.id}>{s.label}</option>
									{/each}
								</NativeSelect>
							</div>
						</div>
						{#if highlightNote}<Field.Description>{highlightNote}</Field.Description>{/if}
						{#if ballNote}<Field.Description>{ballNote}</Field.Description>{/if}

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
								<Field.Label for="lyrics-font">Font</Field.Label>
								<NativeSelect
									id="lyrics-font"
									value={settings.room.lyricsFont}
									onchange={(e) => onroom({ lyricsFont: e.currentTarget.value as LyricsFontId })}
								>
									{#each LYRICS_FONTS as f (f.id)}
										<option value={f.id}>{f.label}</option>
									{/each}
								</NativeSelect>
							</div>
							<div class="cell">
								<Field.Label for="lyrics-case">Letter case</Field.Label>
								<NativeSelect
									id="lyrics-case"
									value={settings.room.lyricsCase}
									onchange={(e) => onroom({ lyricsCase: e.currentTarget.value as LyricsCaseId })}
								>
									{#each LYRICS_CASES as c (c.id)}
										<option value={c.id}>{c.label}</option>
									{/each}
								</NativeSelect>
							</div>
						</div>
						{#if fontNote}<Field.Description>{fontNote}</Field.Description>{/if}
						{#if caseNote}<Field.Description>{caseNote}</Field.Description>{/if}

						<Field.Label for="lyrics-scale">Text size · {settings.room.lyricsScalePct}%</Field.Label>
						<Slider
							id="lyrics-scale"
							type="single"
							min={MIN_LYRICS_SCALE_PCT}
							max={MAX_LYRICS_SCALE_PCT}
							step={5}
							value={settings.room.lyricsScalePct}
							onValueChange={(v) => liveRoom('lyricsScalePct', v)}
							onValueCommit={(v) => onroom({ lyricsScalePct: v })}
						/>
						<!--
						Says PERCENT OF, not a size, because that is what it is: the TV already picks a size from
						its own height and this scales it. "48px" would mean nothing on a different screen.
					-->
						<Field.Description>Relative to the size the TV picks for its own screen.</Field.Description>

						<Field.Label for="lyrics-lead">
							Highlight runs ahead · {(settings.room.lyricsLeadMs / 1000).toFixed(2)}s
						</Field.Label>
						<Slider
							id="lyrics-lead"
							type="single"
							min={0}
							max={MAX_LYRICS_LEAD_MS}
							step={50}
							value={settings.room.lyricsLeadMs}
							onValueChange={(v) => liveRoom('lyricsLeadMs', v)}
							onValueCommit={(v) => onroom({ lyricsLeadMs: v })}
						/>

						<div class="pair">
							<div class="cell">
								<Field.Label for="lyrics-before">Lines sung · {settings.room.lyricsLinesBefore}</Field.Label>
								<Slider
									id="lyrics-before"
									type="single"
									min={0}
									max={MAX_LYRICS_LINES_BEFORE}
									step={1}
									value={settings.room.lyricsLinesBefore}
									onValueChange={(v) => liveRoom('lyricsLinesBefore', v)}
									onValueCommit={(v) => onroom({ lyricsLinesBefore: v })}
								/>
							</div>
							<div class="cell">
								<Field.Label for="lyrics-after">Lines ahead · {settings.room.lyricsLinesAfter}</Field.Label>
								<Slider
									id="lyrics-after"
									type="single"
									min={0}
									max={MAX_LYRICS_LINES_AFTER}
									step={1}
									value={settings.room.lyricsLinesAfter}
									onValueChange={(v) => liveRoom('lyricsLinesAfter', v)}
									onValueCommit={(v) => onroom({ lyricsLinesAfter: v })}
								/>
							</div>
						</div>
					</Card.Content>
</Card.Root>

				<Card.Root>
	<Card.Header>
		<Card.Title>Sound</Card.Title>
	</Card.Header>
	<Card.Content>
						<Field.Label for="guide-default">
							Guiding track · {Math.round(settings.room.guideLevelDefault * 100)}%
						</Field.Label>
						<Slider
							id="guide-default"
							type="single"
							min={0}
							max={100}
							step={1}
							value={Math.round(settings.room.guideLevelDefault * 100)}
							onValueChange={(v) => liveRoom('guideLevelDefault', v / 100)}
							onValueCommit={(v) => onroom({ guideLevelDefault: v / 100 })}
						/>
						<Field.Description>Starting vocal level. Singers can change it per song.</Field.Description>
						{#if settings.room.guideLevelDefault > 0}
							<Field.Description>Only songs cooked with their vocals kept can offer a guide.</Field.Description>
						{/if}

						<label class="check" for="loudness-norm">
							<Checkbox
								id="loudness-norm"
								checked={settings.room.loudnessNormalization}
								onCheckedChange={(v) => onroom({ loudnessNormalization: v })}
							/>
							Even out loud songs
						</label>
						<Field.Description>
							Turns down the few songs that are much louder than the rest, so you stop reaching for the volume. Quiet
							songs are left alone.
						</Field.Description>
					</Card.Content>
</Card.Root>

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
			</Tabs.Content>
			<Tabs.Content value="server">
			<!-- ── SERVER ─────────────────────────────────────────────────────── -->
			<div class="panel" id="panel-server" role="tabpanel" aria-labelledby="tab-server" tabindex="-1">
				<p class="scope-note">Affects every room on this server.</p>

				<Card.Root>
	<Card.Header>
		<Card.Title>Making karaoke</Card.Title>
	</Card.Header>
	<Card.Content>
						<!-- Stacked for the same measured reason as the lyrics engine below: "BS-RoFormer 1297". -->
						<Field.Label for="engine">Stem splitter</Field.Label>
						<NativeSelect
							id="engine"
							value={settings.global.defaultEngine}
							onchange={(e) => pickEngine(e.currentTarget.value)}
						>
							{#each liveEngines as engine (engine.id)}
								<option value={engine.id}>{engine.label}</option>
							{/each}
						</NativeSelect>

						<Field.Label for="model">Model</Field.Label>
						<NativeSelect
							id="model"
							value={settings.global.defaultModel}
							onchange={(e) => onglobal({ defaultModel: e.currentTarget.value })}
						>
							{#each liveModels as model (model.id)}
								<option value={model.id}>{model.label}</option>
							{/each}
						</NativeSelect>
						{#if liveNote}<Field.Description>{liveNote}</Field.Description>{/if}
						{#if liveSlow}
							<p class="warn">Slow on CPU — around 45 minutes per song. Better suited to upgrades.</p>
						{/if}

						<Field.Label for="fetcher">Where audio comes from</Field.Label>
						<NativeSelect
							id="fetcher"
							value={settings.global.defaultFetcher}
							onchange={(e) => onglobal({ defaultFetcher: e.currentTarget.value as FetcherId })}
						>
							{#each defaultFetchers as f (f.id)}
								<option value={f.id}>{f.label}</option>
							{/each}
						</NativeSelect>
						{#if fetcherNote}<Field.Description>{fetcherNote}</Field.Description>{/if}
						<!--
						Explicit blast radius, matched to the splitter warning above it: this is the acquirer
						EVERY new cook downloads its source through, and a worker that cannot run it fails the
						fetch before any separation starts.
					-->
						<p class="warn">
							Changes where every new cook gets its audio. A worker that cannot run it will fail the download.
						</p>
					</Card.Content>
</Card.Root>

				<Card.Root>
	<Card.Header>
		<Card.Title>Lyrics engine</Card.Title>
	</Card.Header>
	<Card.Content>
						<!--
						NOT paired two-up like the room controls, and measured rather than assumed: at 390px a
						half-width select leaves ~120px for its text, and these registries carry the app's
						longest option labels ("Forced alignment", "BS-RoFormer 1297"), which truncate there.
						The room's pairs were checked at the same width and fit. A truncated option is worse
						than a longer page, and this is the tab you visit once.
					-->
						<Field.Label for="asr-model">Reader</Field.Label>
						<NativeSelect
							id="asr-model"
							value={settings.global.asrModel}
							onchange={(e) => onglobal({ asrModel: e.currentTarget.value as GlobalSettings['asrModel'] })}
						>
							{#each ASR_MODELS as model (model.id)}
								<option value={model.id}>{model.label} · {model.params}</option>
							{/each}
						</NativeSelect>
						{#if asrNote}<Field.Description>{asrNote}</Field.Description>{/if}
						{#if asrSlow}
							<p class="warn">A big reader needs real memory and adds minutes to every cook on a CPU box.</p>
						{/if}

						<Field.Label for="sync-mode">Timing</Field.Label>
						<NativeSelect
							id="sync-mode"
							value={settings.global.syncMode}
							onchange={(e) => onglobal({ syncMode: e.currentTarget.value as GlobalSettings['syncMode'] })}
						>
							{#each SYNC_MODES as mode (mode.id)}
								<option value={mode.id}>{mode.label}</option>
							{/each}
						</NativeSelect>
						{#if syncNote}<Field.Description>{syncNote}</Field.Description>{/if}
					</Card.Content>
</Card.Root>

				<Card.Root>
	<Card.Header>
		<Card.Title>Joining</Card.Title>
	</Card.Header>
	<Card.Content>
						<Field.Label for="join-origin">Address phones join at</Field.Label>
						<Input
							id="join-origin"
							variant="mono"
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
						<Field.Description id="join-origin-hint">
							What the TV's QR code points at. Empty means <strong>{data.joinOriginFallback}</strong>.
						</Field.Description>
						{#if joinError}<p class="warn" role="alert">{joinError}</p>{/if}
						{#if joinSchemeMismatch}
							<p class="warn">This party runs over plain http, so phones cannot open an https address.</p>
						{/if}
					</Card.Content>
</Card.Root>

				<Card.Root>
	<Card.Content>
					<!--
						S5: Collapsible owns `aria-expanded`, `aria-controls` and the toggle. The <button> STAYS
						here via Bits UI's `child` snippet — `.disclose` is scoped CSS in this file, and a class handed
						to a component is scoped to the CALLER and stripped there as unused.
					-->
					<Collapsible.Root bind:open={advancedOpen}>
						<Collapsible.Trigger>
							{#snippet child({ props })}
								<button class="disclose" {...props}>
						<Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} />
						Advanced
						<span class="disclose-now">
							{settings.global.enqueueUpgrade ? 'Re-cook on' : 'Re-cook off'}
									</span>
								</button>
							{/snippet}
						</Collapsible.Trigger>

						<Collapsible.Content>
							{#snippet child({ props })}
								<Card.Content id="advanced-body" {...props}>
							<label class="check" for="enqueue-upgrade">
							<Checkbox
								id="enqueue-upgrade"
								checked={settings.global.enqueueUpgrade}
								onCheckedChange={(v) => onglobal({ enqueueUpgrade: v })}
							/>
								Re-cook at higher quality after each song
							</label>
							<Field.Description>Runs from the audio already saved — no re-download.</Field.Description>

							<!-- Stacked: these default to the roformer names, the longest labels in any registry. -->
							<Field.Label for="upgrade-engine">Upgrade splitter</Field.Label>
							<NativeSelect
								id="upgrade-engine"
								value={settings.global.upgradeEngine}
								onchange={(e) => pickUpgradeEngine(e.currentTarget.value)}
							>
								{#each SEPARATOR_ENGINES as engine (engine.id)}
									<option value={engine.id}>{engine.label}</option>
								{/each}
							</NativeSelect>

							<Field.Label for="upgrade-model">Upgrade model</Field.Label>
							<NativeSelect
								id="upgrade-model"
								value={settings.global.upgradeModel}
								onchange={(e) => onglobal({ upgradeModel: e.currentTarget.value })}
							>
								{#each upgradeModels as model (model.id)}
									<option value={model.id}>{model.label}</option>
								{/each}
							</NativeSelect>

							{#if settings.global.enqueueUpgrade && !upgradeIsBetter}
								<p class="warn">This is not better than the splitter above, so no upgrade will run.</p>
							{/if}
						</Card.Content>
							{/snippet}
						</Collapsible.Content>
					</Collapsible.Root>

				</Card.Content>
</Card.Root>

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
			</Tabs.Content>
		</Tabs.Root>
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
	/*
	 * S4: `.seg`, `.tab` and `.tab.on` left this file. Their appearance is ui/tabs's now, keyed on
	 * shadcn's `data-slot` — scoped CSS cannot reach an element a child component renders. Both guarded
	 * facts moved with it verbatim: `min-height: var(--tap)` (XR-PH-01) and the certified
	 * --accent/--on-accent pair at 5.09:1 (XR-COL-12).
	 */

	/* ── cards ──────────────────────────────────────────────────────────── */
	/*
	 * The same `.card` shape the remote uses for every row, so this page stops reading as a different
	 * application. The uppercase head matches the remote's `.grouphead` treatment.
	 */
	/*
	 * S4: `.card`, `.cardhead` and `.cardbody` left this file for ui/card. The visual change is
	 * accepted deliberately — shadcn's card is a ring rather than a border, with its own spacing scale
	 * and a normal-weight title where Encore's was small uppercase tracking. What it buys is the
	 * Header/Title/Content structure this page was already hand-rolling eleven times.
	 */
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

	/*
	 * S4: `.field`, `.field-swatch`, `.hint` and the `.dim` label state left this file for
	 * ui/field. The vertical rhythm they carried moved with them, because the registry's label has no
	 * margins and 27 stacked fields would otherwise collapse against each other.
	 */
	/* The duration is inert while the intro is off; the label recedes with its control. */
	/* A trailing 1em swatch after flowing text can wrap onto its own line at 320px, reading as an orphan
	   dot. A flex row keeps text and swatch together and lets them wrap as a unit if ever needed. */
	/*
	 * S2: `select`, `.text` and `.name-input` left this rule — their appearance moved INTO
	 * ui/input and ui/native-select, because Svelte's scoped CSS cannot reach an element inside a child
	 * component and a call-site utility is minted by nothing under `source(none)`. The range stays
	 * native until its Slider rebuild, so it keeps the rule.
	 */
	/*
	 * S3: the range sliders are <Slider> now. Their geometry — a 28px thumb on a 6px --track-bg
	 * rail at var(--tap) — moved into ui/slider, and with it the two parallel ::-webkit-slider-* and
	 * ::-moz-range-* rule sets a native range needed. Bits UI builds the control from real elements, so
	 * one set of rules replaces both. Width comes from the component too.
	 */
	/*
	 * A live swatch beside the label, so the choice is visible without walking to the TV. It carries no
	 * text, so it needs no contrast bar of its own — and there is no bar on the stage colour
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
	 * The stage colour input. A native `type="color"` — the whole point is that any colour is
	 * now reachable, so a bespoke control would only narrow what the platform already offers (including
	 * eyedroppers and OS palettes). Sized to the project's --tap (44px) minimum for the same reason the
	 * ranges are: the browser's default colour swatch is well under a thumb's worth of target.
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
	 * These were scoped `:not(.hue)` until that change, to spare the stage's hue slider its own full-height
	 * gradient track. That slider is gone — the stage is a colour input now — so the exclusion went with
	 * it rather than being left behind as a selector matching nothing.
	 */
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
	/*
	 * S3: was `.check input { width: 18px; height: 18px }`. The glyph is now <Checkbox>, which
	 * carries its own `size-[18px]` — scoped CSS cannot reach inside a child component, so the size had
	 * to move with it. The TAP TARGET is unchanged and still this label's `min-height: var(--tap)`,
	 * which is what the tap-floor ruling settled and what touch-targets.test.ts examines.
	 */

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
	/*
	 * PAGE LAYOUT ONLY (S1). Width, min-height, padding, type and the disabled opacity moved
	 * into <Button size="block">. What is left is where the button sits in this column, which is this
	 * page's business and not the component's. It lives on a wrapper because Tailwind is scoped to
	 * `@source ui/**` — a utility written here would be minted by nothing — and Svelte's scoped CSS
	 * cannot reach an element inside a child component either.
	 */
	.save-slot {
		margin-top: var(--space-xl);
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
