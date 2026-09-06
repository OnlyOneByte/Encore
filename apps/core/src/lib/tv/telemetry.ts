// The TV's telemetry FRAME, as a pure function — the half of #70/#125 that lives on the client.
//
// WHY THIS EXISTS. #70 and #125 are one fix split across the wire: the server (player.ts) drops a
// telemetry frame whose `entryId` is no longer the current entry, so a stale/duplicate `ended` can no
// longer double-advance (#70) and an outgoing song's late position frame can no longer overwrite the
// incoming singer's playhead (#125). That guard is written `t.entryId !== undefined && …`, so it does
// nothing at all on a frame that carries NO id — it silently falls back to the pre-#70 unconditional
// behaviour. The guard therefore only bites when the TV actually STAMPS the entry on every frame.
//
// The server half has real tests. The client half — the stamp — used to live inline in
// `+page.svelte`'s `sendTelemetry`, reachable only by a browser or by scanning the .svelte source for
// a literal string. A source-scan reddens on a harmless rename and stays green on a subtle logic
// change; it never runs the code. Lifting the frame here — matching how `guide-sync.ts`, `gapless.ts`
// and `lib/ws/send.ts` hold the TV's other decisions as pure, unit-tested functions — makes the stamp
// machine-checkable BEHAVIOURALLY: telemetry.test.ts asserts the produced frame, so a refactor that
// stops stamping reddens a test that executed the stamping, not one that grepped for it.

/** The minimal slice of the currently-playing entry this frame needs: just its id. */
export interface StampableEntry {
	id: string;
}

/** The `tv:telemetry` wire frame (packages/shared events.ts). Kept in sync with that ClientEvent variant. */
export interface TelemetryFrame {
	type: 'tv:telemetry';
	positionSec: number;
	durationSec: number;
	status: string;
	bufferedNextPct: number;
	/**
	 * The entry the TV was playing when this frame was produced — stamped on EVERY frame, not just
	 * `ended`, because the server's drop fires on both the `ended` path (#70) and the position path
	 * (#125) and both need to tell a live frame from a stale one. `undefined` when nothing is playing;
	 * an id-less frame keeps the server's legacy behaviour so an older cached TV is unaffected.
	 */
	entryId?: string;
}

/**
 * Build the telemetry frame the TV sends to the server. Stamps `current.id` on EVERY frame; leaves
 * `entryId` off only when nothing is playing (`current` is `null`). The status is passed through
 * verbatim — the server derives `ended` from `status === 'ended'` at dispatch, not from a client flag.
 */
export function telemetryFrame(
	status: string,
	current: StampableEntry | null,
	positionSec = 0,
	durationSec = 0,
	bufferedNextPct = 0
): TelemetryFrame {
	return {
		type: 'tv:telemetry',
		positionSec,
		durationSec,
		status,
		bufferedNextPct,
		entryId: current?.id ?? undefined
	};
}
