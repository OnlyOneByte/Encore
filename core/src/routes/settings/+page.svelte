<!-- THE ROOM SCOPE. `/settings` IS this scope rather than an index over the three: the gear in the Sing tab's topbar
	is the one door a host taps mid-party, and an index would spend a tap teaching a model that each destination's own
	heading states on arrival. Everything here is written to `room_settings` and reaches everyone in this room.
	docs/FRONTEND.md#settings -->
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import Icon from '$lib/ui/Icon.svelte';
	import SettingsScope from '$lib/ui/SettingsScope.svelte';
	import SelectField from '$lib/ui/SelectField.svelte';
	import { SETTINGS_SCOPES } from '$lib/settings-scopes';
	import { createSettingsWrites } from '$lib/settings-writes.svelte';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Switch } from '$lib/components/ui/switch';
	import FieldSlider from '$lib/ui/FieldSlider.svelte';
	import * as Card from '$lib/components/ui/card';
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
	<!-- `Card.Title` renders a <div>, so every styled card title here was a visual heading with no heading SEMANTICS,
		and the whole outline was its h1. Screen-reader users navigate a long dashboard by heading, so
		`role="heading" aria-level={2}` is added at each call site rather than re-vendoring the primitive, which
		forwards restProps for exactly this. Level 2 because PageHeader owns the single h1.
		NO per-card scope mark here: every card on this page reaches the same room, and the sticky header already says
		"Everyone in this room", so a mark on each card was the same line five times. -->
	<Card.Root id="rotation">
		<Card.Header>
			<Card.Title role="heading" aria-level={2}>Turns</Card.Title>
		</Card.Header>
		<Card.Content>
			<!-- FIRST, because this is the one room setting changed mid-song: four code sites say so, `queue-order.ts`'s
				"safe to select mid-party" among them. -->
			<SelectField
				id="queue-order"
				label="Who sings next"
				value={settings.room.queueOrder}
				options={QUEUE_ORDERS}
				pick={(v) => onroom({ queueOrder: v as QueueOrderId })}
			/>

			<Field.Label for="presence-grace">
				Skip a quiet phone after <span class="value">· {graceLabel}</span>
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
		</Card.Content>
	</Card.Root>

	<!-- SECOND, up from last on the old Party panel, and the reason is a documented label collision rather than taste:
		`GuidingTrack.svelte` records that this room DEFAULT and /queue's per-turn override wear the same label in the
		same register, so it is the control most likely to be mis-scoped — and it was the deepest control on the
		deepest panel, 1025.8px of scrolling from the top. It is on the first screen now. -->
	<Card.Root id="sound">
		<Card.Header>
			<Card.Title role="heading" aria-level={2}>Sound</Card.Title>
		</Card.Header>
		<Card.Content>
			<Field.Label for="guide-default">
				Guide · {Math.round(settings.room.guideLevelDefault * 100)}%
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

			<label class="check" for="loudness-norm">
				<Switch
					id="loudness-norm"
					checked={settings.room.loudnessNormalization}
					onCheckedChange={(v) => onroom({ loudnessNormalization: v })}
				/>
				Match song loudness
			</label>

			<!-- LAST IN SOUND, because it is how the music is made, not how loud: it was its own card titled "Sound
				quality" beside the machine door, and two cards cannot both be "Sound". It no longer sits above that door,
				so `capAboveDefault`'s line below is what carries the cross-scope relation now. -->
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
		</Card.Content>
	</Card.Root>

	<Card.Root id="tv">
		<Card.Header>
			<Card.Title role="heading" aria-level={2}>The TV</Card.Title>
		</Card.Header>
		<Card.Content>
			<div class="pair">
				<div class="cell">
					<SelectField
						id="tv-background"
						label="Background"
						value={settings.room.tvBackgroundStyle}
						options={TV_BACKGROUND_STYLES}
						pick={(v) => onroom({ tvBackgroundStyle: v as TvBackgroundStyle })}
					/>
				</div>
				<div class="cell">
					<SelectField
						id="tv-progress"
						label="Song progress"
						value={settings.room.tvProgressStyle}
						options={TV_PROGRESS_STYLES}
						pick={(v) => onroom({ tvProgressStyle: v as TvProgressStyle })}
					/>
				</div>
			</div>

			<!-- Gated, not disabled: a control that does nothing for the current selection implies it does. -->
			{#if settings.room.tvBackgroundStyle === 'visualizer'}
				<SelectField
					id="tv-visualizer"
					label="Which visualizer"
					value={settings.room.tvVisualizer}
					options={TV_VISUALIZERS}
					pick={(v) => onroom({ tvVisualizer: v as TvVisualizerId })}
				/>
			{/if}

			<!-- The colour is BOTH the `solid` stage and the visualizer's palette, so it reveals for either. -->
			{#if settings.room.tvBackgroundStyle === 'solid' || settings.room.tvBackgroundStyle === 'visualizer'}
				<!-- Swatch and input both render the STORED string, so the phone cannot promise a colour the TV renders
						differently. It arrives as a custom property, never interpolated into
						`background:`. -->
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

			<label class="check" for="tv-reactions">
				<Switch
					id="tv-reactions"
					checked={settings.room.tvReactions}
					onCheckedChange={(v) => onroom({ tvReactions: v })}
				/>
				Reactions on TV
			</label>

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

	<!-- The TV's second half, so it stays directly after it. The tallest card on this scope. -->
	<Card.Root id="lyrics">
		<Card.Header>
			<Card.Title role="heading" aria-level={2}>Lyrics on the TV</Card.Title>
		</Card.Header>
		<Card.Content>
			<div class="pair">
				<div class="cell">
					<SelectField
						id="lyrics-highlight"
						label="Highlight"
						value={settings.room.lyricsHighlight}
						options={LYRICS_HIGHLIGHTS}
						pick={(v) => onroom({ lyricsHighlight: v as LyricsHighlightId })}
					/>
				</div>
				<div class="cell">
					<SelectField
						id="lyrics-ball"
						label="Marker"
						value={settings.room.lyricsBall}
						options={LYRICS_BALL_STYLES}
						pick={(v) => onroom({ lyricsBall: v as LyricsBallStyleId })}
					/>
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
					<SelectField
						id="lyrics-font"
						label="Font"
						value={settings.room.lyricsFont}
						options={LYRICS_FONTS}
						pick={(v) => onroom({ lyricsFont: v as LyricsFontId })}
					/>
				</div>
				<div class="cell">
					<SelectField
						id="lyrics-case"
						label="Letter case"
						value={settings.room.lyricsCase}
						options={LYRICS_CASES}
						pick={(v) => onroom({ lyricsCase: v as LyricsCaseId })}
					/>
				</div>
			</div>

			<Field.Label for="lyrics-scale">Lyric size · {settings.room.lyricsScalePct}% of the TV's default</Field.Label>
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

	<!-- /stats is the GUEST dashboard, so it is the one safe to reach from any phone's surface. -->
	<Button variant="outline" size="block" href="/stats">
		<Icon name="sparkle" />
		Party stats <Badge variant="neutral">safe to share</Badge>
	</Button>

	<!-- THE ONE DOOR INTO THE MACHINE SCOPE, so that page's back arrow has a single real destination to name.
		NO BADGE: a second chip on this row read `every room`, and p15 caught it overflowing the 320px column by 9px
		at 200% text (the chip measures 135.5px there). The row does not need one either: the blast radius is stated
		on arrival, in the destination's own sticky scope line, so this row only has to name the place. -->
	<Button variant="outline" size="block" href={SETTINGS_SCOPES.server.href}>
		<Icon name="gear" />
		{SETTINGS_SCOPES.server.label}
	</Button>

	<!-- The host's door to every /tv open in this room (proposal 34). A guest has no use for it, so it is not shown. -->
	{#if !data.locked}
		<Button variant="outline" size="block" href="/settings/screens">Screens</Button>
	{/if}

	<!-- THE DOOR TO THE "YOU" SCOPE, and it was MISSING — the scope rebuild split one page into three routes and
		wired only two of the three together. The machine scope had its door (above) and /stats had its own, but a host
		standing on the room scope had no path to their own name and colour at all: `/settings/you` was reachable only
		from the Sing tab's identity chip, so the way to it was to leave settings entirely and come back in by another
		entrance. A three-scope model whose scopes cannot reach each other is a worse map than the tab strip it
		replaced.
		SAME `outline` + `size="block"` SHAPE as the machine door, and NO BADGE for the reasons recorded on that one:
		a door row names a place, and its scope is stated on arrival. -->
	<Button variant="outline" size="block" href={SETTINGS_SCOPES.you.href}>
		<Icon name="mic" />
		{SETTINGS_SCOPES.you.label}
	</Button>
</SettingsScope>

<style>
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
	/* ADVISORY ONLY — a cost or a no-op, never a failure. A REFUSAL takes `--danger-ink`, and this scope raises none:
	   its one failure mode is a refused write, which the shell states in one destructive Alert at the top of the
	   column. The You and machine scopes, which DO refuse a draft in place, carry the `.err` rule for it. */
	.warn {
		margin: var(--space-xs) 0 0;
		font-size: var(--ph-text-xs);
		color: var(--warn);
	}
	.check {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		min-height: var(--tap);
		font-size: var(--ph-text-md);
	}
	/* A label's value breaks as ONE piece, with its separator: at 320 `Skip a quiet phone after · 1 hr 30 min` split
	   inside the value, and then left the `·` alone at the end of the first line. */
	.value {
		white-space: nowrap;
	}
</style>
