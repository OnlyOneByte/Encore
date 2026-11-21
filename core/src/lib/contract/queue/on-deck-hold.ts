// ON DECK IS HELD (proposal 14). PURE and shared, so the server's refusal, the phone's pinned row and both sides' add
// placement (`insertEntry`) agree on which entry is held. The hold exists while the On deck CARD shows: someone else is
// singing and this entry plays next. See docs/SERVER.md#queue-ordering-and-rotation.

/**
 * THE OWNER'S RULING: the hold STAYS while the On deck singer's phone is away (locked, pocketed) — setting a key and
 * putting the phone down is exactly the guest it protects. It cannot stall the room: the held song still plays when its
 * turn comes (and can be skipped then), leaving the room removes it (`doLeave`), and its owner's Not yet moves it.
 */
const HOLD_LIFTS_WHILE_AWAY = false;

/**
 * The id of the entry the hold protects, or null. `next` is the room's next PLAYABLE entry; `nowSingerId` is whoever's
 * song is playing. Null in an idle room and when `next` is the current singer's own back-to-back song (no card shows
 * for it). Away does not lift it (`HOLD_LIFTS_WHILE_AWAY`).
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
