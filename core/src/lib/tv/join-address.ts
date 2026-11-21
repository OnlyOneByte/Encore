// THE JOIN ADDRESS AS A PERSON READS IT OFF A WALL — the one speller for every surface that prints it.
import { SETTINGS_SCOPES } from '$lib/settings-scopes';

/** The host's notice for an address no phone can open (`isUnreachableJoinOrigin`). The TV's empty-room screens and
 *  /settings/server say this same line, so the two cannot drift. */
export const UNREACHABLE_JOIN = 'Phones can’t open this address';
/** The TV's remedy line. Settings omits it: the field that fixes it is right there. An ASCII `->`, never a
 *  typographic arrow: a smart-TV browser may have no glyph for it (see `song-facts.ts`). The page name is the
 *  scope's own label, so renaming the page cannot leave the TV pointing at a name that no longer exists. */
export const UNREACHABLE_JOIN_FIX = `Fix it in Settings -> ${SETTINGS_SCOPES.server.label}`;

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
