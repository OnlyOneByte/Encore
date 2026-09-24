// What the TV paints behind the song, resolved to one CSS `background` value.
//
// On a processed song the instrumental has no video track, so this value is the ENTIRE visual field behind the lyric
// reel — and there is deliberately NO brightness bound on it, because the reel defends itself with its own
// `-webkit-text-stroke`, which also covers the music-video case a stage bound never could.
import { stageHueToHex, nearestSingerHue, dimTowardBlack, type TvBackgroundStyle } from '$lib/contract';

/** Byte-identical to the radial `.attract`/`.lobby` paint, so the lobby-to-stage handover has nothing to cross-fade. */
const ROOM_GLOW = 'radial-gradient(80% 60% at 50% 30%, var(--stage-glow) 0%, var(--bg) 70%)';

/** The same geometry as ROOM_GLOW, in an arbitrary hue, dimmed toward black by `dim` (0 = full). */
function glowInHue(hue: number, dim: number): string {
	return `radial-gradient(80% 60% at 50% 30%, ${dimTowardBlack(stageHueToHex(hue), dim)} 0%, var(--bg) 70%)`;
}

/**
 * An absent or unparseable `singerColor` degrades to the room GLOW, not black: an unknown singer is a missing fact, and
 * a black stage reads as a fault. Every branch is matched explicitly with NO trailing `else`, so adding a style to
 * TV_BACKGROUND_STYLES without teaching this function about it is a type error rather than a silent fallback. `dim` is
 * a lightness transform on a CONCRETE colour, so the styles resolving to none take no dim.
 */
export function stageBackgroundCss(
	style: TvBackgroundStyle,
	stageColor: string,
	singerColor?: string | null,
	dim: number = 0
): string {
	switch (style) {
		case 'off':
			return '#000';
		case 'gradient':
			return ROOM_GLOW;
		case 'singer': {
			if (!singerColor) return ROOM_GLOW;
			const h = nearestSingerHue(singerColor);
			return glowInHue(h, dim);
		}
		case 'solid':
			return dimTowardBlack(stageColor, dim);
		case 'visualizer':
			// The opaque FLOOR under the canvas, not the visualizer itself. Black rather than `transparent`, so an
			// unpainted first frame shows the stage floor rather than whatever is beneath.
			return '#000';
	}
}
