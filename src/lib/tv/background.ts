// What the TV paints behind the song, resolved to one CSS `background` value. Pure, so the decision table is
// unit-testable outside a `.svelte` file.
//
// On a processed song the instrumental has no video track, so this value is the ENTIRE visual field behind
// the lyric reel. There is no brightness bound on it: the reel defends itself with its own
// `-webkit-text-stroke`, which also covers the music-video case a stage bound never could. So `solid` renders
// the room's stored colour VERBATIM, while the styles nobody picks by hand stay on the pinned stage tier.
import { stageHueToHex, nearestSingerHue, dimTowardBlack, type TvBackgroundStyle } from '$lib/contract';

/**
 * The room glow — byte-identical to the radial `.attract` and `.lobby` paint, so the lobby-to-stage
 * handover is literally the same gradient and there is nothing to cross-fade between.
 */
const ROOM_GLOW = 'radial-gradient(80% 60% at 50% 30%, var(--stage-glow) 0%, var(--bg) 70%)';

/** The same geometry as ROOM_GLOW, in an arbitrary hue, dimmed toward black by `dim` (0 = full). */
function glowInHue(hue: number, dim: number): string {
	return `radial-gradient(80% 60% at 50% 30%, ${dimTowardBlack(stageHueToHex(hue), dim)} 0%, var(--bg) 70%)`;
}

/**
 * `stageColor` is the room's stored `tvBackgroundColor`, used only by `solid`. `singerColor` is used only by
 * `singer`; absent or unparseable it degrades to the room GLOW, not black — an unknown singer is a missing
 * fact, and a black stage reads as a fault.
 *
 * Every branch is matched explicitly with NO trailing `else`, so adding a style to TV_BACKGROUND_STYLES
 * without teaching this function about it is a type error rather than a silent fallback.
 *
 * `dim` (0..1) is a lightness transform on the CONCRETE colour a style resolves to. The styles resolving to
 * no chosen colour take no dim: `gradient` is CSS variables a pure function cannot darken, and
 * `off`/`visualizer` are already `#000`.
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
			// The opaque FLOOR under the canvas, not the visualizer itself — `VisualizerStage` mounts in this
			// layer and paints over it. Black rather than `transparent`, so an unpainted first frame shows the
			// stage floor rather than whatever is beneath.
			return '#000';
	}
}
