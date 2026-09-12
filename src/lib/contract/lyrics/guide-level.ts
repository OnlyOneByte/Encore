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
 * Three answers, and the ordering between the first two is the whole point:
 *
 *   `mix`     — ONE 4-channel file through ONE media element. Channels 0/1 are the instrumental, 2/3 the
 *               vocals, split apart in WebAudio and given their own gains. One decoder means one playhead,
 *               so the guide CANNOT drift from the instrumental. Preferred whenever a mix exists.
 *   `element` — the legacy two-element path: instrumental in the master, vocals in a second element held
 *               in time by `guide-sync.ts`'s governor. Correct as far as it can be, and structurally
 *               unable to be exact — see `Media.guideMixRef`. Kept for songs with no mix.
 *   `none`    — not playable, or no vocals to offer.
 *
 * Returned as a discriminated union rather than a pair of booleans so the two paths cannot BOTH be taken:
 * mounting a second element beside the mix would play the vocals twice, once in the mix at the room's
 * level and once at the element's — audibly a doubled, flanged vocal, which is precisely the defect class
 * this feature exists to remove. The type makes that state unrepresentable.
 */
export type GuidePath =
	/** One 4-channel file, one playhead. `ref` is the mix. */
	| { kind: 'mix'; ref: string }
	/** Two elements and a drift governor. `ref` is the vocals stem. */
	| { kind: 'element'; ref: string }
	/** No guide is on offer. */
	| { kind: 'none' };

export function guidePath(m: Pick<Media, 'stemStatus' | 'instrumentalRef' | 'vocalsRef' | 'guideMixRef'>): GuidePath {
	// Playability first: the guide is an overlay on something, and there is nothing to overlay until the
	// song plays at all. This mirrors hasGuidingTrack rather than re-deriving it.
	if (!isPlayable(m)) return { kind: 'none' };
	if (m.guideMixRef) return { kind: 'mix', ref: m.guideMixRef };
	if (m.vocalsRef) return { kind: 'element', ref: m.vocalsRef };
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
