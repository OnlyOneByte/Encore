/*
 * THE JOIN ADDRESS AS A PERSON READS IT OFF A WALL — one function, because three files were spelling
 * it three different ways.
 *
 * The stored value is a full URL (`http://10.20.36.198:3500/?room=9DJECR`, built in
 * routes/tv/+page.server.ts). What a guest needs is the shortest string they can retype from a sofa,
 * and the QR beside it already carries the real target, so nothing is lost by trimming. Three sites
 * had each derived that independently and none of them agreed:
 *
 *   routes/tv/+page.svelte   scheme off, then query off again for the attract panel   → `host:port/`
 *   lib/tv/TvLobby.svelte    scheme off, query off                                    → `host:port/`
 *   lib/tv/JoinBadge.svelte  scheme off ONLY                                          → `host:port/?room=CODE`
 *
 * So the corner badge printed the redundant `?room=CODE` its own comment says is too long to read
 * across a room, and the other two printed a bare trailing slash — on the single most-transcribed
 * string in the product, at 44px, on a ten-foot screen. A slash with nothing after it reads as a path
 * that got cut off, which is the one impression this line cannot afford.
 *
 * `?room=CODE` is dropped rather than kept because the attract panel prints the room code as its own
 * largest element and the lobby has no room for a second line: a guest types the host and enters the
 * code they can already see. Both callers had reached that conclusion separately.
 */

/**
 * `http://10.20.36.198:3500/?room=9DJECR` -> `10.20.36.198:3500`.
 *
 * Scheme, query and a lone trailing slash removed. A REAL path is preserved — a deployment served
 * under a sub-path has to show it or the address does not work — so only a slash with nothing behind
 * it is trimmed.
 */
export function joinAddressLabel(joinUrl: string): string {
	return joinUrl
		.replace(/^https?:\/\//, '')
		.replace(/[?#].*$/, '')
		.replace(/\/$/, '');
}
