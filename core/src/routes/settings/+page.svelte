<!-- Three scopes: You is one person, Party is this room, Server is the machine. No socket here — every write is a
	per-field patch the server re-normalizes over CURRENT values, so a stale page can only change the field it sends.
	docs/FRONTEND.md#settings -->
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { untrack } from 'svelte';
	import { SETTINGS_TABS, type SettingsTabId } from '$lib/settings-tabs';
	import { goto, replaceState } from '$app/navigation';
	import Icon from '$lib/ui/Icon.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import ColourRing from '$lib/components/ColourRing.svelte';
	import { Input } from '$lib/components/ui/input';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Switch } from '$lib/components/ui/switch';
	import FieldSlider from '$lib/ui/FieldSlider.svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Alert from '$lib/components/ui/alert';
	import type { OfferedModel } from '$lib/contract';
	import {
		SEPARATOR_ENGINES,
		TV_PROGRESS_STYLES,
		TV_BACKGROUND_STYLES,
		TV_VISUALIZERS,
		ASR_MODELS,
		// Every id-to-record lookup goes through these accessors, never a hand-rolled `.find`, so the registry owns the shape.
		getAsrModel,
		getEngine,
		getLyricsHighlight,
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
		PROCESSES_UNCAPPED,
		MAX_PROCESSES_PER_SINGER_CEILING,
		QUEUE_ORDERS,
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
	} from '$lib/contract';

	interface Props {
		data: {
			/** You, without the session token — the load strips it before the page is serialised. */
			me: PublicSinger;
			/** Which scope to open, already resolved server-side so first paint is the right tab. */
			tab: SettingsTabId;
			settings: EffectiveSettings;
			/** What an empty join address resolves to — env var, else the address this page was opened at. */
			joinOriginFallback: string;
			/** Whether this phone reached the server over https. Only the server can answer this. */
			requestIsHttps: boolean;
			/**
			 * Separation models the CONNECTED WORKERS reported they can run, best upstream score first.
			 *
			 * Absent on an older server and empty until a worker's `worker:catalogue` frame lands, so every
			 * reader must fall back to the built-in engine lists rather than showing an empty picker.
			 */
			offeredModels?: OfferedModel[];
		};
	}
	let { data }: Props = $props();

	let tab = $state<SettingsTabId>(untrack(() => data.tab));

	// `replaceState`, not `goto`: a scope switch must not stack history entries that make Back walk tabs instead of
	// leaving the page. Shallow, so the server load does not re-run for a panel already in memory.
	function showTab(id: SettingsTabId) {
		tab = id;
		replaceState(`?tab=${id}`, {});
	}

	/* WRITABLE `$derived`, because a write lands optimistically AND a load re-run must re-adopt `data`. That is exactly
	   what writable `$derived` is; the `$state` + `untrack` + effect form this replaces was emulating it one microtask
	   late. `svelte/prefer-writable-derived` did NOT flag this one — the effect assigned TWO variables, which defeats
	   the rule's pattern match — so it survived while its twin on /tv was reported. */
	let settings = $derived(data.settings);

	/* The last value the SERVER confirmed. `settings` moves on every drag frame; this does not, so a rejected commit
	   rolls back to what the server holds rather than to the dragged value it refused. Also writable-derived: `patch()`
	   assigns it on a confirmed write, and a load re-run re-adopts. */
	let committed = $derived(data.settings);

	// PROCESSES_UNCAPPED is 0, and a bare 0 beside this label reads as a missing value — say it in words.
	const processCapLabel = $derived(
		settings.global.maxProcessesPerSinger === PROCESSES_UNCAPPED
			? 'no limit'
			: String(settings.global.maxProcessesPerSinger)
	);
	// Minutes read badly past an hour ("120 minutes"), and 0 is a sentinel here too.
	const graceLabel = $derived.by(() => {
		const minutes = settings.room.presenceGraceMinutes;
		if (minutes === 0) return 'no grace';
		if (minutes < 60) return `${minutes} min`;
		const hours = Math.floor(minutes / 60);
		const rest = minutes % 60;
		return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
	});
	let advancedOpen = $state(false);
	let failed = $state(false);

	// Upgrade-only engines are excluded: offering one here lets a singer pick what the server rejects.
	const liveEngines = SEPARATOR_ENGINES.filter((e) => e.liveSelectable);

	/* Models the CONNECTED WORKERS reported, newest catalogue first. Empty until a worker sends its
	   `worker:catalogue` frame (a few seconds after it joins) and on a fleet with no zoo installed — in which
	   case the pickers below show exactly what they always did.

	   This is the fix for a list that was compiled here by hand: it offered `instrumental_becruily` and two
	   ensemble models that no worker could run, so choosing one queued a job forever. A worker is the only
	   thing that knows what it can run. */
	const offered = $derived(data.offeredModels ?? []);
	/* Labelled with the architecture and the UPSTREAM score — never "measured", because it is not ours; see
	   SeparatorOffer. `⚠` marks a model only one worker has, since picking it pins every such job to that box. */
	const offeredOptions = $derived(
		offered.map((m) => {
			const sdr =
				typeof m.upstreamInstrumentalSdr === 'number' ? ` · ${m.upstreamInstrumentalSdr.toFixed(1)} dB upstream` : '';
			const lone = m.workerCount === 1 && (data.offeredModels ?? []).length > 0 ? ' ⚠ 1 worker' : '';
			return { id: m.token, label: `${m.label} [${m.architecture}]${sdr}${lone}` };
		})
	);
	const liveModels = $derived(getEngine(settings.global.defaultEngine)?.models ?? []);
	const upgradeModels = $derived(getEngine(settings.global.upgradeEngine)?.models ?? []);
	/* Built-in checkpoints first, then everything the fleet reported. Concatenated rather than replaced: the
	   built-ins route on their engine capability and keep working even with no catalogue at all. */
	const liveModelChoices = $derived([...liveModels, ...offeredOptions]);
	const upgradeModelChoices = $derived([...upgradeModels, ...offeredOptions]);

	// A slow engine on the LIVE path is the footgun worth naming in the UI: ~44min per song on CPU against ~50s.
	const liveSlow = $derived(getEngine(settings.global.defaultEngine)?.speed === 'slow');

	/* Built from the same registry and `qualityRank` that `resolveProcessSeparator` reads, so every offered ceiling is
	   one the resolver can honour. Sorted low→high because the cap is downward-only, and rank 0 is excluded: an unranked
	   model never wins, so offering it names a floor nothing sits at. */
	const qualityCeilings = liveEngines
		.flatMap((engine) =>
			engine.models.map((model) => ({
				rank: qualityRank(engine.id, model.id),
				label: `${engine.label} · ${model.label}`
			}))
		)
		.filter((c) => c.rank > 0)
		.sort((a, b) => a.rank - b.rank);

	// A cap at or above the default changes nothing, and the copy must say so rather than imply it raised quality.
	const defaultRank = $derived(qualityRank(settings.global.defaultEngine, settings.global.defaultModel));
	const capAboveDefault = $derived(
		settings.room.maxQualityRank !== null && settings.room.maxQualityRank >= defaultRank
	);

	// `local` names one media's already-present bytes, not a default a room could pick.
	const defaultFetchers = FETCHERS.filter((f) => f.id !== 'local');

	// Same footgun as a slow splitter: the one lever on wrong words is also the one that turns a two-minute process
	// into a long wait on a CPU box.
	const asrSlow = $derived(['slow', 'slowest'].includes(getAsrModel(settings.global.asrModel)?.speed ?? ''));

	// An "upgrade" that is not better never runs, so say so rather than let the toggle look active.
	const upgradeIsBetter = $derived(
		qualityRank(settings.global.upgradeEngine, settings.global.upgradeModel) >
			qualityRank(settings.global.defaultEngine, settings.global.defaultModel)
	);

	// Ask the SAME resolver the TV asks, never re-test syncMode here: a second opinion would make this page confidently
	// wrong about what is on screen.
	const resolved = $derived(resolveLyricsPresentation(settings));
	const lyricsClamped = $derived(resolved.clamped);
	const resolvedHighlight = $derived(getLyricsHighlight(resolved.highlight)?.label.toLowerCase() ?? resolved.highlight);
	const resolvedBall = $derived(resolved.ball !== 'off');

	/** Optimistic, then reconciled on the authoritative response; a refused write rolls back its OWN fields only. */
	async function patch(scope: 'global' | 'room', body: Record<string, unknown>) {
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
			/* Only the fields THIS write sent go back, and to what the server holds NOW — every other field keeps whatever
			   landed while this request was in flight. Restoring a whole pre-request snapshot silently undid a CONCURRENT
			   write: flip two toggles, the second is accepted, the first is refused, and the refusal put the accepted toggle
			   back too, so a setting the server has stored reads as off. */
			const restored = Object.fromEntries(Object.entries(committed[scope]).filter(([field]) => field in body));
			settings =
				scope === 'global'
					? { ...settings, global: { ...settings.global, ...restored } }
					: { ...settings, room: { ...settings.room, ...restored } };
			failed = true;
		}
	}

	const onglobal = (body: Partial<GlobalSettings>) => patch('global', body);
	const onroom = (body: Partial<RoomSettings>) => patch('room', body);

	// Moves one field on screen WITHOUT a write, so the readout — the only display of the value — tracks the thumb. The
	// commit is separate, and `committed` is the rollback baseline, so a drag frame is never it.
	function liveRoom<K extends keyof RoomSettings>(field: K, value: RoomSettings[K]) {
		settings = { ...settings, room: { ...settings.room, [field]: value } };
	}
	/** The same, for a GLOBAL field. */
	function liveGlobal<K extends keyof GlobalSettings>(field: K, value: GlobalSettings[K]) {
		settings = { ...settings, global: { ...settings.global, [field]: value } };
	}

	/* Switching engine MUST also move the model, or the server normalizes the invalid pair back and the choice reads as
	   not having stuck. One function for both slots, so the pairing cannot hold on one and be forgotten on the other. */
	function pickEngine(slot: 'default' | 'upgrade', id: string) {
		const engine = getEngine(id);
		if (!engine) return;
		const engineId = id as SeparatorEngineId;
		const modelId = engine.models[0]!.id;
		onglobal(
			slot === 'default'
				? { defaultEngine: engineId, defaultModel: modelId }
				: { upgradeEngine: engineId, upgradeModel: modelId }
		);
	}

	// The one free-text setting, so it needs a draft: `http` is not yet a valid origin, and a normalizer running per
	// keystroke fights the typist.
	let joinDraft = $state(untrack(() => data.settings.global.joinOrigin));
	let joinError = $state('');
	// Re-adopt ONLY when the persisted value moves: a plain effect mirroring `settings` also fires when an unrelated
	// field is patched, and would discard whatever is half-typed here.
	let syncedJoin = untrack(() => data.settings.global.joinOrigin);
	$effect(() => {
		const stored = settings.global.joinOrigin;
		if (stored !== syncedJoin) {
			syncedJoin = stored;
			joinDraft = stored;
		}
	});

	// An https address on a plain-http party makes the QR unopenable from the LAN. The reverse still opens.
	let joinSchemeMismatch = $derived(settings.global.joinOrigin.startsWith('https://') && !data.requestIsHttps);

	function commitJoinOrigin() {
		const normalized = normalizeJoinOrigin(joinDraft);
		if (normalized === null) {
			// Refused locally rather than sent: the server would normalize it back with no reason given.
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

	/* A DRAFT seeded from `data.me`, not a view of it: `untrack` keeps an echo of your own save from rewriting the field
	   under the cursor. `savedName`/`savedColour` are what the server last confirmed, and `dirty` has to compare against
	   those — the load never re-runs, so `data.me` would leave Save enabled forever. */
	let name = $state(untrack(() => data.me.displayName));
	let colour = $state(untrack(() => data.me.color));
	let savedName = $state(untrack(() => data.me.displayName));
	let savedColour = $state(untrack(() => data.me.color));
	let saving = $state(false);
	/* A REFUSAL IS A STATEMENT ABOUT A DRAFT, so it is stored WITH the draft it was about and read back through a
	   $derived that drops it the moment either field is edited. As a bare string it outlived its subject: refuse an
	   empty name, retype the old one, and "A name is needed" sat under a button that had gone back to reading `Done`
	   — a live reason contradicting the control it was about. Keying it also makes the exit path clean without a
	   clear of its own: a refusal is only ever recorded while `profileDirty`, which means its draft differs from the
	   saved pair, so the not-dirty branch (draft === saved pair) can never match one. The key is the RAW `name`, not
	   the trimmed one the patch sends, because the guest corrects what is in the field. */
	let profileRefusal = $state<{ name: string; colour: string; message: string } | null>(null);
	let confirmingLeave = $state(false);
	let leaving = $state(false);
	/** What a leave would cost, fetched when the confirm opens so it can state the price in numbers. */
	let leaveCost = $state<{ queuedCount: number; hasPlaying: boolean } | null>(null);

	const profileDirty = $derived(name.trim() !== savedName || colour !== savedColour);
	const canSaveProfile = $derived(profileDirty && name.trim().length > 0 && !saving);
	const profileError = $derived(
		profileRefusal && profileRefusal.name === name && profileRefusal.colour === colour ? profileRefusal.message : ''
	);

	async function saveProfile() {
		if (!canSaveProfile) return;
		saving = true;
		/* The draft AS SUBMITTED, snapshotted before the await: the field stays editable while the patch is in flight,
		   and a refusal that comes back about a name the guest has already replaced is not about what they can see. */
		const submitted = { name, colour };
		profileRefusal = null;
		const patchBody = { displayName: name.trim(), color: colour };
		try {
			const res = await fetch('/api/me', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patchBody)
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				profileRefusal = { ...submitted, message: body.error ?? 'Could not save that' };
				return;
			}
			savedName = patchBody.displayName;
			savedColour = patchBody.color;
			await goto('/');
		} catch {
			profileRefusal = { ...submitted, message: 'Could not save that' };
		} finally {
			saving = false;
		}
	}

	/* THE YOU SCOPE'S ONE COMMIT, so it has to cover both jobs — commit-and-close while an edit is pending, and the
	   plain exit when none is. An empty name is refused LOCALLY, the way `commitJoinOrigin` refuses an address a phone
	   cannot open, rather than sent for the server to bounce with the same words or left to a disabled button that
	   states no reason. `saveProfile` owns the navigation on success and stays put with the reason on a refusal, so
	   there is no second `goto` on the save path. */
	async function finishYou() {
		if (!profileDirty) {
			await goto('/');
			return;
		}
		if (name.trim().length === 0) {
			profileRefusal = { name, colour, message: 'A name is needed — type one, or put your old name back.' };
			return;
		}
		await saveProfile();
	}

	/** Fetched on OPEN so the number is current when read out, and best-effort so a failure cannot block. */
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
		// The cookie is gone, so `/` (the landing page) is the only honest destination; a reload would 401 into the same
		// place after a flash of an empty page.
		await goto('/');
	}

	/** Counts, not adjectives: a leave clears the cookie and forgets the singer, so there is no undo. */
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

