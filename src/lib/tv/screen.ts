// Which of the TV's idle screens to show. Pure (no Svelte, no DOM) so the precedence rules are
// unit-testable; `+page.svelte` renders the result.

import type { QueueEntry } from '$lib/contract';
import type { TvState } from './gapless';

/**
 * What the TV should be showing. `lobby` covers TWO situations the caller must word differently: nothing
 * picked at all, and something picked that is still processing — `tvScreen` routes both here, because
 * `waiting` means the PLAYER is actively holding, which is narrower.
 */
export type TvScreen = 'attract' | 'lobby' | 'waiting' | 'playing';

export interface TvScreenInput {
	/** The gapless controller's own state — 'waiting' is authoritative when set. */
	playerState: TvState;
	/** The current entry, if the server has handed us one. */
	current: QueueEntry | null;
	/** Every queue entry the TV knows about (used to tell "empty" from "queued but not playable"). */
	entries: QueueEntry[];
	/**
	 * `here` plus `away`, NOT the socket count. A room where everyone has pocketed their phone is still a
	 * room with people in it; counting sockets sends the TV back to the attract screen mid-party.
	 */
	inRoomCount: number;
}

/**
 * Precedence, highest first: playing, waiting, lobby, attract. A non-empty queue with nobody online still
 * shows the LOBBY, because that is what a restart rehydrating a queue before any phone reconnects looks
 * like — "scan to join" would imply the queue was lost.
 */
export function tvScreen(input: TvScreenInput): TvScreen {
	const { playerState, current, entries, inRoomCount } = input;
	if (current && playerState !== 'waiting') return 'playing';
	if (playerState === 'waiting') return 'waiting';
	if (inRoomCount > 0 || entries.length > 0) return 'lobby';
	return 'attract';
}

/**
 * Should the lyrics reel and ball ADVANCE right now? ALL THREE dimensions must agree or the words sweep
 * over a silent room: a paused song is still `current`, so the screen alone is not enough; `isPlaying` is
 * the server's INTENT, which stays true while autoplay is refused or the transport is `idle`; and
 * `elementAdvancing` is the honest signal from the master element's own play/pause.
 *
 * Distinct from VISIBLE: the overlay stays on screen while paused, frozen mid-line.
 */
export function lyricsAdvancing(
	screen: TvScreen,
	tvState: TvState,
	isPlaying: boolean,
	elementAdvancing: boolean
): boolean {
	return screen === 'playing' && tvState !== 'interstitial' && isPlaying && elementAdvancing;
}

/** A singer as the TV roster needs them: display name, identity color, and whether they are reachable. */
export interface RosterMember {
	id: string;
	displayName: string;
	color: string;
	/** `here` holds a live socket; `away` is in the room but unreachable (locked phone, pocket). */
	state: 'here' | 'away';
}

/**
 * Build the lobby roster. `here` singers are listed before `away` ones, so a cap sheds the unreachable
 * first: the chips worth showing are the people who can take a turn right now. The overflow count is
 * returned rather than rendered, so the caller decides the wording.
 */
export function lobbyRoster(
	here: string[],
	away: string[],
	singers: Map<string, { id: string; displayName: string; color: string }>,
	max = 8
): { shown: RosterMember[]; overflow: number } {
	// A membership id with no directory entry yet (presence beat queue:sync) is skipped rather than
	// rendered as "Someone": a nameless chip is worse than one fewer chip.
	const resolve = (ids: string[], state: 'here' | 'away'): RosterMember[] =>
		ids
			.map((id) => singers.get(id))
			.filter((s): s is { id: string; displayName: string; color: string } => !!s)
			.map((s) => ({ ...s, state }));
	const known = [...resolve(here, 'here'), ...resolve(away, 'away')];
	return { shown: known.slice(0, max), overflow: Math.max(0, known.length - max) };
}

/**
 * Is this join origin one that no phone in the room could actually reach? The address comes from the
 * request host, so opening `/tv` ON the serving machine puts a loopback or bare hostname on the wall and
 * every scan fails silently; the TV shows an operator notice instead of a working-looking QR.
 *
 * Unreachable: 127.0.0.0/8, `localhost`, `::1`, and any single-label host (a machine name a phone on the
 * LAN cannot resolve). Anything UNPARSEABLE is treated as REACHABLE — a false "unreachable" hides a QR
 * that works, which is the worse error.
 */
export function isUnreachableJoinOrigin(origin: string | null | undefined): boolean {
	if (!origin) return false; // no address yet → nothing to warn about
	let host: string;
	try {
		host = new URL(origin).hostname;
	} catch {
		return false; // unparseable → do not claim it is unreachable
	}
	// URL leaves IPv6 hosts bracketed; strip for comparison.
	const h = host.replace(/^\[|\]$/g, '').toLowerCase();
	if (h === 'localhost') return true;
	if (h === '::1') return true;
	// IPv4 loopback block 127.0.0.0/8
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
	// A dotted host or any IPv6 literal (contains ':') is assumed routable; a single label with no dot
	// is a bare machine name a phone on the LAN cannot resolve.
	if (!h.includes('.') && !h.includes(':')) return true;
	return false;
}

/**
 * The media model has FIVE stages (`MEDIA_STAGES`) and the takeover shows THREE, so the collapse is a real
 * mapping held in one place or the wall and the phone describe the same song differently. Guest words.
 */
export const PROCESS_STEPS = ['Downloaded', 'Removing vocals', 'Timing the lyrics'] as const;

/**
 * Map a `MediaStatus` onto the three displayed steps. TOTAL over every status — exactly one step is current
 * for any value, so the takeover can never render with no step marked.
 */
export function processStep(status: import('$lib/contract').MediaStatus | undefined): {
	index: number;
	fraction: string;
} {
	switch (status) {
		case 'downloading':
		case 'queued':
			return { index: 0, fraction: '20%' };
		case 'separating':
			return { index: 1, fraction: '62%' };
		case 'aligning':
			return { index: 2, fraction: '90%' };
		case 'ready':
			return { index: 2, fraction: '100%' };
		default:
			// failed / canceled / undefined — off the happy line; floor at the first step.
			return { index: 0, fraction: '20%' };
	}
}
