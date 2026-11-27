<!-- THE ROOM SCOPE. `/settings` IS this scope rather than an index over the three: the gear in the Sing tab's topbar
	is the one door a host taps mid-party, and an index would spend a tap teaching a model that each destination's own
	heading states on arrival. Everything here is written to `room_settings` and reaches everyone in this room.
	docs/FRONTEND.md#settings -->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge } from '$lib/components/ui/badge';
	import Icon from '$lib/ui/Icon.svelte';
	import SettingsScope from '$lib/ui/SettingsScope.svelte';
	import SelectField from '$lib/ui/SelectField.svelte';
	import { SETTINGS_SCOPES } from '$lib/settings-scopes';
	import { createSettingsWrites } from '$lib/settings-writes.svelte';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Switch } from '$lib/components/ui/switch';
	import FieldSlider from '$lib/ui/FieldSlider.svelte';
	import * as Field from '$lib/components/ui/field';
	import {
		SEPARATOR_ENGINES,
		TV_PROGRESS_STYLES,
		TV_BACKGROUND_STYLES,
		TV_VISUALIZERS,
		// Every id-to-record lookup goes through these accessors, never a hand-rolled `.find`, so the registry owns the shape.
		getLyricsHighlight,
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
		resolveLyricsPresentation,
		MIN_SONG_INTRO_MS,
		MAX_SONG_INTRO_MS,
		SONG_INTRO_STEP_MS,
		MIN_PRESENCE_GRACE_MINUTES,
		MAX_PRESENCE_GRACE_MINUTES,
		QUEUE_ORDERS,
		type EffectiveSettings,
		type LyricsBallStyleId,
		type LyricsCaseId,
		type LyricsFontId,
		type LyricsHighlightId,
		type QueueOrderId,
		type TvProgressStyle,
		type TvBackgroundStyle,
		type TvVisualizerId
	} from '$lib/contract';

	interface Props {
		data: {
			settings: EffectiveSettings;
			/** Null for the host; anyone else reads this scope without moving it. */
			locked: { hostLink: string } | null;
		};
	}
	let { data }: Props = $props();

	/* The optimistic write and its per-field rollback live in $lib/settings-writes.svelte.ts, because the machine scope
	   performs the same one. `settings` is aliased so every control below reads the name it always read. */
	const writes = createSettingsWrites(() => data.settings);
	const { onroom, liveRoom } = writes;
	const settings = $derived(writes.settings);

	// Minutes read badly past an hour ("120 minutes"), and 0 is a sentinel here.
	const graceLabel = $derived.by(() => {
		const minutes = settings.room.presenceGraceMinutes;
		if (minutes === 0) return 'no grace';
		if (minutes < 60) return `${minutes} min`;
		const hours = Math.floor(minutes / 60);
		const rest = minutes % 60;
		return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
	});

	// Upgrade-only engines are excluded: offering one here lets a singer pick what the server rejects.
	const liveEngines = SEPARATOR_ENGINES.filter((e) => e.liveSelectable);

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

	/* A cap at or above the default changes nothing, and the copy must say so rather than imply it raised quality. The
	   default it is compared against is a MACHINE setting — it is the one room control whose meaning is relative to
	   one on another page, so this line is where that relation is read. */
	const defaultRank = $derived(qualityRank(settings.global.defaultEngine, settings.global.defaultModel));
	const capAboveDefault = $derived(
		settings.room.maxQualityRank !== null && settings.room.maxQualityRank >= defaultRank
	);

	// Ask the SAME resolver the TV asks, never re-test syncMode here: a second opinion would make this page confidently
	// wrong about what is on screen.
	const resolved = $derived(resolveLyricsPresentation(settings));
	const lyricsClamped = $derived(resolved.clamped);
	const resolvedHighlight = $derived(getLyricsHighlight(resolved.highlight)?.label.toLowerCase() ?? resolved.highlight);
	const resolvedBall = $derived(resolved.ball !== 'off');
</script>

