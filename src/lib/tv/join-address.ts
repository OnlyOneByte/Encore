// THE JOIN ADDRESS AS A PERSON READS IT OFF A WALL — the one speller for every surface that prints it.

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
