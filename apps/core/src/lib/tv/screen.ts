// Which of the TV's idle screens to show.
//
// Before this, `/tv` collapsed every non-playing situation into ONE attract screen: an empty room
// and a room with four people waiting for a first pick looked identical, so the TV could not tell
// anyone what it was waiting for. The distinction is entirely derivable from state the TV already
// holds — no new server round-trip.
//
// Pure (no Svelte, no DOM) so the precedence rules are unit-testable; `+page.svelte` renders it.

import type { QueueEntry } from '@encore/shared';

/**
 * What the TV should be showing.
 * - `attract`  — nobody is here. The QR is the only thing to do, so it owns the screen.
 * - `lobby`    — people are here, or something is queued, but nothing can play yet. Note this covers
 *                TWO situations the caller must word differently: nothing picked at all, and something
 *                picked that is still cooking. It previously claimed "nothing is queued", which was
 *                wrong — a queued-but-unplayable entry lands here too, and the lobby told guests to
 *                pick a song when one was already separating.
 * - `waiting`  — the PLAYER is actively holding for media that is still cooking (mid-set), which is a
 *                narrower thing than "something queued is not ready".
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
	/**
	 * How many singers are IN THE ROOM — holding a socket *or* away with one still counted. Not the
	 * socket count: a room where everyone has pocketed their phone is still a room with people in it,
	 * and treating it as empty is what used to send the TV back to the attract screen mid-party.
	 */
	inRoomCount: number;
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
	const { playerState, current, entries, inRoomCount } = input;
	if (current && playerState !== 'waiting') return 'playing';
	if (playerState === 'waiting') return 'waiting';
	if (inRoomCount > 0 || entries.length > 0) return 'lobby';
	return 'attract';
}

/**
 * Should the lyrics reel and ball ADVANCE right now?
 *
 * `LyricsOverlay` extrapolates position from wall-clock while its `playing` prop is true. The screen
 * being `playing` is necessary but NOT sufficient, and NEITHER is the room's play/pause intent:
 *
 *   • `isPlaying` is what the SERVER says the room is doing (`playback:state.isPlaying`). It closes
 *     the pause-from-the-phone case (Bug B): a paused song is still `current`, so the screen stays
 *     `playing`, and without this the reel scrolled with the audio frozen.
 *   • `elementAdvancing` is whether the MASTER ELEMENT is actually running — the honest signal the
 *     page reports up from the <audio>'s own play/pause (#393). The room can INTEND to play while the
 *     element is not: a TV wall's autoplay is refused (`NotAllowedError`, the room silent behind the
 *     "tap to start" hint), or the current entry's media is not playable / its src has not landed
 *     (`transportFor` returns `idle`), and the server still says `isPlaying: true`. In every one of
 *     those the reel used to sweep to 90s into a song whose element never started — silent room,
 *     scrolling words. Both dimensions must agree before the words move.
 *
 * Advancing is distinct from VISIBLE — the overlay stays on screen while paused or silent (frozen
 * mid-line), so the caller keeps passing `visible` on the same `screen`/`tvState` condition and only
 * feeds the ADVANCING signal through here.
 */
export function lyricsAdvancing(
	screen: TvScreen,
	tvState: string,
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
 * Build the lobby roster: everyone in the room, capped so a big party cannot push chips over the rest
 * of the screen. The overflow count is returned rather than rendered so the caller decides the wording.
 *
 * `here` singers are listed before `away` ones, so the cap sheds the unreachable first: if only eight
 * chips fit, the eight worth showing are the people who can actually take a turn right now.
 */
export function lobbyRoster(
	here: string[],
	away: string[],
	singers: Map<string, { id: string; displayName: string; color: string }>,
	max = 8
): { shown: RosterMember[]; overflow: number } {
	// A membership id with no directory entry yet (presence arrived before queue:sync) is skipped
	// rather than rendered as "Someone" — a nameless chip is worse than one fewer chip.
	const resolve = (ids: string[], state: 'here' | 'away'): RosterMember[] =>
		ids
			.map((id) => singers.get(id))
			.filter((s): s is { id: string; displayName: string; color: string } => !!s)
			.map((s) => ({ ...s, state }));
	const known = [...resolve(here, 'here'), ...resolve(away, 'away')];
	return { shown: known.slice(0, max), overflow: Math.max(0, known.length - max) };
}

/**
 * Is this join origin one that no phone in the room could actually reach?
 *
 * The join address is derived from the request host, so opening `/tv` ON the serving machine puts
 * `http://127.0.0.1:PORT/join` (or `localhost`, a bare hostname, or an IPv6 loopback) on the wall.
 * Every scan then fails silently — the phone cannot route to the TV's own loopback — with nothing in
 * the room explaining why. The TV renders an operator notice instead of a working-looking QR when this
 * returns true.
 *
 * Pure and string-only (no DOM, no `URL` global assumptions beyond the constructor) so the rule is
 * unit-testable. Anything it cannot parse is treated as REACHABLE: a false "unreachable" would hide a
 * QR that actually works, which is worse than showing one that might not.
 *
 * Unreachable hosts:
 *  - the IPv4 loopback block 127.0.0.0/8 (127.0.0.1 … 127.255.255.255)
 *  - `localhost` (any case)
 *  - the IPv6 loopback `::1`
 *  - a single-label host with no dot (e.g. `wsl`, a machine name) — not resolvable off-box by a phone
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