<!-- ONE SHAPE FOR A REGISTRY-BACKED SELECT, rendered eleven times. Every one was the same five lines: a label bound
	by `for`, a native select, and an `{#each}` over a registry of `{id, label}`. The `id` is passed EXPLICITLY and
	never derived, because `p9-settings.spec.ts` drives these controls by id and `SEL.settingsTab` resolves
	`#tab-<id>` — so the spelling is a contract, not an implementation detail.
	Two selects deliberately do NOT come through here: `quality-ceiling` carries an empty "no cap" option over a
	registry keyed on `rank`, and `asr-model` composes its option label from two fields. Parameterising for either
	would add a knob that exists for one caller. -->
{#snippet selectField(
	id: string,
	label: string,
	value: string,
	options: readonly { id: string; label: string }[],
	pick: (v: string) => void
)}
	<Field.Label for={id}>{label}</Field.Label>
	<NativeSelect id={id} value={value} onchange={(e) => pick(e.currentTarget.value)}>
		{#each options as o (o.id)}
			<option value={o.id}>{o.label}</option>
		{/each}
	</NativeSelect>
{/snippet}

<svelte:head><title>Settings · Encore</title></svelte:head>

<div class="settings-page">
	<!-- `Card.Title` renders a <div>, so every styled card title on this page was a visual heading with no heading
		SEMANTICS — ten cards deep, and the whole outline was its h1. Screen-reader users navigate a long dashboard by
		heading, so `role="heading" aria-level={2}` is added at each call site rather than re-vendoring the primitive,
		which forwards restProps for exactly this. Level 2 because PageHeader owns the single h1. -->
	<PageHeader title="Settings" icon="gear" back={{ href: '/', label: 'Back to the remote' }} />

	<main>
		{#if failed}
			<Alert.Root variant="destructive">
				<Alert.Title>That change could not be saved. Reverted to the last good value.</Alert.Title>
			</Alert.Root>
		{/if}

		<Tabs.Root value={tab} onValueChange={(v) => showTab(v as SettingsTabId)}>
			<Tabs.List aria-label="Settings scope">
				{#each SETTINGS_TABS as t (t.id)}
					<!-- The explicit id is load-bearing: Bits UI would generate its own, and both SEL.settingsTab and capture.mjs
							resolve `#tab-<id>` by this spelling. -->
					<Tabs.Trigger id="tab-{t.id}" value={t.id}>{t.label}</Tabs.Trigger>
				{/each}
			</Tabs.List>

			<Tabs.Content value="you">
				<!-- `.panel` is LAYOUT only and must carry no tabpanel role, aria-labelledby or tabindex: Tabs.Content already
						renders the tabpanel, and a second one nests two inside each other. -->
				<div class="panel">
					<Card.Root>
						<Card.Header>
							<Card.Title role="heading" aria-level={2}>You</Card.Title>
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

							<!-- `taken` is DELIBERATELY empty: the pips mean "somebody in the room holds this", and this page's load carries
									no occupancy, so an invented list would draw pips at nobody. -->
							<ColourRing
								bind:value={colour}
								label="Your color"
								hint="How you'll spot yourself in the queue and on the TV."
								taken={[]}
							/>

							{#if profileError}<p class="err" role="alert">{profileError}</p>{/if}

							<!-- ONE COMMIT CONTROL FOR THIS PANE, and its label says which of its two jobs it is doing. There used to
									be a second: this `Save` plus a panel-level `Done`, both the `default` variant, so from the first
									keystroke they were two identical --accent block buttons — and `Done` was a bare `goto('/')`, which
									DISCARDED the typed name and the picked colour with nothing on screen saying so. It stays INSIDE the
									card because the refusals it produces name this field ("That name is taken — try another."), and a
									reason belongs beside what has to be corrected. The cost, kept deliberately, is that this panel ends on
									the Leaving card instead of on its own exit — see FRONTEND.md's Settings section for why last belongs
									to the destructive card here. -->
							<div class="save-slot">
								<Button size="block" disabled={saving} onclick={finishYou}>
									{#if saving}Saving…{:else if profileDirty}Save and close{:else}Done{/if}
								</Button>
							</div>
						</Card.Content>
					</Card.Root>

					<!-- Its own card: leaving cannot be undone, so the boundary is drawn rather than implied. -->
					<Card.Root>
						<Card.Header>
							<Card.Title role="heading" aria-level={2}>Leaving</Card.Title>
						</Card.Header>
						<Card.Content>
							<!-- AlertDialog, not Dialog: `role="alertdialog"` announces the description on open, and it has no click-outside
									dismissal, which a destructive confirm must not have. -->
							<AlertDialog.Root bind:open={confirmingLeave}>
								<AlertDialog.Trigger>
									{#snippet child({ props })}
										<Button {...props} variant="destructive" onclick={askLeave}>Leave the room</Button>
									{/snippet}
								</AlertDialog.Trigger>
								<AlertDialog.Content>
									<AlertDialog.Header>
										<AlertDialog.Title>Leave the room?</AlertDialog.Title>
										<!-- The DESCRIPTION, never a second role="alert" paragraph: alertdialog already announces this on open. -->
										<AlertDialog.Description>{leaveWarning}</AlertDialog.Description>
									</AlertDialog.Header>
									<AlertDialog.Footer>
										<AlertDialog.Cancel variant="ghost">Stay</AlertDialog.Cancel>
										<AlertDialog.Action variant="destructive" disabled={leaving} onclick={leaveRoom}>
											{#if leaving}Leaving…{:else}Yes, leave{/if}
										</AlertDialog.Action>
									</AlertDialog.Footer>
								</AlertDialog.Content>
							</AlertDialog.Root>
						</Card.Content>
					</Card.Root>
				</div>
			</Tabs.Content>
			<Tabs.Content value="party">
				<div class="panel">
					<!-- layout only — see the YOU panel for why no tabpanel role here -->
					<Card.Root>
						<Card.Header>
							<Card.Title role="heading" aria-level={2}>Rotation</Card.Title>
						</Card.Header>
						<Card.Content>
							{@render selectField('queue-order', 'Who sings next', settings.room.queueOrder, QUEUE_ORDERS, (v) =>
								onroom({ queueOrder: v as QueueOrderId })
							)}

							<Field.Label for="presence-grace">
								Kick out after · {graceLabel}
							</Field.Label>
							<FieldSlider
								id="presence-grace"
								label="Grace period before a quiet phone loses its turn"
								type="single"
								min={MIN_PRESENCE_GRACE_MINUTES}
								max={MAX_PRESENCE_GRACE_MINUTES}
								step={15}
								value={settings.room.presenceGraceMinutes}
								onValueChange={(v) => liveRoom('presenceGraceMinutes', v)}
								onValueCommit={(v) => onroom({ presenceGraceMinutes: v })}
							/>
						</Card.Content>
					</Card.Root>

					<Card.Root>
						<Card.Header>
							<Card.Title role="heading" aria-level={2}>Process quality</Card.Title>
						</Card.Header>
						<Card.Content>
							<Field.Label for="quality-ceiling">Quality ceiling</Field.Label>
							<!-- The option VALUE is a `qualityRank`, and the empty option is null = no cap. -->
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

							{#if capAboveDefault}
								<p class="warn">At or above the server default, so it changes nothing.</p>
							{/if}
						</Card.Content>
					</Card.Root>

					<Card.Root>
						<Card.Header>
							<Card.Title role="heading" aria-level={2}>The TV</Card.Title>
						</Card.Header>
						<Card.Content>
							<div class="pair">
								<div class="cell">
									{@render selectField(
										'tv-background',
										'Background',
										settings.room.tvBackgroundStyle,
										TV_BACKGROUND_STYLES,
										(v) => onroom({ tvBackgroundStyle: v as TvBackgroundStyle })
									)}
								</div>
								<div class="cell">
									{@render selectField(
										'tv-progress',
										'Song progress',
										settings.room.tvProgressStyle,
										TV_PROGRESS_STYLES,
										(v) => onroom({ tvProgressStyle: v as TvProgressStyle })
									)}
								</div>
							</div>

							<!-- Gated, not disabled: a control that does nothing for the current selection implies it does. -->
							{#if settings.room.tvBackgroundStyle === 'visualizer'}
								{@render selectField(
									'tv-visualizer',
									'Which visualizer',
									settings.room.tvVisualizer,
									TV_VISUALIZERS,
									(v) => onroom({ tvVisualizer: v as TvVisualizerId })
								)}
							{/if}

							<!-- The colour is BOTH the `solid` stage and the visualizer's palette, so it reveals for either. -->
							{#if settings.room.tvBackgroundStyle === 'solid' || settings.room.tvBackgroundStyle === 'visualizer'}
								<!-- Swatch and input both render the STORED string, so the phone cannot promise a colour the TV renders
										differently. It arrives as a custom property, never interpolated into `background:` — see
										docs/GUARDS.md#colour-tokens-and-the-48-stop-palette. -->
								<Field.Label data-inline for="tv-background-color">
									Background colour
									<span class="swatch" style="--swatch:{settings.room.tvBackgroundColor}" aria-hidden="true"></span>
								</Field.Label>
								<!-- oninput/onchange split as every slider here does: the native picker fires `input` continuously, so the swatch
										tracks live while only `change` writes and broadcasts. -->
								<input
									id="tv-background-color"
									class="colour"
									type="color"
									value={settings.room.tvBackgroundColor}
									oninput={(e) => liveRoom('tvBackgroundColor', e.currentTarget.value)}
									onchange={(e) => onroom({ tvBackgroundColor: e.currentTarget.value })}
								/>

								<Field.Label for="tv-background-dim">
									Darken the stage · {Math.round(settings.room.tvBackgroundDim * 100)}%
								</Field.Label>
								<!-- A lightness control on the stage colour, not a layer over the video. Stored 0..1 and shown as a percent,
										spanning the full range the server clamp accepts. -->
								<FieldSlider
									id="tv-background-dim"
									label="TV background dim"
									type="single"
									min={0}
									max={100}
									step={1}
									value={Math.round(settings.room.tvBackgroundDim * 100)}
									onValueChange={(v) => liveRoom('tvBackgroundDim', v / 100)}
									onValueCommit={(v) => onroom({ tvBackgroundDim: v / 100 })}
								/>
							{/if}

							<label class="check" for="song-intro-on">
								<Switch
									id="song-intro-on"
									checked={settings.room.songIntroEnabled}
									onCheckedChange={(v) => onroom({ songIntroEnabled: v })}
								/>
								Song intro before each turn
							</label>

							<Field.Label data-dim={!settings.room.songIntroEnabled || undefined} for="song-intro-ms">
								Song intro duration · {(settings.room.songIntroMs / 1000).toFixed(1)}s
							</Field.Label>
							<!-- The range MUST match the server clamp exactly, or the UI silently refuses values it takes. -->
							<FieldSlider
								id="song-intro-ms"
								label="Song intro length"
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
							<Card.Title role="heading" aria-level={2}>Lyrics on the TV</Card.Title>
						</Card.Header>
						<Card.Content>
							<div class="pair">
								<div class="cell">
									{@render selectField(
										'lyrics-highlight',
										'Highlight',
										settings.room.lyricsHighlight,
										LYRICS_HIGHLIGHTS,
										(v) => onroom({ lyricsHighlight: v as LyricsHighlightId })
									)}
								</div>
								<div class="cell">
									{@render selectField('lyrics-ball', 'Marker', settings.room.lyricsBall, LYRICS_BALL_STYLES, (v) =>
										onroom({ lyricsBall: v as LyricsBallStyleId })
									)}
								</div>
							</div>

							<!-- Say when a choice is not honoured: under line-only timing a word treatment has nothing to light, and a picker
									that silently does nothing is worse than one that explains itself. -->
							{#if lyricsClamped}
								<p class="warn">
									No word timings on this server, so it shows <strong>{resolvedHighlight}</strong>{resolvedBall
										? ''
										: ' with no marker'}.
								</p>
							{/if}

							<div class="pair">
								<div class="cell">
									{@render selectField('lyrics-font', 'Font', settings.room.lyricsFont, LYRICS_FONTS, (v) =>
										onroom({ lyricsFont: v as LyricsFontId })
									)}
								</div>
								<div class="cell">
									{@render selectField('lyrics-case', 'Letter case', settings.room.lyricsCase, LYRICS_CASES, (v) =>
										onroom({ lyricsCase: v as LyricsCaseId })
									)}
								</div>
							</div>

							<Field.Label for="lyrics-scale"
								>Lyric size · {settings.room.lyricsScalePct}% of the TV's default</Field.Label
							>
							<FieldSlider
								id="lyrics-scale"
								label="Lyric size on the TV"
								type="single"
								min={MIN_LYRICS_SCALE_PCT}
								max={MAX_LYRICS_SCALE_PCT}
								step={5}
								value={settings.room.lyricsScalePct}
								onValueChange={(v) => liveRoom('lyricsScalePct', v)}
								onValueCommit={(v) => onroom({ lyricsScalePct: v })}
							/>

							<Field.Label for="lyrics-lead">
								Highlight runs ahead · {(settings.room.lyricsLeadMs / 1000).toFixed(2)}s
							</Field.Label>
							<FieldSlider
								id="lyrics-lead"
								label="How far ahead of the audio the lyric highlight runs"
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
									<Field.Label for="lyrics-before">Lines behind · {settings.room.lyricsLinesBefore}</Field.Label>
									<FieldSlider
										id="lyrics-before"
										label="Lyric lines kept behind the current one"
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
									<FieldSlider
										id="lyrics-after"
										label="Lyric lines shown ahead of the current one"
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
							<Card.Title role="heading" aria-level={2}>Sound</Card.Title>
						</Card.Header>
						<Card.Content>
							<Field.Label for="guide-default">
								Guiding track · {Math.round(settings.room.guideLevelDefault * 100)}%
							</Field.Label>
							<FieldSlider
								id="guide-default"
								label="Default guiding-track level for the room"
								type="single"
								min={0}
								max={100}
								step={1}
								value={Math.round(settings.room.guideLevelDefault * 100)}
								onValueChange={(v) => liveRoom('guideLevelDefault', v / 100)}
								onValueCommit={(v) => onroom({ guideLevelDefault: v / 100 })}
							/>

							<label class="check" for="loudness-norm">
								<Switch
									id="loudness-norm"
									checked={settings.room.loudnessNormalization}
									onCheckedChange={(v) => onroom({ loudnessNormalization: v })}
								/>
								Match song loudness
							</label>
						</Card.Content>
					</Card.Root>

					<!-- /stats is the GUEST dashboard, so it is the one safe to reach from any phone's surface. -->
					<Button variant="outline" size="block" href="/stats">
						<Icon name="sparkle" />
						Party stats <Badge variant="neutral">safe to share</Badge>
					</Button>

					<Button size="block" onclick={() => goto('/')}>Done</Button>
				</div>
			</Tabs.Content>
			<Tabs.Content value="server">
				<div class="panel">
					<!-- layout only — see the YOU panel for why no tabpanel role here -->

					<Card.Root>
						<Card.Header>
							<Card.Title role="heading" aria-level={2}>Making karaoke</Card.Title>
						</Card.Header>
						<Card.Content>
							<!-- Stacked, not paired: these registries carry the app's longest labels, which truncate in half a 390px row. -->
							{@render selectField('engine', 'Stem splitter', settings.global.defaultEngine, liveEngines, (v) =>
								pickEngine('default', v)
							)}

							{@render selectField('model', 'Model', settings.global.defaultModel, liveModelChoices, (v) =>
								onglobal({ defaultModel: v })
							)}

							{#if liveSlow}
								<p class="warn">~45 minutes per song on CPU.</p>
							{/if}

							{@render selectField('fetcher', 'Audio source', settings.global.defaultFetcher, defaultFetchers, (v) =>
								onglobal({ defaultFetcher: v as FetcherId })
							)}

							<!-- A slider, not a number field: the range is short and bounded at both ends, and a text field would invite the
									3000 that `normalizeMaxProcesses` exists to refuse. -->
							<Field.Label for="max-processes">Songs one singer can make at once · {processCapLabel}</Field.Label>
							<FieldSlider
								id="max-processes"
								label="Songs one singer can make at once"
								type="single"
								min={PROCESSES_UNCAPPED}
								max={MAX_PROCESSES_PER_SINGER_CEILING}
								step={1}
								value={settings.global.maxProcessesPerSinger}
								onValueChange={(v) => liveGlobal('maxProcessesPerSinger', v)}
								onValueCommit={(v) => onglobal({ maxProcessesPerSinger: v })}
							/>
							<Field.Description>
								A guest can start this many karaoke jobs at a time; finished songs free a slot straight away. Nothing
								stops one phone tapping Sing down a whole page of results, and each tap is a 1–2 minute job for your
								workers.
							</Field.Description>
						</Card.Content>
					</Card.Root>

					<Card.Root>
						<Card.Header>
							<Card.Title role="heading" aria-level={2}>Lyrics engine</Card.Title>
						</Card.Header>
						<Card.Content>
							<!-- Stacked for the same measured reason as the splitter above: a half-width select at 390px leaves ~120px. -->
							<Field.Label for="asr-model">Lyrics reader</Field.Label>
							<NativeSelect
								id="asr-model"
								value={settings.global.asrModel}
								onchange={(e) => onglobal({ asrModel: e.currentTarget.value as GlobalSettings['asrModel'] })}
							>
								{#each ASR_MODELS as model (model.id)}
									<option value={model.id}>{model.label} · {model.params}</option>
								{/each}
							</NativeSelect>

							{#if asrSlow}
								<p class="warn">Needs real memory, and minutes more per song on CPU.</p>
							{/if}

							{@render selectField('sync-mode', 'Lyric timing', settings.global.syncMode, SYNC_MODES, (v) =>
								onglobal({ syncMode: v as GlobalSettings['syncMode'] })
							)}
						</Card.Content>
					</Card.Root>

					<Card.Root>
						<Card.Header>
							<Card.Title role="heading" aria-level={2}>Joining</Card.Title>
						</Card.Header>
						<Card.Content>
							<Field.Label for="join-origin">Join address</Field.Label>
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
							<Field.Description id="join-origin-hint"
								>Empty means <strong>{data.joinOriginFallback}</strong>.</Field.Description
							>
							{#if joinError}<p class="err" role="alert">{joinError}</p>{/if}
							{#if joinSchemeMismatch}
								<p class="warn">This party runs over plain http — phones cannot open an https address.</p>
							{/if}
						</Card.Content>
					</Card.Root>

					<Card.Root>
						<Card.Content>
							<!-- Collapsible owns aria-expanded, aria-controls and the toggle; the <button> stays here through the `child`
									snippet so this file's scoped CSS can reach it. -->
							<Collapsible.Root bind:open={advancedOpen}>
								<Collapsible.Trigger>
									{#snippet child({ props })}
										<Button variant="ghost" size="block" {...props}>
											<Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} />
											Advanced
											<span class="disclose-now">
												{settings.global.enqueueUpgrade ? 'Re-process on' : 'Re-process off'}
											</span>
										</Button>
									{/snippet}
								</Collapsible.Trigger>

								<Collapsible.Content>
									{#snippet child({ props })}
										<!-- NO `id` here. bits-ui's Collapsible.Content defaults `id = createId(uid)` and passes it
											 through `{...props}`, which spreads AFTER any literal and wins — so an `id` written here is
											 silently dropped. Do not "fix" that by moving the literal after the spread either: the
											 Trigger's `aria-controls` names bits-ui's generated id, so overriding it would point the
											 control at an element that no longer carries that id. -->
										<Card.Content {...props}>
											<label class="check" for="enqueue-upgrade">
												<Switch
													id="enqueue-upgrade"
													checked={settings.global.enqueueUpgrade}
													onCheckedChange={(v) => onglobal({ enqueueUpgrade: v })}
												/>
												Re-process at higher quality, from the saved audio
											</label>

											{@render selectField(
												'upgrade-engine',
												'Upgrade splitter',
												settings.global.upgradeEngine,
												SEPARATOR_ENGINES,
												(v) => pickEngine('upgrade', v)
											)}

											{@render selectField(
												'upgrade-model',
												'Upgrade model',
												settings.global.upgradeModel,
												upgradeModelChoices,
												(v) => onglobal({ upgradeModel: v })
											)}

											{#if settings.global.enqueueUpgrade && !upgradeIsBetter}
												<p class="warn">Not better than the splitter above, so nothing will re-process.</p>
											{/if}
										</Card.Content>
									{/snippet}
								</Collapsible.Content>
							</Collapsible.Root>
						</Card.Content>
					</Card.Root>

					<!-- /metrics is ungated, so this is its ONLY link: from the remote or the TV it would advertise worker ids, model
							names, host details and error strings to every device in the room. -->
					<Button variant="outline" size="block" href="/metrics">
						<Icon name="clock" />
						Processing metrics <Badge variant="neutral">internal</Badge>
					</Button>

					<Button size="block" onclick={() => goto('/')}>Done</Button>
				</div>
			</Tabs.Content>
		</Tabs.Root>
	</main>
</div>

<style>
	/* Three nested measures, and the width is spent on a second column of CARDS rather than on wider controls.
	   See docs/FRONTEND.md#settings for what each token means and where each level applies. */
	.settings-page {
		--page-measure: var(--measure-grid);
		/* Not --measure-prose (560): two of those plus the gap need 1132, more than the widest shell, so a prose threshold
			   would never pair anything. At 420 the panel pairs from 852 up. */
		--settings-col: 420px;
	}

	main {
		/* Kept in sync with --page-measure above, so the header aligns with this column. */
		max-width: var(--measure-grid);
		margin: 0 auto;
		/* Reserves the band. No env() term: the band carries the only home-indicator inset, and it reaches this column
			   through --dock-h, so a second one here is the doubled gap. */
		padding: var(--space-md) var(--space-2xl) calc(var(--dock-h, 0px) + 28px);
	}

	/* A label binds to its own control, fixed in the CASCADE rather than by restructuring every row into Field.Root
	   wrappers: the card's single gap is the intra-group distance, and a label that FOLLOWS a control takes the
	   inter-group distance back as a margin, so a card's first label is untouched. Keyed on `data-slot`, which survives a
	   re-vendor, and `:global()` because scoped CSS cannot reach ui/card's box. */
	main :global([data-slot='card-content']) {
		gap: var(--space-sm);
	}
	/* THE MARGIN IS A DELTA, NOT THE BOUNDARY. card-content is a FLEX column, and flex does not collapse margins, so
	   what the guest sees is `gap + margin-top` — the 8px above plus this. That arithmetic is the whole reason this
	   spends `lg` and not `4xl`: at `4xl` the rendered boundary was 8 + 20 = 28px against the 24px card-to-card row
	   gap below, so the container read TIGHTER than the thing nested inside it (0.86x) — the same inversion the
	   `.panel` gap was raised to fix, one level down and in the other direction. At `lg` it renders 8 + 12 = 20px,
	   which sits under the 24px container (1.20x) and still out-ranks the card's own 8px sibling gap by 2.5x. So the
	   three boundaries on this surface run monotone: 8 inside a group, 20 between groups, 24 between cards. It was
	   `xl` (8 + 14 = 22, 1.09x) until app.css retired that rung; a 32px `.panel` is still refused on purpose. */
	main :global([data-slot='card-content'] > * + [data-slot='field-label']) {
		margin-top: var(--space-lg);
	}
	/* ColourRing's label is a FIELD label (app.css's `.control-label`) but not a `[data-slot='field-label']`, so the rule
	   above cannot reach it and the boundary has to be taken on its WRAPPER, which is the card-content child. Without
	   this the You card drew the same boundary two ways: 20px above a second `Field.Label` (8px gap + 12px) against 8px
	   above the ring. The old dress hid that; one register does not. (22px when measured at 390x844, on the old `xl`.) */
	main :global([data-slot='card-content'] > * + .ring-field) {
		margin-top: var(--space-lg);
	}

	.panel {
		/* A grid, not a flex column: `auto-fit` collapses the empty tracks, so at one column this is the plain stack.
			   `align-items: start` matters — `stretch` would pad the shorter card out to its neighbour. */
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--settings-col)), 1fr));
		align-items: start;
		/* TWO VALUES, and the split is the point. The ROW gap is the card-to-card SECTION boundary and takes the
			   section rung. Both figures below are RENDERED boundaries, not declared margins, because the margin above
			   is a delta on card-content's 8px flex gap: at --space-lg a card boundary was 12px while a group boundary
			   INSIDE one card rendered at 28px (8 + 20), so the container read less than half the thing nested in it —
			   0.43x. It is 24px against 20px (8 + 12) now, 1.20x; the intra-card rule came down 4xl -> xl to get there,
			   then to lg when app.css retired `xl`. The COLUMN gap stays --space-lg so the pairing threshold stays the
			   measured 2*420 + 12 = 852px that docs/FRONTEND.md records; 24px both ways would move it to 864. */
		gap: var(--space-5xl) var(--space-lg);
	}
	/* Anything in a panel that is not a card is about the PANEL, so it spans: a half-width footer button would land
	   beside a card and read as part of it. Keyed on shadcn's attribute, so a new control gets this free. */
	.panel > :global(:not([data-slot='card'])) {
		grid-column: 1 / -1;
	}

	.pair {
		/* Grid, not flex, so the gap SURVIVES the collapse below: a flex row switched to `display:block` loses its gap
			   entirely, which met a Cancel and a destructive action edge-to-edge. */
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-md);
	}
	/* `.pair` is a grid, so no `flex` here — only the shrink floor the ellipsis needs. */
	.cell {
		min-width: 0;
	}
	@media (max-width: 380px) {
		.pair {
			grid-template-columns: 1fr;
		}
	}

	/* THE LANDSCAPE CLAW-BACK, the arm `/`, `/library` and `song/[mediaId]` all carry as a `.grouphead` re-declaration
	   inside their own `@media (max-height: 480px)` block — named by rule rather than by line, because one of the three
	   line numbers that stood here had already drifted while the other two were being kept fresh by hand — on the same
	   threshold and for the same reason: a phone held sideways spends almost the whole height on chrome, and the section
	   rung is a PORTRAIT ruling. This is the one surface that spends that rung as a grid GAP rather than as
	   `.grouphead`'s margin, which is why the claw-back is spelled here instead. Without this arm the rung
	   was pure unconditional cost here — measured at 844x390 against the same panels forced back to a 12px row gap,
	   the Party panel grew 1767.8 -> 1839.8px (+72), Server 1628.6 -> 1688.6 (+60), You 717.2 -> 729.2 (+12), which
	   is 18.5% of that viewport's height on the worst panel.
	   BOTH boundaries move together, because clawing only the row gap back to 12px would re-invert the surface
	   against the 20px rendered intra-card boundary above. `--space-3xs` is spelled as a DELTA on card-content's 8px
	   flex gap, not as a register: 8 + 2 renders 10px, so the compressed ladder is still monotone — 8 inside a group,
	   10 between groups, 12 between cards (1.25x and 1.20x). Portrait keeps 8 / 20 / 24.
	   `row-gap` alone, never the `gap` shorthand: the COLUMN gap is what fixes the 852px pairing threshold, and a
	   sideways phone is nowhere near it.
	   Both rules tie their base on specificity (0,3,1 for the card-content pair, 0,2,0 for `.panel`) and therefore win
	   on SOURCE ORDER only — a media query adds nothing — so this arm has to stay BELOW both bases, and a later rule
	   re-declaring either one would silently out-cascade it. */
	@media (max-height: 480px) {
		main :global([data-slot='card-content'] > * + [data-slot='field-label']),
		main :global([data-slot='card-content'] > * + .ring-field) {
			margin-top: var(--space-3xs);
		}
		.panel {
			row-gap: var(--space-lg);
		}
	}

	/* Carries no text, so it needs no contrast floor of its own — and neither does the stage colour: what matters is the
	   lyrics ON the stage, which the reel enforces with its own stroke. */
	.swatch {
		display: inline-block;
		background: var(--swatch);
		width: 1em;
		height: 1em;
		margin-left: 0.5em;
		border-radius: var(--radius-xs);
		border: 1px solid var(--line);
		vertical-align: -0.15em;
	}
	/* Native `type="color"`, so eyedroppers and OS palettes come free, sized up to --tap because the browser's default
	   swatch is well under a thumb's worth of target. */
	input[type='color'].colour {
		width: 100%;
		height: var(--tap);
		padding: var(--space-2xs);
		background: var(--field-bg, transparent);
		/* --control-line and NOT --line: a native colour input is a form control, so this border is what identifies it and
		   takes SC 1.4.11's 3:1 floor. --field-bg is set nowhere, so the fill is always the parent surface, and the token
		   clears 3:1 on every surface app.css declares (worst 3.13:1, on --track-bg). `.swatch` above keeps --line: it is a static span
		   whose INFORMATION is its own fill, so its hairline is decoration. */
		border: 1px solid var(--control-line);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
	/* ADVISORY ONLY — a cost, a no-op, a heads-up. A REFUSAL takes `.err` below and never this rule. */
	.warn {
		margin: var(--space-xs) 0 0;
		font-size: var(--ph-text-xs);
		color: var(--warn);
	}
	/* --danger-ink, because --warn is the transient self-healing tone six advisories on this page already wear
	   ("~45 minutes per song on CPU"): a rejected profile save and a rejected join address were painted that same amber,
	   so a guest could not tell a hint from the one thing they had to act on. This is the ink the rest of the app
	   spends on a failure — `.err[role=alert]` on the join screen, the destructive Alert at the top of this page —
	   and the box is `.warn`'s to the pixel, so swapping the class moves nothing. */
	.err {
		margin: var(--space-xs) 0 0;
		font-size: var(--ph-text-xs);
		color: var(--danger-ink);
	}

	/* States what is behind the door, so it does not have to be opened to be read. */
	.disclose-now {
		margin-left: auto;
		font-size: var(--ph-text-xs);
		font-weight: 600;
		color: var(--ink-dim);
	}
	.check {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		min-height: var(--tap);
		font-size: var(--ph-text-md);
	}

	/* Position only, on a wrapper: Tailwind mints nothing for app source, and scoped CSS cannot reach inside a component.
	   It holds this pane's ONE accent control — commit-and-close while an edit is pending, the plain exit when none is
	   — which is why the You panel carries no second footer button the way Party and Server do.
	   THE SAME RUNG AS THE TWO INTER-GROUP MARGINS ABOVE, and for the same reason: this is a card-content child too,
	   so what the guest sees is 8 + 12 = 20px, and a commit control is an inter-group boundary, not a section one.
	   It was `xl` until app.css retired that rung, which would now render 22px against those two at 20px. */
	.save-slot {
		margin-top: var(--space-lg);
	}
</style>
