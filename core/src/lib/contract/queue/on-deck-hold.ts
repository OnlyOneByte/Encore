// ON DECK IS HELD (proposal 14). PURE and shared, so the server's refusal, the phone's pinned row and both sides' add
// placement (`insertEntry`) agree on which entry is held. The hold exists while the On deck CARD shows: someone else is
// singing and this entry plays next. See docs/SERVER.md#queue-ordering-and-rotation.

/**
 * OPEN OWNER QUESTION: should the hold stay while the On deck singer's phone is away (locked, pocketed)? Today it
 * lifts, so a guest who left cannot stall the room. Flip this one line to keep the hold while away.
 */
const HOLD_LIFTS_WHILE_AWAY = true;

/**
 * The id of the entry the hold protects, or null. `next` is the room's next PLAYABLE entry; `nowSingerId` is whoever's
 * song is playing. Null in an idle room, when `next` is the current singer's own back-to-back song (no card shows for
 * it), and while its singer is away.
 */
export function heldEntryId(
	next: { id: string; singerId: string } | null | undefined,
	nowSingerId: string | null | undefined,
	isAway: (singerId: string) => boolean
): string | null {
	if (!next || !nowSingerId || next.singerId === nowSingerId) return null;
	if (HOLD_LIFTS_WHILE_AWAY && isAway(next.singerId)) return null;
	return next.id;
}
