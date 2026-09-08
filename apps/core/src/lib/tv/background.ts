// What the TV paints behind the song, resolved to one CSS `background` value.
//
// Pure and separate from the component for the same reason `screen.ts` is: the interesting part is a
// decision table, and a decision table that lives inside a `.svelte` file cannot be unit-tested.
//
// Why this matters more than it sounds: a make-karaoke song plays a separated instrumental, which has
// no video track, so the `<video>` paints nothing and this value is the ENTIRE visual field for the
// song — sitting directly behind the word-timed lyric reel.
//
// That fact used to be an ARGUMENT FOR A BOUND: every stage was generated at the pinned stage tier
// (`stageHueToHex`) from a stored hue angle, precisely so no option could produce a field bright
// enough to wash those lyrics out. #425 retired the bound and kept the concern, by moving the defence
// onto the thing being defended: the reel now paints its own `-webkit-text-stroke` outline (#750,
// `b764d92`), so the words hold against any field. That is strictly stronger, because a stage bound
// only ever protected the make-karaoke case — over a real music video the reel sat on frames nothing
// here controls, and was already unprotected.
//
// So `solid` now renders the room's stored colour VERBATIM. The two styles the room does not pick by
// hand keep the tier: `singer` derives its glow from somebody's identity dot, and `visualizer` builds
// a palette by hue arithmetic — nobody chose those colours, so nobody could see why one came out
// bright.
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
 * `stageColor` is the room's stored stage colour (`RoomSettings.tvBackgroundColor`), canonical hex,
 * used only by the `solid` style. It is rendered verbatim rather than regenerated at the stage tier —
 * see the header for why that bound moved onto the lyric reel in #425.
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
export function stageBackgroundCss(style: TvBackgroundStyle, stageColor: string, singerColor?: string | null): string {
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
			// The room's colour, as stored. No tier, no guard — #425.
			return stageColor;
		case 'visualizer':
			// The FLOOR under the canvas, not the visualizer itself. A visualizer is a drawing loop, not
			// a CSS value, so it cannot be expressed here at all — `VisualizerStage` mounts inside this
			// same layer and paints over this black. Returning black rather than `transparent` matters:
			// it keeps the layer opaque, so a canvas that has not painted its first frame yet shows the
			// stage's own floor instead of whatever is beneath it.
			return '#000';
	}
}
