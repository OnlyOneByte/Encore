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

import { isPlayable, type Media, type PlaybackState } from './types';

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
export function effectiveGuideLevel(
  playback: Pick<PlaybackState, 'guideLevel'>,
  roomDefault: number
): number {
  return playback.guideLevel ?? clampGuideLevel(roomDefault) ?? 0;
}

/**
 * Can this song offer a guiding track (the original vocals mixed back under the instrumental)?
 *
 * Requires BOTH a playable instrumental and a vocals stem, because the guide is an overlay on
 * something — there is nothing to mix vocals under until the song is playable at all. Songs
 * separated before the ref was persisted, and songs whose vocals stem came back silent, report
 * false and simply do not offer the control.
 */
export function hasGuidingTrack(
  m: Pick<Media, 'stemStatus' | 'instrumentalRef' | 'vocalsRef'>
): boolean {
  return isPlayable(m) && !!m.vocalsRef;
}
