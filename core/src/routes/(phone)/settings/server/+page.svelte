<!-- THE MACHINE SCOPE: model weights, binaries, credentials and hardware capability — everything whose cost is paid
	once per server and felt in every room on it. Its one door is the link at the foot of the room scope; the room's
	Quality cap, in the Sound section there, is capped by these defaults. docs/FRONTEND.md#settings -->
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { untrack } from 'svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { resolve } from '$app/paths';
	import SettingsScope from '$lib/ui/SettingsScope.svelte';
	import SelectField from '$lib/ui/SelectField.svelte';
	import { SETTINGS_SCOPES } from '$lib/settings-scopes';
	import { isUnreachableJoinOrigin } from '$lib/tv/screen';
	import { UNREACHABLE_JOIN, joinAddressLabel } from '$lib/tv/join-address';
	import { createSettingsWrites } from '$lib/settings-writes.svelte';
	import { Input } from '$lib/components/ui/input';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Switch } from '$lib/components/ui/switch';
	import FieldSlider from '$lib/ui/FieldSlider.svelte';
	import * as Field from '$lib/components/ui/field';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import type { OfferedModel } from '$lib/contract';
	import {
		SEPARATOR_ENGINES,
		ASR_MODELS,
		// Every id-to-record lookup goes through these accessors, never a hand-rolled `.find`, so the registry owns the shape.
		getAsrModel,
		getEngine,
		SYNC_MODES,
		qualityRank,
		normalizeJoinOrigin,
		PROCESSES_UNCAPPED,
		MAX_PROCESSES_PER_SINGER_CEILING,
		FETCHERS,
		type EffectiveSettings,
		type FetcherId,
		type GlobalSettings,
		type SeparatorEngineId
	} from '$lib/contract';

	interface Props {
		data: {
			settings: EffectiveSettings;
			/** What an empty join address resolves to — env var, else the address this page was opened at
			 *  (its home-network address when that is loopback). */
			joinOriginFallback: string;
			/** This box's home-network addresses, best first. Absent on an older server. */
			joinCandidates?: string[];
			/** Whether this phone reached the server over https. Only the server can answer this. */
			requestIsHttps: boolean;
			/**
			 * Separation models the CONNECTED WORKERS reported they can run, best upstream score first.
			 *
			 * Absent on an older server and empty until a worker's `worker:catalogue` frame lands, so every
			 * reader must fall back to the built-in engine lists rather than showing an empty picker.
			 */
			offeredModels?: OfferedModel[];
			/** Null for the host; anyone else reads this scope without moving it. */
			locked: { hostLink: string } | null;
		};
	}
	let { data }: Props = $props();

	/* The optimistic write and its per-field rollback live in $lib/settings-writes.svelte.ts, because the room scope
	   performs the same one. `settings` is aliased so every control below reads the name it always read. */
	const writes = createSettingsWrites(() => data.settings);
	const { onglobal, liveGlobal } = writes;
	const settings = $derived(writes.settings);

	// PROCESSES_UNCAPPED is 0, and a bare 0 beside this label reads as a missing value — say it in words.
	const processCapLabel = $derived(
		settings.global.maxProcessesPerSinger === PROCESSES_UNCAPPED
			? 'no limit'
			: String(settings.global.maxProcessesPerSinger)
	);

	let advancedOpen = $state(false);

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
	// The address IN EFFECT, by the TV's own test, so this page says what the TV's empty-room screens say. The stage
	// never shows it, so for a party that starts with a song queued this line is where the host learns it.
	// shortcut: an empty setting resolves against THIS page's host, so a phone on the LAN reads reachable while a TV
	// opened at localhost does not; upgrade if hosts report the TV warning with no line here.
	const joinUnreachable = $derived(isUnreachableJoinOrigin(settings.global.joinOrigin || data.joinOriginFallback));

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

	// The stored address is not offered again: a "Use" that changes nothing is a dead tap.
	// A `<wbr>` after the fallback's `http://` gives a narrow card a break there, so it never splits the port.
	const fallbackScheme = $derived(/^https?:\/\//.exec(data.joinOriginFallback)?.[0] ?? '');
	const joinChoices = $derived((data.joinCandidates ?? []).filter((c) => c !== settings.global.joinOrigin));
	function useJoinOrigin(origin: string) {
		joinDraft = origin;
		commitJoinOrigin();
	}
</script>

<!-- Back to the room scope, which holds this page's one door. -->
<SettingsScope
	scope={SETTINGS_SCOPES.server}
	back={{ href: SETTINGS_SCOPES.room.href, label: 'Back to the party settings' }}
	failed={writes.failed}
	locked={data.locked}
>
	<!-- FLAT SECTIONS (#1159), drawn by the shell's row rules, as on the party scope. A picker row wraps its select
		onto its own line when a long value does not fit beside the name, so no label is cut. -->
	<section class="settings-section" id="karaoke" aria-labelledby="karaoke-h">
		<h2 class="grouphead" id="karaoke-h">Making karaoke</h2>
		<div class="rows">
			<div class="pick">
				<SelectField
					id="engine"
					label="Stem splitter"
					value={settings.global.defaultEngine}
					options={liveEngines}
					pick={(v) => pickEngine('default', v)}
				/>
			</div>

			<div class="pick">
				<SelectField
					id="model"
					label="Model"
					value={settings.global.defaultModel}
					options={liveModelChoices}
					pick={(v) => onglobal({ defaultModel: v })}
				/>
				{#if liveSlow}
					<p class="warn">~45 minutes per song on CPU.</p>
				{/if}
			</div>

			<div class="pick">
				<SelectField
					id="fetcher"
					label="Audio source"
					value={settings.global.defaultFetcher}
					options={defaultFetchers}
					pick={(v) => onglobal({ defaultFetcher: v as FetcherId })}
				/>
			</div>

			<!-- A slider, not a number field: the range is short and bounded at both ends, and a text field would invite the
					3000 that `normalizeMaxProcesses` exists to refuse. -->
			<div class="stack">
				<Field.Label for="max-processes">
					<!-- The hidden colon keeps a screen reader from running the name into its value ("at once 3"). -->
					<span>Songs one singer can make at once</span><span class="vh">: </span><span class="value"
						>{processCapLabel}</span
					>
				</Field.Label>
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
					A guest can start this many karaoke jobs at a time; finished songs free a slot straight away. Nothing stops
					one phone tapping Sing down a whole page of results, and each tap is a 1–2 minute job for your workers.
				</Field.Description>
			</div>
		</div>
	</section>

	<section class="settings-section" id="lyrics-engine" aria-labelledby="lyrics-engine-h">
		<h2 class="grouphead" id="lyrics-engine-h">Lyrics engine</h2>
		<div class="rows">
			<div class="pick">
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
			</div>

			<div class="pick">
				<SelectField
					id="sync-mode"
					label="Lyric timing"
					value={settings.global.syncMode}
					options={SYNC_MODES}
					pick={(v) => onglobal({ syncMode: v as GlobalSettings['syncMode'] })}
				/>
			</div>
		</div>
	</section>

	<section class="settings-section" id="joining" aria-labelledby="joining-h">
		<h2 class="grouphead" id="joining-h">Joining</h2>
		<div class="rows">
			{#if joinChoices.length}
				<div class="choices">
					{#each joinChoices as origin (origin)}
						<Button variant="outline" size="tap" onclick={() => useJoinOrigin(origin)}
							>Use {joinAddressLabel(origin)}</Button
						>
					{/each}
				</div>
			{/if}
			<div class="stack">
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
					>Empty means <strong>{fallbackScheme}<wbr />{data.joinOriginFallback.slice(fallbackScheme.length)}</strong
					>.</Field.Description
				>
				{#if joinError}<p class="err" role="alert">{joinError}</p>{/if}
				{#if joinUnreachable}
					<p class="warn">{UNREACHABLE_JOIN}</p>
				{/if}
				{#if joinSchemeMismatch}
					<p class="warn">This party runs over plain http — phones cannot open an https address.</p>
				{/if}
			</div>
		</div>
	</section>

	<!-- The disclosure stays: the upgrade chain is the rarest thing on the rarest scope. Its content is a plain <div>,
		so the UA's `[hidden] { display: none }` closes it; nothing on it sets a `display` that would out-rank that. -->
	<section class="settings-section" id="reprocessing" aria-labelledby="reprocessing-h">
		<h2 class="grouphead" id="reprocessing-h">Re-processing</h2>
		<!-- Collapsible owns aria-expanded, aria-controls and the toggle; the <button> stays here through the `child`
				snippet so this file's scoped CSS can reach it. -->
		<Collapsible.Root class="rows" bind:open={advancedOpen}>
			<Collapsible.Trigger>
				{#snippet child({ props })}
					<!-- In a row of its own, so the row's padding never reaches the button's. -->
					<div>
						<Button variant="ghost" size="block" {...props}>
							<Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} />
							Advanced
							<span class="disclose-now">
								{settings.global.enqueueUpgrade ? 'Re-process on' : 'Re-process off'}
							</span>
						</Button>
					</div>
				{/snippet}
			</Collapsible.Trigger>

			<Collapsible.Content>
				{#snippet child({ props })}
					<!-- NO `id` here. bits-ui's Collapsible.Content defaults `id = createId(uid)` and passes it
							 through `{...props}`, which spreads AFTER any literal and wins — so an `id` written here is
							 silently dropped. Do not "fix" that by moving the literal after the spread either: the
							 Trigger's `aria-controls` names bits-ui's generated id, so overriding it would point the
							 control at an element that no longer carries that id. -->
					<div class="rows" {...props}>
						<label class="check" for="enqueue-upgrade">
							Re-process at higher quality, from the saved audio
							<Switch
								id="enqueue-upgrade"
								checked={settings.global.enqueueUpgrade}
								onCheckedChange={(v) => onglobal({ enqueueUpgrade: v })}
							/>
						</label>

						<div class="pick">
							<SelectField
								id="upgrade-engine"
								label="Upgrade splitter"
								value={settings.global.upgradeEngine}
								options={SEPARATOR_ENGINES}
								pick={(v) => pickEngine('upgrade', v)}
							/>
						</div>

						<div class="pick">
							<SelectField
								id="upgrade-model"
								label="Upgrade model"
								value={settings.global.upgradeModel}
								options={upgradeModelChoices}
								pick={(v) => onglobal({ upgradeModel: v })}
							/>
							{#if settings.global.enqueueUpgrade && !upgradeIsBetter}
								<p class="warn">Not better than the splitter above, so nothing will re-process.</p>
							{/if}
						</div>
					</div>
				{/snippet}
			</Collapsible.Content>
		</Collapsible.Root>
	</section>

	<!-- /metrics is ungated, so this is its ONLY link: from the remote or the TV it would advertise worker ids, model
			names, host details and error strings to every device in the room. A door, as the party scope's are. -->
	<div class="rows">
		<a class="door" href={resolve('/metrics')}>
			<Icon name="clock" /><span>Processing metrics <Badge variant="neutral">internal</Badge></span>
			<Icon name="chevron-right" />
		</a>
	</div>
</SettingsScope>

<style>
	/* The row shapes, `.warn` and `.value` are the shell's (`SettingsScope.svelte`).
	   --danger-ink, because --warn is the transient self-healing tone the four advisories above already wear
	   ("~45 minutes per song on CPU"): a rejected join address was painted that same amber, so a host could not tell a
	   hint from the one thing they had to act on. Four is this FILE's count — the surface holds six, the room scope
	   carrying the other two, which is the figure docs/FRONTEND.md#settings quotes. This is the ink the rest of the
	   app spends on a failure —
	   `.err[role=alert]` on the join screen, the destructive Alert at the top of this scope — and the box is `.warn`'s
	   to the pixel, so swapping the class moves nothing. */
	.err {
		margin: var(--space-xs) 0 0;
		font-size: var(--ph-text-xs);
		color: var(--danger-ink);
	}

	/* The one-tap join addresses, above the field they fill. Wraps, so two long IPs fold at 320px. */
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
	/* A DESCRIPTION MAY HOLD AN UNBREAKABLE TOKEN, and one does: the Joining hint prints the join address. `anywhere` and
	   not `break-word`, because `anywhere` reduces the element's MIN-CONTENT width, which `.panel`'s `1fr` track takes its
	   minimum from: at 320px with the root font-size doubled (SC 1.4.10) the address would scroll the page sideways. */
	.stack :global([data-slot='field-description']) {
		overflow-wrap: anywhere;
	}

	/* States what is behind the door, so it does not have to be opened to be read. */
	.disclose-now {
		margin-left: auto;
		font-size: var(--ph-text-xs);
		font-weight: 600;
		color: var(--ink-dim);
	}
</style>
