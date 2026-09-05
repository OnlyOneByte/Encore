/*
 * THE E2E SELECTOR CONTRACT.
 *
 * One declaration of every hook the browser flow drives, imported by BOTH the flow (party.mjs) and the
 * guard (contract.test.ts) so the two can never disagree about what the UI looks like.
 *
 * WHY THIS EXISTS. The previous e2e was a detached script, and it rotted silently: it clicked a
 * `Library` tab that was deleted when search was unified around readiness, selected a colour by an
 * aria-label of `color #ff5cae` when the real label had become `violet swatch`, and read rows from
 * `.result` after the component started rendering `.row`. Three separate selector families had moved
 * and the suite stayed green the whole time, because nothing in `bun test` ever looked at the script.
 *
 * The guard is the load-bearing half. It needs no browser, so it runs everywhere `bun test` runs, on
 * every change, and it fails the moment a selector's anchor disappears from the source. The browser
 * flow proves the app actually works; the guard proves the flow is still aimed at the app.
 *
 * Each entry names the source it must exist in, so a failure says which file moved the ground.
 */

/** A hook the e2e drives, plus the source anchor proving it still exists. */
export interface Hook {
	/** What the flow calls it. */
	id: string;
	/** Source file, relative to apps/core. */
	file: string;
	/** Substring that must appear in that file. The anchor. */
	anchor: string;
	/** Why the flow needs it — so a failure explains what breaks, not just that something moved. */
	why: string;
}

/** How the flow addresses each hook at runtime. */
export const SEL = {
	// ── join ──────────────────────────────────────────────────────────────
	nameInput: 'input[placeholder^="e.g."]',
	/** Presets are a radiogroup; the accessible name is the colour's NAME, not its hex. */
	/*
	 * The preset swatch, addressed by the radio's accessible name.
	 *
	 * That name is the BARE colour name ("pink"), not "pink swatch": the element already has
	 * role=radio, so announcing "swatch" was noise a screen reader had to sit through on all eight.
	 * This helper is where the format lives, and it has now drifted in BOTH directions -- the header
	 * note above records the driver still asking for `color #ff5cae` after the label became
	 * "violet swatch", and then this file asking for "violet swatch" after the label became "violet".
	 * The name LIST is asserted against the component in contract.test.ts; so is this FORMAT, because
	 * matching lists cannot tell you the wrapper around each entry is still right.
	 */
	swatch: (colourName: string) => ({ role: 'radio' as const, name: colourName }),
	hueSlider: 'input[type="range"]',
	submit: /Start singing/,

	// ── phone remote ──────────────────────────────────────────────────────
	search: 'input[aria-label="Search a song or artist"]',
	songRow: '.row',
	songTitle: '.row .t',
	addTurn: '.row .add',
	sing: '.row .sing',
	queueRow: '.qrow',
	queueTitle: '.qrow .t',
	browseToggle: '.browse-toggle',

	// ── transport (in the queue sheet's peek) ─────────────────────────────
	play: { role: 'button' as const, name: 'play/pause' },
	skip: { role: 'button' as const, name: 'skip' },
	restart: { role: 'button' as const, name: 'restart' },

	// ── TV ────────────────────────────────────────────────────────────────
	lowerThird: '.lower-third',
	nowSong: '.ls-song',
	nowName: '.ls-name',
	stateNext: '.state-next',
	stateError: '.state-error',
	stateWaiting: '.state-waiting'
} as const;

/**
 * Colour names the join picker exposes as accessible labels. The flow picks by name because that is
 * what a screen reader — and therefore a role-based query — actually sees. The hex is deliberately not
 * used: it was the thing that rotted.
 */
export const PRESET_COLOUR_NAMES = [
	'violet',
	'pink',
	'green',
	'amber',
	'blue',
	'coral',
	'purple',
	'mint'
] as const;

