// THE JOIN ADDRESS AS A PERSON READS IT OFF A WALL — the one speller for every surface that prints it.

/** The host's notice for an address no phone can open (`isUnreachableJoinOrigin`). The TV's empty-room screens and
 *  /settings/server say this same line, so the two cannot drift. */
export const UNREACHABLE_JOIN = 'Phones can’t open this address';
/** The TV's remedy line. Settings omits it: the field that fixes it is right there. */
export const UNREACHABLE_JOIN_FIX = 'Fix it in Settings → This machine';

/**
 * `http://10.20.36.198:3500/?room=9DJECR` -> `10.20.36.198:3500`. A REAL path is PRESERVED, because a deployment under a
 * sub-path has to show it, so only a slash with nothing behind it is trimmed: a bare trailing slash at 44px on a
 * ten-foot screen reads as a path that got cut off.
 */
export function joinAddressLabel(joinUrl: string): string {
	return joinUrl
		.replace(/^https?:\/\//, '')
		.replace(/[?#].*$/, '')
		.replace(/\/$/, '');
}
