// THE JOIN ADDRESS AS A PERSON READS IT OFF A WALL. The one speller for every surface that prints it, so
// the most-transcribed string in the product cannot disagree with itself across three screens.

/**
 * `http://10.20.36.198:3500/?room=9DJECR` -> `10.20.36.198:3500`.
 *
 * `?room=CODE` goes because the room code is already printed as its own largest element and the QR beside it
 * carries the real target. A REAL path is preserved — a deployment under a sub-path has to show it — so only
 * a slash with nothing behind it is trimmed; a bare trailing slash at 44px on a ten-foot screen reads as a
 * path that got cut off.
 */
export function joinAddressLabel(joinUrl: string): string {
	return joinUrl
		.replace(/^https?:\/\//, '')
		.replace(/[?#].*$/, '')
		.replace(/\/$/, '');
}
