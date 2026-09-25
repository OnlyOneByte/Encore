// The original vocals mixed back UNDER the instrumental, and its level. THE LOAD-BEARING DISTINCTION is
// `null` (no per-song override, use the room default) versus `0` (explicitly off): collapsing the two makes
// a room default impossible to honour after the first song change.

import { isPlayable, type Media, type PlaybackState } from '../core/types';

/**
 * `null` CLEARS the per-song override, and garbage also returns `null` rather than a silent 0 — inheriting is
 * the safe fallback. Rounded to whole percent, so two drags landing on the same notch compare equal.
 */
export function clampGuideLevel(level: number | null | undefined): number | null {
	if (level === null || level === undefined || !Number.isFinite(level)) return null;
	return Math.round(Math.max(0, Math.min(1, level)) * 100) / 100;
}

/** The per-song override when pinned, else the room default. Never null: `.volume` needs a number. */
export function effectiveGuideLevel(playback: Pick<PlaybackState, 'guideLevel'>, roomDefault: number): number {
	return playback.guideLevel ?? clampGuideLevel(roomDefault) ?? 0;
}

/**
 * The ONE decision, so no branch scatters across the player. THERE IS DELIBERATELY NO TWO-ELEMENT PATH: two
 * elements can only be held together by comparing reported `currentTime`, which EXCLUDES output latency, so a
 * governor converges on a signal that does not describe what the ear hears. A discriminated union rather than
 * a boolean, so re-adding that path means changing this TYPE and cannot creep in as an `if`.
 */
export type GuidePath =
	/** One 4-channel file, one playhead. `ref` is the mix. */
	| { kind: 'mix'; ref: string }
	/** No guide is on offer. */
	| { kind: 'none' };

export function guidePath(m: Pick<Media, 'stemStatus' | 'instrumentalRef' | 'guideMixRef'>): GuidePath {
	// Playability first: a guide is an overlay, and there is nothing to overlay yet.
	if (!isPlayable(m)) return { kind: 'none' };
	if (m.guideMixRef) return { kind: 'mix', ref: m.guideMixRef };
	// NO FALLBACK ON `vocalsRef`: that is the stem the mix is BUILT from, not evidence of a single
	// playhead, so reading it here re-opens the two-decoder path this type forbids.
	return { kind: 'none' };
}

/**
 * Defined AS `guidePath(m).kind !== 'none'` and never by re-deriving the condition: this gates the phone's
 * slider while `guidePath` decides how the TV plays it, and two independent answers drift the moment a mix
 * is published without a single-stem vocals file beside it.
 */
export function hasGuidingTrack(
	m: Pick<Media, 'stemStatus' | 'instrumentalRef' | 'vocalsRef' | 'guideMixRef'>
): boolean {
	return guidePath(m).kind !== 'none';
}
