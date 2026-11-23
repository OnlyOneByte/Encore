// The ONE wording for a list row's icon and word buttons as a screen reader hears them. A list renders the same
// buttons once per row, so a name without the song is the same name N times: in a screen reader's list of buttons
// every row's "remove from queue" was identical. Each name carries the song, and a WORD button's name starts with
// its visible text (SC 2.5.3), so a voice user can still say what they see.

/** The song as a row shows it: the title, and the artist when the row shows one. */
export function songRef(title: string, artist?: string | null): string {
	return artist ? `${title} by ${artist}` : title;
}

/** The ✕ on a queue row or processing card. */
export function removeTurnName(title: string): string {
	return `Remove ${title} from the queue`;
}

/** The drag grip, which also takes Arrow Up/Down. */
export function reorderName(title: string): string {
	return `Reorder ${title} — drag, or use arrow keys`;
}

/** "Try again" on a held or dead turn. */
export function tryAgainName(title: string): string {
	return `Try again for ${title}`;
}

/** "Pick another" on a held or dead turn. */
export function pickAnotherName(title: string): string {
	return `Pick another instead of ${title}`;
}

/** The keycaps on the Now singing and On deck cards, which can sit on one screen. */
export function keyStepName(step: -1 | 1, title: string): string {
	return `${step < 0 ? 'Lower' : 'Raise'} ${title} by one semitone`;
}
