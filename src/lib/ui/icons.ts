/*
 * The icon set, as path data.
 *
 * WHY THIS FILE EXISTS. The transport controls used to be Unicode characters — `⏮ ▶ ⏸ ⏭` — and on
 * iOS they rendered as full-colour Apple emoji instead of the monochrome marks they were meant to be.
 * That is not a bug in our markup: U+23EE, U+23F8 and U+23ED carry `Emoji_Presentation=Yes`, so colour
 * emoji IS their Unicode default, and the font stack in app.css contains no font that owns those
 * glyphs, so the platform's last-resort matcher wins. `▶` (U+25B6) is text-default but emoji-capable,
 * which is why it rendered inconsistently right beside `⏸`.
 *
 * Appending U+FE0E (the text-presentation selector) is NOT the fix: WebKit honours it unreliably on
 * exactly these codepoints, and even when honoured you only control colour — not stroke weight, not
 * metrics, not optical size. The only way to own every rendered mark is to stop shipping codepoints
 * as icons. Hence paths.
 *
 * WHY INLINE PATHS AND NOT A DEPENDENCY. Encore is self-hosted and expected to work on a LAN with no
 * internet, and it is a PWA. A webfont is the same class of failure we are escaping (glyph rendering
 * delegated to font matching, plus FOUT). A CDN is a hard offline failure. An external sprite sheet
 * adds a fetch that has to be reasoned about against the service worker. Copying the path data in
 * keeps the dependency count at zero and the whole set at a couple of KB inside a bundle the app
 * already loads.
 *
 * Geometry is Lucide's (https://lucide.dev, ISC licence — MIT-equivalent, permissive): a 24×24 grid
 * with a 2px stroke, round caps and joins. Only the `d`/geometry is vendored, not the package.
 *
 * Values are the INNER markup of the svg. They are compile-time constants in our own source with no
 * interpolation and no path from user input, which is what makes rendering them via {@html} in
 * Icon.svelte safe.
 */

export const ICON_PATHS = {
	// ── transport: the reported bug ──────────────────────────────────────────
	prev: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>',
	play: '<polygon points="6 3 20 12 6 21 6 3"/>',
	pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
	next: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',

	// ── queue reorder + dismissal ───────────────────────────────────────────
	'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
	'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
	close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
	grip: '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',

	// ── navigation ──────────────────────────────────────────────────────────
	'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
	'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
	'chevron-up': '<path d="m18 15-6-6-6 6"/>',
	'chevron-down': '<path d="m6 9 6 6 6-6"/>',
	'chevron-right': '<path d="m9 18 6-6-6-6"/>',

	// ── affirmative / additive ──────────────────────────────────────────────
	check: '<path d="M20 6 9 17l-5-5"/>',
	plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
	minus: '<path d="M5 12h14"/>',

	/*
	 * gear and warning are here despite reading as "decorative" emoji, because both were written with a
	 * trailing U+FE0F — which does not merely permit colour emoji, it explicitly REQUESTS it — and both
	 * are functional: a settings link and an error state.
	 */
	gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
	warning:
		'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',

	/*
	 * These replaced emoji rather than text glyphs. An emoji is the one mark whose appearance is NEVER
	 * yours: 🎤 is a different drawing on Apple, Google, Samsung and Windows, and on a browser with no
	 * emoji font at all it is a tofu box — which is exactly what the TV wordmark rendered as when
	 * screenshotted on a font-poor Linux browser. A smart-TV browser is the same kind of environment.
	 */
	mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
	sparkle:
		'<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
	search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	flame:
		'<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
	clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'
} as const;

export type IconName = keyof typeof ICON_PATHS;

/**
 * Marks drawn as solid shapes rather than outlines.
 *
 * Fill has to be opt-in per mark, not applied to every <rect>/<polygon>: `pause` is two filled bars,
 * but `mic` uses a rect for the capsule and filling it turns the microphone into a solid blob.
 */
export const SOLID_ICONS: readonly IconName[] = ['prev', 'play', 'pause', 'next'];

/** Every mark, for the gallery and for the guard test to assert the set stays renderable. */
export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];
