// The scanned-guest confirmation, in words (XR-PH-14, Q1-B). Pure and DOM-free so it unit-tests without
// a browser: the "confirmed in words" acceptance is a string property, and it is the one thing this
// screen must get right for a guest who cannot see the QR they scanned.
//
// Rooms have no name (see /api/room-preview), so "confirmed in words" means "who is here", never the
// code. The count is authoritative; names are a courtesy that degrade gracefully as they run out.

/** Shape of GET /api/room-preview's success body. */
export interface RoomPreview {
	code: string;
	presentCount: number;
	names: string[];
}

/**
 * A sentence naming the room by its people. Never re-presents the code (that is the thing XR-PH-14
 * rules out once the guest has arrived).
 *
 *   0 present  → "This room is empty right now — you'll be the first here."
 *   1, named   → "Maya is here."
 *   2, named   → "Maya and Dana are here."
 *   3, named   → "Maya, Dana and Lee are here."
 *   5, 2 named → "5 people here, including Maya and Dana."
 *   n, 0 named → "6 people here." (count known, names withheld/unavailable)
 */
export function roomPresenceSentence(preview: RoomPreview): string {
	const count = Math.max(0, preview.presentCount);
	const names = preview.names.slice(0, count);

	if (count === 0) return "This room is empty right now — you'll be the first here.";

	// Count known but no names to show: state the count plainly.
	if (names.length === 0) return `${count} ${people(count)} here.`;

	// Every present singer is named and the list is short enough to read as a sentence.
	if (names.length === count && count <= 3) {
		return `${joinNames(names)} ${isAre(count)} here.`;
	}

	// More people than we name, or a long room: lead with the count, then a few names.
	return `${count} ${people(count)} here, including ${joinNames(names)}.`;
}

function people(n: number): string {
	return n === 1 ? 'person' : 'people';
}

function isAre(n: number): string {
	return n === 1 ? 'is' : 'are';
}

/** "A", "A and B", "A, B and C" — a serial list with an Oxford-free final "and". */
function joinNames(names: string[]): string {
	if (names.length === 1) return names[0]!;
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
