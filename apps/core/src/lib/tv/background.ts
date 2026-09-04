// What the TV paints behind the song, resolved to one CSS `background` value.
//
// Pure and separate from the component for the same reason `screen.ts` is: the interesting part is a
// decision table, and a decision table that lives inside a `.svelte` file cannot be unit-tested.
//
// Why this matters more than it sounds: a make-karaoke song plays a separated instrumental, which has
// no video track, so the `<video>` paints nothing and this value is the ENTIRE visual field for the
// song — sitting directly behind the word-timed lyric reel. Everything here is generated at the
// pinned stage tier (`stageHueToHex`) precisely so no option can produce a field bright enough to
// wash those lyrics out.
import { stageHueToHex, nearestSingerHue, type TvBackgroundStyle } from '@encore/shared';

/**
 * The room glow — byte-identical to the radial the attract and lobby screens already paint
 * (`tv/+page.svelte` `.attract`, `TvLobby.svelte` `.lobby`). Reused verbatim rather than re-derived so
 * the lobby→stage handover is invisible: it is literally the same gradient, so there is nothing to
 * cross-fade between.
 */
const ROOM_GLOW = 'radial-gradient(80% 60% at 50% 30%, var(--stage-glow) 0%, var(--bg) 70%)';

/** The same geometry as ROOM_GLOW, in an arbitrary hue. */
function glowInHue(hue: number): string {
	return `radial-gradient(80% 60% at 50% 30%, ${stageHueToHex(hue)} 0%, var(--bg) 70%)`;
}

/**
 * Resolve a background style to a CSS `background` value.
 *
 * `singerColor` is the current singer's stored colour (`singers.color`), used only by the `singer`
 * style. When it is absent or unparseable — nobody is up yet, or the roster has not arrived — `singer`
 * degrades to the room glow rather than to black: an unknown singer is a missing fact, and blinking
 * the stage to black while waiting for it would read as a fault.
 *
 * Every branch is matched explicitly with no trailing `else`, so adding a style to
 * TV_BACKGROUND_STYLES without teaching this function about it is a type error rather than a silent
 * fallback — the same discipline `TvProgress.svelte` applies to the progress styles.
 */
export function stageBackgroundCss(
	style: TvBackgroundStyle,
	hue: number,
	singerColor?: string | null
): string {
	switch (style) {
		case 'off':
			return '#000';
		case 'gradient':
			return ROOM_GLOW;
		case 'singer': {
			if (!singerColor) return ROOM_GLOW;
			const h = nearestSingerHue(singerColor);
			return glowInHue(h);
		}
		case 'solid':
			return stageHueToHex(hue);
	}
}
