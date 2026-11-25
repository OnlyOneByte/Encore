/*
 * The icon set, as path data. NO CODEPOINT MAY BE SHIPPED AS AN ICON: several transport codepoints carry
 * `Emoji_Presentation=Yes`, so colour emoji is their Unicode default, and the text-presentation selector is honoured
 * unreliably on exactly those. INLINE PATHS AND NO DEPENDENCY, because this app is self-hosted and expected to work on
 * a LAN with no internet. Geometry is Lucide's (ISC licence; the text is in ./icons.LICENSE), a 24×24 grid with a
 * 2px stroke; values are the svg's INNER markup, and being compile-time constants with no interpolation is what makes
 * {@html} in Icon.svelte safe.
 */

export const ICON_PATHS = {
	prev: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>',
	play: '<polygon points="6 3 20 12 6 21 6 3"/>',
	pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
	next: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
	/* RESTART, and it must NOT be drawn with `prev`: there is no previous-track concept in a rotation, so the skip-back
	   mark advertises something the app cannot do. Stroked rather than filled, which is why it is absent from SOLID_ICONS. */
	restart: '<path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8"/><path d="M3 3v5h5"/>',
	// Stroked, and filled by the strip's CSS once saved, so one path draws both states.
	heart:
		'<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',

	'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
	'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
	close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
	grip: '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',

	'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
	'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
	'chevron-up': '<path d="m18 15-6-6-6 6"/>',
	'chevron-down': '<path d="m6 9 6 6 6-6"/>',
	'chevron-right': '<path d="m9 18 6-6-6-6"/>',

	check: '<path d="M20 6 9 17l-5-5"/>',
	plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
	minus: '<path d="M5 12h14"/>',

	/* Dots rather than an info or cog mark, for a positional reason: every surface here puts a round icon-only control in
	   the header's right column. Each circle sets `fill` ITSELF, because Icon.svelte's root declares `fill="none"`. */
	dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
	gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
	warning:
		'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
	// Lucide `volume-x`: the TV copy's "this screen is muted".
	'volume-off':
		'<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',

	/* An emoji is the one mark whose appearance is NEVER yours: a different drawing on every platform, and a tofu box on
	   a browser with no emoji font — which is what a smart-TV browser can be. */
	mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
	sparkle:
		'<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
	search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	/* Books on a shelf, and deliberately NOT `mic`: the wordmark beside it is already a mic, so the two would read as
	   one brand cluster rather than a heading and a destination. Four bare bars survive 24px where a spined-book
	   drawing muddies. */
	library: '<path d="M4 4v16"/><path d="M8 8v12"/><path d="M12 6v14"/><path d="m16 6 4 14"/>',
	flame:
		'<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
	clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** Marks drawn as solid shapes. Fill must be OPT-IN per mark rather than applied to every rect and polygon: `pause` is
 * two filled bars, but `mic` uses a rect for its capsule and filling it turns the microphone into a blob. */
export const SOLID_ICONS: readonly IconName[] = ['prev', 'play', 'pause', 'next'];
