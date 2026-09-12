// One TV per room — the ONE place that answers "which room does THIS TV show, and bind to?".
//
// Before this resolver the TV was an unscoped SPECTATOR (room-scope.ts): it carried no roomId, so at the WS
// upgrade subscribeTopicFor(undefined, activeRoomId) always dropped it onto the SERVED room topic.
// That is fine while a box serves exactly one room, but it means a TV can only ever show
// app.activeRoomId — it does not RESOLVE which room it is showing, it inherits the singleton. The
// rooms chain that preceded it made playback, the queue and the wire per-room; the last gap is that a
// TV cannot be pointed at a SPECIFIC party. This resolver closes it by giving a TV socket a real room scope.
//
// A phone gets its scope from its session token (a singer maps to exactly one room_id). A
// TV has no singer and no cookie, so its scope has to come from somewhere it CAN carry: the join CODE,
// the same short human-typeable handle the QR already encodes and /join reads. The TV route
// resolves the code it should show (the served room code, or an explicit ?room=<code>) and passes it
// on the WS URL; this resolver turns that code into the room id the socket binds to.
//
// The fallback is deliberate and load-bearing: an ABSENT or UNKNOWN code resolves to activeRoomId,
// which is exactly today spectator behaviour — a bare /tv with no room, or a code for a room this box
// does not have, still shows the one room the box serves rather than binding to nothing and going
// dark. A KNOWN code binds the TV to that room, so a TV can be aimed at a specific party. When a later
// milestone runs several rooms state in one process, that binding is what lets each screen show its
// own room; today, with one served room, a TV bound to the served room is IN-ROOM (not foreign) and a
// TV bound to a non-served room is correctly foreign — it has no state to show here yet.

/**
 * The room id a `role=tv` socket binds to.
 *
 * @param roomCode  the join code the TV was pointed at (`?room=<code>`), or null/empty for a bare /tv.
 * @param byCode    the room repository code lookup (`rooms.byCode`), returning the room or null.
 * @param activeRoomId  the room this core is serving — the fallback for an absent or unknown code.
 *
 * Returns the resolved room id: the coded room when the code names a real room, otherwise the served
 * room. Never returns undefined — a TV is always bound to exactly one room (one TV, one room), never
 * left an unscoped spectator once this resolver is wired.
 */
export function tvRoomId(
	roomCode: string | null | undefined,
	byCode: (code: string) => { id: string } | null,
	activeRoomId: string
): string {
	if (!roomCode) return activeRoomId;
	return byCode(roomCode)?.id ?? activeRoomId;
}
