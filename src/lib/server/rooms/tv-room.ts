// One TV per room — resolves which room a `role=tv` socket binds to. A phone's scope comes from its session token (a singer maps to exactly one room_id); a TV has neither a singer nor a cookie, so its scope comes from the join CODE instead — the same handle the QR encodes and /join reads, resolved by the TV route and passed on the WS URL. The fallback is deliberate: an ABSENT or UNKNOWN code resolves to activeRoomId (today's spectator behaviour) rather than binding to nothing and going dark; a KNOWN code binds the TV to that specific party, and a TV bound to a non-served room is correctly foreign since it has no state to show here yet.

/**
 * The room id a `role=tv` socket binds to: the coded room when the code names a real room, otherwise
 * `activeRoomId` — never undefined, since a TV is always bound to exactly one room.
 * @param roomCode the join code the TV was pointed at (`?room=<code>`), or null/empty for a bare /tv.
 * @param byCode the room repository code lookup (`rooms.byCode`), returning the room or null.
 * @param activeRoomId the room this core is serving — the fallback for an absent or unknown code.
 */
export function tvRoomId(
	roomCode: string | null | undefined,
	byCode: (code: string) => { id: string } | null,
	activeRoomId: string
): string {
	if (!roomCode) return activeRoomId;
	return byCode(roomCode)?.id ?? activeRoomId;
}