export const HOOKS: Hook[] = [
	// join (the colour picker itself is a shared component — see ColourPicker.svelte)
	{
		id: 'nameInput',
		file: 'src/routes/join/+page.svelte',
		anchor: 'placeholder="e.g. Maya"',
		why: 'the flow types a singer name here'
	},
	{
		id: 'swatchRadiogroup',
		file: 'src/lib/components/ColourPicker.svelte',
		anchor: 'aria-label={colorName(c)}',
		why: 'presets are selected by accessible name; the old flow used a hex and broke'
	},
	{
		id: 'colourNames',
		file: 'src/lib/components/ColourPicker.svelte',
		anchor: "'violet', 'pink', 'green', 'amber', 'blue', 'coral', 'purple', 'mint'",
		why: 'PRESET_COLOUR_NAMES here must match the names the picker announces'
	},
	{
		id: 'hueSlider',
		file: 'src/lib/components/ColourPicker.svelte',
		anchor: 'aria-label="Pick your own color by hue"',
		why: 'the flow proves a wheel hue survives the round trip, not just a preset'
	},
	{
		id: 'submit',
		file: 'src/routes/join/+page.svelte',
		anchor: 'Start singing',
		why: 'the flow submits the join form by this label'
	},

	// phone remote
	{
		id: 'search',
		file: 'src/routes/+page.svelte',
		anchor: 'aria-label="Search a song or artist"',
		why: 'the flow searches the library through this field'
	},
	{
		id: 'readinessChips',
		file: 'src/routes/+page.svelte',
		anchor: 'aria-label="Filter by readiness"',
		why: 'readiness is the organising axis; there is deliberately no source switch to click'
	},
	{
		id: 'browseToggle',
		file: 'src/routes/+page.svelte',
		anchor: 'class="browse-toggle"',
		why: 'browse is behind a disclosure now, so facets are not clickable until it is opened'
	},
	{
		id: 'songRow',
		file: 'src/lib/components/SongRow.svelte',
		anchor: 'class="row card"',
		why: 'search results are read from .row — the old flow read .result and found nothing'
	},
	{
		id: 'addTurn',
		file: 'src/lib/components/SongRow.svelte',
		anchor: 'class="add"',
		why: 'a ready song is queued with this button'
	},
	{
		id: 'sing',
		file: 'src/lib/components/SongRow.svelte',
		anchor: 'class="sing"',
		why: 'a raw song has ONE action that both queues and starts the cook'
	},
	{
		id: 'queueRow',
		file: 'src/lib/components/QueueRow.svelte',
		anchor: 'class="qrow',
		why: 'the rotation is read from .qrow to compare order across phones'
	},

	// transport
	{
		id: 'play',
		file: 'src/routes/+page.svelte',
		anchor: 'aria-label="play/pause"',
		why: 'the flow starts playback through the real control, not a synthetic socket message'
	},
	{
		id: 'skip',
		file: 'src/routes/+page.svelte',
		anchor: 'aria-label="skip"',
		why: 'the flow advances the rotation to prove round-robin ordering'
	},
	{
		id: 'queuePeek',
		file: 'src/lib/components/QueueSheet.svelte',
		anchor: 'aria-expanded={open}',
		why: 'the transport lives in the sheet peek; the flow must know the sheet is reachable'
	},

	// TV
	{
		id: 'lowerThird',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="lower-third"',
		why: 'proves the TV names who is singing once playback starts'
	},
	{
		id: 'nowSong',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="ls-song"',
		why: 'the flow compares this before and after a skip'
	},
	{
		id: 'transientStates',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'state-error',
		why: 'the three transient states must stay distinguishable, so each keeps its own class'
	},
	{
		id: 'tvSongIntro',
		file: 'src/routes/tv/+page.svelte',
		anchor: 'class="interstitial state-next"',
		why: 'the song-intro card names who is up before playback; the flow reads .up-song / .up-name off it'
	},

	// guiding track (phone now-playing sheet body)
	{
		id: 'guidingTrack',
		file: 'src/lib/components/GuidingTrack.svelte',
		anchor: 'aria-label="Guiding track — original vocal level"',
		why: 'the flow mixes the original vocals back in through this range input'
	},

	// per-song stage background hook removed: the stage look now lives only in room settings, so the
	// phone route no longer renders a .bg-pick override control for the contract to anchor to.

	// profile sheet (phone header → name / colour / leave)
	{
		id: 'profileOpen',
		file: 'src/routes/+page.svelte',
		anchor: 'aria-label="Your profile"',
		why: 'the flow opens the profile sheet from the header me-button'
	},
	{
		id: 'profileName',
		file: 'src/lib/components/ProfileSheet.svelte',
		anchor: 'id="profile-name"',
		why: 'the flow edits the singer name in the profile sheet through this field'
	},
	{
		id: 'profileLeave',
		file: 'src/lib/components/ProfileSheet.svelte',
		anchor: 'Leave the room',
		why: 'the flow reaches the destructive leave-the-room action by this label'
	},

	// away / presence indicator (queue row)
	{
		id: 'queueAway',
		file: 'src/lib/components/QueueRow.svelte',
		anchor: 'class="away"',
		why: 'the flow proves an unreachable singer is marked away so the room can decide to skip them'
	},

	// TV visualizer picker (settings)
	{
		id: 'tvVisualizer',
		file: 'src/routes/settings/+page.svelte',
		anchor: 'id="tv-visualizer"',
		why: 'the flow selects which audio visualizer paints the TV stage'
	},

	// stats + metrics pages
	{
		id: 'statsPage',
		file: 'src/routes/stats/+page.svelte',
		anchor: '<h1>Party stats</h1>',
		why: 'the public stats page landmark the flow lands on at /stats'
	},
	{
		id: 'metricsPage',
		file: 'src/routes/metrics/+page.svelte',
		anchor: '<h1>Processing metrics</h1>',
		why: 'the internal metrics page landmark the flow lands on at /metrics'
	}
];
