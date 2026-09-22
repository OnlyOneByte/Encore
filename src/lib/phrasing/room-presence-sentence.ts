// The scanned-guest confirmation, in words (Q1-B). Pure and DOM-free so it unit-tests without
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
	/**
	 * The present singers' identity colours, in the same order as `names` — what the join screen's colour
	 * ring draws as hollow "already taken" pips.
	 *
	 * OPTIONAL, and deliberately so rather than for the convenience of the callers that build a preview
	 * in a test. It is the same courtesy `names` is: the COUNT is the authoritative fact this endpoint
	 * exists to state, and a consumer that has no use for the colours (the sentence below never reads
	 * them) must not be made to supply them. A caller reading a preview from an older server, or from a
	 * fixture written before this field existed, gets an empty ring rather than a crash — and an empty
	 * ring is a state the picker already has to render, because an empty room has no pips either.
	 */
	colors?: string[];
	/**
	 * How many of `presentCount` are AWAY rather than reachable — a locked phone, a pocket, a walk to the
	 * kitchen. They are in the room (that is what the grace window means, and it is why the name they hold
	 * is not free), so they are counted; this field is what lets the sentence avoid claiming they are
	 * standing in front of you.
	 *
	 * OPTIONAL for the same reason `colors` is: the COUNT is the authoritative fact, and a preview from an
	 * older server or a fixture written before this field existed must still produce a sentence. Absent is
	 * read as 0 — i.e. "everyone counted is reachable", which is the shape this endpoint used to have.
	 */
	awayCount?: number;
}

/**
 * A sentence naming the room by its people. Never re-presents the code (that is the thing
 * rules out once the guest has arrived).
 *
 *   0 present  → "This room is empty right now — you'll be the first here."
 *   1, named   → "Maya is here."
 *   2, named   → "Maya and Dana are here."
 *   3, named   → "Maya, Dana and Lee are here."
 *   5, 2 named → "5 people here, including Maya and Dana."
 *   n, 0 named → "6 people here." (count known, names withheld/unavailable)
 *
 * ── AND WHEN EVERYONE COUNTED IS AWAY ────────────────────────────────────────────────────────────
 *
 *   1, named   → "Maya is in the room, away right now."
 *   2, named   → "Maya and Dana are in the room, away right now."
 *   4, 0 named → "4 people in the room, all away right now."
 *
 * That branch exists because the alternative is a lie in one direction or the other. Away members hold
 * their names (the grace window is why `assertNameFree` refuses them), so they MUST be counted — a room
 * that reports itself empty and then rejects your name is the defect `/api/room-preview` was carrying.
 * But "Maya is here." about someone whose phone is asleep is the same overclaim in reverse, and the TV's
 * roster is meanwhile rendering "Maya AWAY" to the same party. "away right now" is the wall's own word,
 * so the two surfaces agree.
 *
 * A MIXED room needs no special case: somebody reachable IS here, and the away members are the
 * difference between the count and the names — which the count already carries.
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
