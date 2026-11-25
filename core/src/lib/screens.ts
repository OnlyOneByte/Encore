// The Screens page's row shape and its one line of status. See docs/FRONTEND.md#the-screens-page.
import type { TvShow } from '$lib/contract';

/** One row of GET /api/screens (server/rooms/tv-screens.ts `ScreenView`). */
export interface ScreenRow {
	/** The screen's `tvId` (its cookie's hash), or `s<socket key>` for a cookieless one, which lives as long as it. */
	id: string;
	name: string;
	isTv: boolean;
	/** Copy minus TV, in ms (positive: ahead). Null for the TV, and for a copy with no fresh report. */
	driftMs: number | null;
	/** Opened in the last minute and not yet named: the page's Spotlight. */
	isNew: boolean;
	/** A cookieless screen can never hold the seat (docs/SERVER.md#the-tv-seat). */
	canBeTv: boolean;
	/** Every screen but the room's TV. One standing in for it while it is off can go (docs/SERVER.md#screens). */
	canRemove: boolean;
	/** What it shows. The TV always shows everything, whatever is stored. */
	show: TvShow;
}

/** "The TV · sound", or a copy's distance from it: "Quiet · 12 ms behind". */
export function screenTag(s: Pick<ScreenRow, 'isTv' | 'driftMs'>): string {
	if (s.isTv) return 'The TV · sound';
	if (s.driftMs === null) return 'Quiet';
	const ms = Math.round(Math.abs(s.driftMs));
	if (ms === 0) return 'Quiet · in step';
	return `Quiet · ${ms} ms ${s.driftMs < 0 ? 'behind' : 'ahead'}`;
}
