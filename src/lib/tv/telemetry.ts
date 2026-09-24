// The server drops a frame whose `entryId` is no longer the current entry, which is what stops a stale `ended`
// double-advancing and an outgoing song's late position frame overwriting the incoming singer's playhead. That guard is
// CONDITIONAL on the id being present, so it bites only while the TV stamps every frame.

/** The minimal slice of the currently-playing entry this frame needs: just its id. */
export interface StampableEntry {
	id: string;
}

/** The `tv:telemetry` wire frame (src/lib/contract events.ts). Kept in sync with that ClientEvent variant. */
export interface TelemetryFrame {
	type: 'tv:telemetry';
	positionSec: number;
	status: string;
	/** `undefined` when nothing is playing; an id-less frame keeps the legacy behaviour for an older cached TV. */
	entryId?: string;
}

/** The status is passed through VERBATIM: the server derives `ended` from it at dispatch, not from a client flag. */
export function telemetryFrame(status: string, current: StampableEntry | null, positionSec = 0): TelemetryFrame {
	return {
		type: 'tv:telemetry',
		positionSec,
		status,
		entryId: current?.id ?? undefined
	};
}
