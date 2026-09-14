// The guiding-track level: clamping, the null-means-inherit contract, and availability.
//
// A guiding track is the original vocals mixed back UNDER the instrumental, so a crowd doing songs it
// half-knows can lean on a faint guide. Three concerns live here, all pure:
//
//   • clampGuideLevel     — coerce a requested level to [0,1], or null to CLEAR the per-song override.
//   • effectiveGuideLevel — the number the player mixes at: the override, else the room default.
//   • hasGuidingTrack     — whether a song can offer the control at all.
//
// The load-bearing distinction throughout is `null` (no per-song override — use the room default)
// versus `0` (explicitly off for this song). Collapsing the two is the bug this shape prevents: it
// would make a room default impossible to honour after the first song change. Extracted from types.ts
// so guide-level.test.ts names a real module and types.ts owns only types.

import { isPlayable, type Media, type PlaybackState } from '../core/types';

/**
 * Clamp a requested guiding-track level to `[0,1]`, or `null` to CLEAR the per-song override.
 *
 * `null`/`undefined` pass through as `null` (inherit the room default) — this is a settable field
 * where "cleared" and "rejected" must not collapse into the same value, so garbage is also `null`
 * rather than a silent 0: refusing to invent a level is honest, and inheriting is the safe fallback.
 * Rounded to whole percent so the persisted value stays tidy and two drags that land on the same
 * notch compare equal.
 */
export function clampGuideLevel(level: number | null | undefined): number | null {
	if (level === null || level === undefined || !Number.isFinite(level)) return null;
	return Math.round(Math.max(0, Math.min(1, level)) * 100) / 100;
}

/**
 * The level the TV should actually mix at: the per-song override when one is pinned, otherwise the
 * room default. Never returns null — the player needs a number for `.volume`.
 */
export function effectiveGuideLevel(playback: Pick<PlaybackState, 'guideLevel'>, roomDefault: number): number {
	return playback.guideLevel ?? clampGuideLevel(roomDefault) ?? 0;
}

/**
 * HOW the TV should play this song's guide — the one decision that replaces a branch scattered across
 * the player.
 *
 * Two answers, and the absence of a third is the design decision:
 *
 *   `mix`     — ONE 4-channel file through ONE media element. Channels 0/1 are the instrumental, 2/3 the
 *               vocals, split apart in WebAudio and given their own gains. One decoder means one playhead,
 *               so the guide CANNOT drift from the instrumental. This is the ONLY way a guide is played.
 *   `none`    — not playable, or no mix to play.
 *
 * THE TWO-ELEMENT PATH IS GONE, and it was removed rather than fixed because it could not be fixed.
 * It played the vocals stem in a SECOND media element held against the instrumental by a drift
 * governor, and that governor could only ever compare the two elements' reported `currentTime` — the
 * spec's official playback position, which EXCLUDES each element's output latency. So it converged on
 * "aligned" using a signal that does not describe what the ear hears, and then correctly stopped
 * correcting, leaving an audible offset no tuning could reach. Two decoders cannot be sample-locked
 * from script; one file does not need to be.
 *
 * Returned as a discriminated union rather than a boolean so that adding a second audible path back
 * requires changing this type — the two-decoder design cannot creep in as an `if` somewhere in the
 * player, which is how it arrived the first time.
 */
export type GuidePath =
	/** One 4-channel file, one playhead. `ref` is the mix. */
	| { kind: 'mix'; ref: string }
	/** No guide is on offer. */
	| { kind: 'none' };

export function guidePath(m: Pick<Media, 'stemStatus' | 'instrumentalRef' | 'guideMixRef'>): GuidePath {
	// Playability first: the guide is an overlay on something, and there is nothing to overlay until the
	// song plays at all. This mirrors hasGuidingTrack rather than re-deriving it.
	if (!isPlayable(m)) return { kind: 'none' };
	if (m.guideMixRef) return { kind: 'mix', ref: m.guideMixRef };
	// NO SECOND-ELEMENT FALLBACK. A song with a vocals stem but no mix offers NO guide — deliberately.
	// See the header: a `vocalsRef` is still the stem the mix is BUILT from, so it is not evidence that
	// this song can be guided from one playhead, and reading it here is what re-opens the two-decoder
	// path this type exists to make unrepresentable.
	return { kind: 'none' };
}

/**
 * Can this song offer a guiding track (the original vocals mixed back under the instrumental)?
 *
 * Defined AS `guidePath(m).kind !== 'none'` rather than re-deriving the condition, because two answers to
 * one question is how a surface goes stale. This gates the phone's guide slider and the server's guide-level
 * path; `guidePath` decides how the TV plays it. They agreed only by an unenforced coincidence — a mix is
 * only ever published alongside a vocals stem — and the moment that stops being true (dropping the
 * redundant single-stem vocals file once a mix exists is an obvious space win) the slider would vanish while
 * the TV played the mix happily.
 */
export function hasGuidingTrack(
	m: Pick<Media, 'stemStatus' | 'instrumentalRef' | 'vocalsRef' | 'guideMixRef'>
): boolean {
	return guidePath(m).kind !== 'none';
}
