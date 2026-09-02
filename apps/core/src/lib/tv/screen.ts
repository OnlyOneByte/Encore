// Which of the TV's idle screens to show (B-6-C2).
//
// Before this, `/tv` collapsed every non-playing situation into ONE attract screen: an empty room
// and a room with four people waiting for a first pick looked identical, so the TV could not tell
// anyone what it was waiting for. The distinction is entirely derivable from state the TV already
// holds — no new server round-trip.
//
// Pure (no Svelte, no DOM) so the precedence rules are unit-testable; `+page.svelte` renders it.

import type { QueueEntry, Media } from '@encore/shared';

/**
 * What the TV should be showing.
 * - `attract`  — nobody is here. The QR is the only thing to do, so it owns the screen.
 * - `lobby`    — people ARE here but nothing is queued: name them and say what we're waiting for.
 * - `waiting`  — something is queued but its stems are still cooking (M7-C6 held slot).
 * - `playing`  — a song is up; the video owns the screen and the QR retreats to a corner.
 */
export type TvScreen = 'attract' | 'lobby' | 'waiting' | 'playing';

export interface TvScreenInput {
	/** The gapless controller's own state — 'waiting' is authoritative when set. */
	playerState: string;
	/** The current entry, if the server has handed us one. */
	current: QueueEntry | null;
	/** Every queue entry the TV knows about (used to tell "empty" from "queued but not playable"). */
	entries: QueueEntry[];
	/** How many singers hold a live socket right now (presence, B-6-C1). */
	onlineCount: number;
}

/**
 * Decide the screen. Precedence, highest first:
 *  1. `playing` — if a song is actually current, nothing else matters.
 *  2. `waiting` — the player says it is holding for media that is still cooking.
 *  3. `lobby`   — somebody is present (or something is queued) but nothing can play yet.
 *  4. `attract` — an empty, idle room.
 *
 * Note on 3: a non-empty queue with nobody online still shows the lobby rather than the attract
 * screen. That happens after a restart rehydrates a queue before any phone reconnects, and wiping
 * the screen back to "scan to join" would imply the queue was lost.
 */
export function tvScreen(input: TvScreenInput): TvScreen {
	const { playerState, current, entries, onlineCount } = input;
	if (current && playerState !== 'waiting') return 'playing';
	if (playerState === 'waiting') return 'waiting';
	if (onlineCount > 0 || entries.length > 0) return 'lobby';
	return 'attract';
}

/** A singer as the TV roster needs them: display name + their identity color. */
export interface RosterMember {
	id: string;
	displayName: string;
	color: string;
}

/**
 * Build the lobby roster: present singers only, in arrival order, capped so a big party cannot
 * push chips over the rest of the screen. The overflow count is returned rather than rendered
 * so the caller decides the wording.
 */
export function lobbyRoster(
	online: string[],
	singers: Map<string, { id: string; displayName: string; color: string }>,
	max = 8
): { shown: RosterMember[]; overflow: number } {
	// A presence id with no directory entry yet (presence arrived before queue:sync) is skipped
	// rather than rendered as "Someone" — a nameless chip is worse than one fewer chip.
	const known = online.map((id) => singers.get(id)).filter((s): s is RosterMember => !!s);
	return { shown: known.slice(0, max), overflow: Math.max(0, known.length - max) };
}
