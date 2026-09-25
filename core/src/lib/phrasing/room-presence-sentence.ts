// The scanned-guest confirmation, in words. Pure and DOM-free, because the sentence IS the requirement. Rooms have no
// name, so "confirmed in words" means WHO IS HERE, never the code. The COUNT is authoritative; names are a courtesy.

/** Shape of GET /api/room-preview's success body. */
export interface RoomPreview {
	code: string;
	presentCount: number;
	names: string[];
	/** The present singers' identity colours, in the same order as `names` — the colour ring's "already taken" pips.
	 * OPTIONAL: only the count is authoritative, and an absent list is an empty ring, which the picker already renders. */
	colors?: string[];
	/** How many of `presentCount` are AWAY rather than reachable. They are still COUNTED — the grace window holds their
	 * names — and this is what lets the sentence avoid claiming they are in front of you. Absent reads as 0. */
	awayCount?: number;
}

/**
 * A sentence naming the room by its people, and never re-presenting the code. THE ALL-AWAY BRANCH exists because the
 * alternative is a lie in one direction or the other: away members hold their names so they MUST be counted, but saying
 * someone is "here" when their phone is asleep is the same overclaim in reverse. "away right now" is the wall's own
 * word, so the two surfaces agree. A MIXED room needs no special case: somebody reachable IS here.
 */
export function roomPresenceSentence(preview: RoomPreview): string {
	const count = Math.max(0, preview.presentCount);
	const names = preview.names.slice(0, count);
	const away = Math.min(Math.max(0, preview.awayCount ?? 0), count);

	if (count === 0) return "This room is empty right now — you'll be the first here.";

	// Nobody reachable, but the room still holds their names and colours.
	if (away === count) {
		if (names.length === 0) {
			return count === 1 ? '1 person in the room, away right now.' : `${count} people in the room, all away right now.`;
		}
		if (names.length === count && count <= 3) {
			return `${joinNames(names)} ${isAre(count)} in the room, away right now.`;
		}
		return `${count} ${people(count)} in the room, all away right now, including ${joinNames(names)}.`;
	}

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
