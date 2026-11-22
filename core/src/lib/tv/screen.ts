import type { MediaStatus, QueueEntry } from '$lib/contract';
import { OVERDUE_LABEL } from '$lib/phrasing/process-phrasing';
import type { TvState } from './gapless';

/**
 * `lobby` covers TWO situations the caller must word differently — nothing picked at all, and something picked that is
 * still processing — because `waiting` means the PLAYER is actively holding, which is narrower.
 */
export type TvScreen = 'attract' | 'lobby' | 'waiting' | 'playing';

export interface TvScreenInput {
	/** The gapless controller's own state — 'waiting' is authoritative when set. */
	playerState: TvState;
	/** The current entry, if the server has handed us one. */
	current: QueueEntry | null;
	/** Every queue entry the TV knows about (used to tell "empty" from "queued but not playable"). */
	entries: QueueEntry[];
	// `here` plus `away`, NOT the socket count: a room where everyone has pocketed their phone is still a room with
	// people in it, and counting sockets sends the TV back to the attract screen mid-party.
	inRoomCount: number;
}

/**
 * Precedence, highest first: playing, waiting, lobby, attract. A non-empty queue with nobody online still shows the
 * LOBBY, because that is a restart rehydrating a queue before any phone reconnects — "scan to join" would imply the
 * queue was lost.
 */
export function tvScreen(input: TvScreenInput): TvScreen {
	const { playerState, current, entries, inRoomCount } = input;
	if (current && playerState !== 'waiting') return 'playing';
	if (playerState === 'waiting') return 'waiting';
	if (inRoomCount > 0 || entries.length > 0) return 'lobby';
	return 'attract';
}

/**
 * ALL THREE dimensions must agree or the words sweep over a silent room: a paused song is still `current`, `isPlaying`
 * is the server's INTENT and stays true through an autoplay refusal, and `elementAdvancing` is the only honest signal.
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

export interface RosterMember {
	id: string;
	displayName: string;
	color: string;
	/** `here` holds a live socket; `away` is in the room but unreachable (locked phone, pocket). */
	state: 'here' | 'away';
}

const MAKING: ReadonlySet<MediaStatus> = new Set(['queued', 'downloading', 'separating', 'aligning']);

/** Does this `media:status` say the song is still being made AND past its estimate (`etaSec < 0`)? Anything else,
 *  a ready or failed song included, takes it off the overdue list. */
export function statusOverdue(e: { status: MediaStatus; etaSec?: number }): boolean {
	return MAKING.has(e.status) && (e.etaSec ?? 0) < 0;
}

/** Is any song still being made (`making`, the entries the lobby counts as pending) one core has called past its
 *  estimate? `overdueIds` holds the media ids whose last `media:status` was `statusOverdue`. */
export function lobbyOverdue(making: readonly QueueEntry[], overdueIds: ReadonlySet<string>): boolean {
	return making.some((e) => overdueIds.has(e.mediaId));
}

/**
 * The lobby's line under its headline. With a rehydrated queue but nobody reconnected the roster is empty, so it says
 * something true rather than "0 in the room". It says "pick a song", NOT "tap Turn": SongRow's actions are ICON-ONLY,
 * so naming a control sends a whole room looking for a label no phone displays. While something is processing it says
 * the wait is the karaoke being made, and once that song is `overdue` (`etaSec < 0`) it says what the singer's phone
 * says ("Taking longer than usual") instead of still promising a minute. With nothing being made and a turn stuck,
 * it is that turn's way out (`stuckTurnsLines`' `next`), never "pick a song" under a song that died.
 */
export function lobbyLine(count: number, processing: boolean, overdue: boolean, stuckNext?: string | null): string {
	if (processing) {
		const wait = overdue ? OVERDUE_LABEL.toLowerCase() : 'this takes a minute';
		return count > 0 ? `${count} in the room · making the karaoke, ${wait}` : `Making the karaoke — ${wait}`;
	}
	if (stuckNext) return stuckNext;
	return count > 0
		? `${count} in the room · search on your phone and pick a song`
		: 'Scan to join, then search on your phone and pick a song';
}

/**
 * `here` singers are listed BEFORE `away` ones, so a cap sheds the unreachable first: the chips worth showing are the
 * people who can take a turn right now. The overflow count is returned rather than rendered, so the caller words it.
 */
export function lobbyRoster(
	here: string[],
	away: string[],
	singers: Map<string, { id: string; displayName: string; color: string }>,
	max = 8
): { shown: RosterMember[]; overflow: number } {
	// A membership id with no directory entry yet (presence beat queue:sync) is SKIPPED rather than rendered as
	// "Someone": a nameless chip is worse than one fewer chip.
	const resolve = (ids: string[], state: 'here' | 'away'): RosterMember[] =>
		ids
			.map((id) => singers.get(id))
			.filter((s): s is { id: string; displayName: string; color: string } => !!s)
			.map((s) => ({ ...s, state }));
	const known = [...resolve(here, 'here'), ...resolve(away, 'away')];
	return { shown: known.slice(0, max), overflow: Math.max(0, known.length - max) };
}

/**
 * Unreachable: 127.0.0.0/8, `localhost`, `::1`, and any single-label host (a machine name a phone on the LAN cannot
 * resolve). Anything UNPARSEABLE is treated as REACHABLE, because a false "unreachable" hides a QR that works, which is
 * the worse error.
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
	// A dotted host or any IPv6 literal (contains ':') is assumed routable; a single label with no dot is a bare machine
	// name a phone on the LAN cannot resolve.
	if (!h.includes('.') && !h.includes(':')) return true;
	return false;
}

// The media model has FIVE stages (`MEDIA_STAGES`) and the takeover shows THREE, so the collapse is a real mapping held
// in ONE place or the wall and the phone describe the same song differently. Guest words.
export const PROCESS_STEPS = ['Downloaded', 'Removing vocals', 'Timing the lyrics'] as const;

/** TOTAL over every status — exactly one step is current, so the takeover can never render with none marked. */
export function processStep(status: MediaStatus | undefined): {
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