<!-- Back to the Sing tab, which holds this scope's one door: the gear in its topbar. -->
<SettingsScope
	scope={SETTINGS_SCOPES.room}
	back={{ href: '/', label: 'Back to the remote' }}
	failed={writes.failed}
	locked={data.locked}
>
	<!-- FLAT SECTIONS ON THE GROUND (#1159, option A), drawn by the shell's row rules. Level 2 because PageHeader owns
		the single h1. -->
	<!-- FIRST, for the host only (proposal 39): the one check before guests arrive, so it is this screen's one lit
		surface, drawn in the idle Spotlight look. A link, so it cannot be a <Spotlight> section. -->
	{#if !data.locked}
		<a class="ready spot" href={resolve('/settings/ready')}>
			<span><strong>Ready for tonight</strong><small>The one check before guests arrive</small></span>
			<Icon name="chevron-right" />
		</a>
	{/if}

	<section class="settings-section" id="rotation" aria-labelledby="rotation-h">
		<h2 class="grouphead" id="rotation-h">Turns</h2>
		<div class="rows">
			<!-- FIRST, because this is the one room setting changed mid-song: four code sites say so, `queue-order.ts`'s
				"safe to select mid-party" among them. -->
			<div class="pick">
				<SelectField
					id="queue-order"
					label="Who sings next"
					value={settings.room.queueOrder}
					options={QUEUE_ORDERS}
					pick={(v) => onroom({ queueOrder: v as QueueOrderId })}
				/>
			</div>

			<div class="stack">
				<Field.Label for="presence-grace">
					<span>Skip a quiet phone after</span><span class="value">{graceLabel}</span>
				</Field.Label>
				<FieldSlider
					id="presence-grace"
					label="Skip a quiet phone after"
					type="single"
					min={MIN_PRESENCE_GRACE_MINUTES}
					max={MAX_PRESENCE_GRACE_MINUTES}
					step={15}
					value={settings.room.presenceGraceMinutes}
					onValueChange={(v) => liveRoom('presenceGraceMinutes', v)}
					onValueCommit={(v) => onroom({ presenceGraceMinutes: v })}
				/>
			</div>
		</div>
	</section>

	<!-- SECOND, up from last on the old Party panel, and the reason is a documented label collision rather than taste:
		`GuidingTrack.svelte` records that this room DEFAULT and /queue's per-turn override wear the same label in the
		same register, so it is the control most likely to be mis-scoped — and it was the deepest control on the
		deepest panel, 1025.8px of scrolling from the top. It is on the first screen now. -->
	<section class="settings-section" id="sound" aria-labelledby="sound-h">
		<h2 class="grouphead" id="sound-h">Sound</h2>
		<div class="rows">
			<div class="stack">
				<Field.Label for="guide-default">
					<span>Guide</span><span class="value">{Math.round(settings.room.guideLevelDefault * 100)}%</span>
				</Field.Label>
				<FieldSlider
					id="guide-default"
					label="Default guide level for the room"
					type="single"
					min={0}
					max={100}
					step={1}
					value={Math.round(settings.room.guideLevelDefault * 100)}
					onValueChange={(v) => liveRoom('guideLevelDefault', v / 100)}
					onValueCommit={(v) => onroom({ guideLevelDefault: v / 100 })}
				/>
			</div>

			<label class="check" for="loudness-norm">
				Match song loudness
				<Switch
					id="loudness-norm"
					checked={settings.room.loudnessNormalization}
					onCheckedChange={(v) => onroom({ loudnessNormalization: v })}
				/>
			</label>

			<!-- LAST IN SOUND, because it is how the music is made, not how loud: two sections cannot both be "Sound".
				`capAboveDefault`'s line below carries the cross-scope relation to the machine scope. -->
			<div class="pick">
				<Field.Label for="quality-ceiling">Quality</Field.Label>
				<!-- The option VALUE is a `qualityRank`, and the empty option is null = no cap. -->
				<NativeSelect
					id="quality-ceiling"
					value={settings.room.maxQualityRank ?? ''}
					onchange={(e) =>
						onroom({
							maxQualityRank: e.currentTarget.value === '' ? null : Number(e.currentTarget.value)
						})}
				>
					<option value="">Best available</option>
					{#each qualityCeilings as c (c.rank)}
						<option value={c.rank}>Up to {c.label}</option>
					{/each}
				</NativeSelect>

				{#if capAboveDefault}
					<p class="warn">At or above the server default, so it changes nothing.</p>
				{/if}
			</div>
		</div>
	</section>

	<section class="settings-section" id="tv" aria-labelledby="tv-h">
		<h2 class="grouphead" id="tv-h">The TV</h2>
		<div class="rows">
			<div class="pick">
				<SelectField
					id="tv-background"
					label="Background"
					value={settings.room.tvBackgroundStyle}
					options={TV_BACKGROUND_STYLES}
					pick={(v) => onroom({ tvBackgroundStyle: v as TvBackgroundStyle })}
				/>
			</div>

			<!-- Gated, not disabled: a control that does nothing for the current selection implies it does. -->
			{#if settings.room.tvBackgroundStyle === 'visualizer'}
				<div class="pick">
					<SelectField
						id="tv-visualizer"
						label="Which visualizer"
						value={settings.room.tvVisualizer}
						options={TV_VISUALIZERS}
						pick={(v) => onroom({ tvVisualizer: v as TvVisualizerId })}
					/>
				</div>
			{/if}

			<!-- The colour is BOTH the `solid` stage and the visualizer's palette, so it reveals for either. -->
			{#if settings.room.tvBackgroundStyle === 'solid' || settings.room.tvBackgroundStyle === 'visualizer'}
				<div class="stack">
					<!-- Swatch and input both render the STORED string, so the phone cannot promise a colour the TV renders
						differently. It arrives as a custom property, never interpolated into `background:`. -->
					<Field.Label data-inline for="tv-background-color">
						Background colour
						<span class="swatch" style="--swatch:{settings.room.tvBackgroundColor}" aria-hidden="true"></span>
					</Field.Label>
					<!-- oninput/onchange split as every slider here does: the native picker fires `input` continuously, so the
						swatch tracks live while only `change` writes and broadcasts. -->
					<input
						id="tv-background-color"
						class="colour"
						type="color"
						value={settings.room.tvBackgroundColor}
						oninput={(e) => liveRoom('tvBackgroundColor', e.currentTarget.value)}
						onchange={(e) => onroom({ tvBackgroundColor: e.currentTarget.value })}
					/>
				</div>

				<div class="stack">
					<Field.Label for="tv-background-dim">
						<span>Darken the stage</span><span class="value">{Math.round(settings.room.tvBackgroundDim * 100)}%</span>
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
				</div>
			{/if}

			<div class="pick">
				<SelectField
					id="tv-progress"
					label="Song progress"
					value={settings.room.tvProgressStyle}
					options={TV_PROGRESS_STYLES}
					pick={(v) => onroom({ tvProgressStyle: v as TvProgressStyle })}
				/>
			</div>

			<label class="check" for="tv-reactions">
				Reactions on TV
				<Switch
					id="tv-reactions"
					checked={settings.room.tvReactions}
					onCheckedChange={(v) => onroom({ tvReactions: v })}
				/>
			</label>

			<label class="check" for="tv-chorus">
				Show the chorus to the room
				<Switch id="tv-chorus" checked={settings.room.tvChorus} onCheckedChange={(v) => onroom({ tvChorus: v })} />
			</label>

			<label class="check" for="song-intro-on">
				Song intro before each turn
				<Switch
					id="song-intro-on"
					checked={settings.room.songIntroEnabled}
					onCheckedChange={(v) => onroom({ songIntroEnabled: v })}
				/>
			</label>

			<div class="stack">
				<Field.Label data-dim={!settings.room.songIntroEnabled || undefined} for="song-intro-ms">
					<span>Song intro duration</span><span class="value">{(settings.room.songIntroMs / 1000).toFixed(1)}s</span>
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
			</div>
		</div>
	</section>

	<!-- The TV's second half, so it stays directly after it. The tallest section on this scope. -->
	<section class="settings-section" id="lyrics" aria-labelledby="lyrics-h">
		<h2 class="grouphead" id="lyrics-h">Lyrics on the TV</h2>
		<div class="rows">
			<div class="pick">
				<SelectField
					id="lyrics-highlight"
					label="Highlight"
					value={settings.room.lyricsHighlight}
					options={LYRICS_HIGHLIGHTS}
					pick={(v) => onroom({ lyricsHighlight: v as LyricsHighlightId })}
				/>
			</div>
			<div class="pick">
				<SelectField
					id="lyrics-ball"
					label="Marker"
					value={settings.room.lyricsBall}
					options={LYRICS_BALL_STYLES}
					pick={(v) => onroom({ lyricsBall: v as LyricsBallStyleId })}
				/>
				<!-- Say when a choice is not honoured: under line-only timing a word treatment has nothing to light, and a
					picker that silently does nothing is worse than one that explains itself. -->
				{#if lyricsClamped}
					<p class="warn">
						No word timings on this server, so it shows <strong>{resolvedHighlight}</strong>{resolvedBall
							? ''
							: ' with no marker'}.
					</p>
				{/if}
			</div>
			<div class="pick">
				<SelectField
					id="lyrics-font"
					label="Font"
					value={settings.room.lyricsFont}
					options={LYRICS_FONTS}
					pick={(v) => onroom({ lyricsFont: v as LyricsFontId })}
				/>
			</div>
			<div class="pick">
				<SelectField
					id="lyrics-case"
					label="Letter case"
					value={settings.room.lyricsCase}
					options={LYRICS_CASES}
					pick={(v) => onroom({ lyricsCase: v as LyricsCaseId })}
				/>
			</div>

			<div class="stack">
				<Field.Label for="lyrics-scale">
					<span>Lyric size</span><span class="value" data-wrap>{settings.room.lyricsScalePct}% of the TV's default</span
					>
				</Field.Label>
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
			</div>

			<div class="stack">
				<Field.Label for="lyrics-lead">
					<span>Highlight runs ahead</span><span class="value">{(settings.room.lyricsLeadMs / 1000).toFixed(2)}s</span>
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
			</div>

			<div class="stack">
				<Field.Label for="lyrics-before">
					<span>Lines behind</span><span class="value">{settings.room.lyricsLinesBefore}</span>
				</Field.Label>
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
			<div class="stack">
				<Field.Label for="lyrics-after">
					<span>Lines ahead</span><span class="value">{settings.room.lyricsLinesAfter}</span>
				</Field.Label>
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
	</section>

	<!-- THE DOORS, one hairline list rather than four outlined buttons. Each names a place, and its scope is stated on
		arrival in the destination's sticky scope line, so only /stats carries a chip: it is the GUEST dashboard, the one
		safe to show any phone. Every settings scope must reach the others, so the machine and You doors both stay. -->
	<div class="rows doors">
		<a class="door" href={resolve('/stats')}>
			<Icon name="sparkle" /><span>Party stats <Badge variant="neutral">safe to share</Badge></span>
			<Icon name="chevron-right" />
		</a>
		<a class="door" href={resolve(SETTINGS_SCOPES.server.href)}>
			<Icon name="gear" /><span>{SETTINGS_SCOPES.server.label}</span><Icon name="chevron-right" />
		</a>
		<!-- The host's door to every /tv open in this room (proposal 34). A guest has no use for it, so it is not shown. -->
		{#if !data.locked}
			<a class="door" href={resolve('/settings/screens')}>
				<Icon name="play" /><span>Screens</span><Icon name="chevron-right" />
			</a>
		{/if}
		<a class="door" href={resolve(SETTINGS_SCOPES.you.href)}>
			<Icon name="mic" /><span>{SETTINGS_SCOPES.you.label}</span><Icon name="chevron-right" />
		</a>
	</div>
</SettingsScope>

<!-- No <style>: every rule this scope draws with is the shell's (`SettingsScope.svelte`), one sheet rather than two. -->
