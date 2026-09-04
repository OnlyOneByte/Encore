// Membership — who is IN THE ROOM, which is not the same question as who has a socket open.
//
// Encore used to have one concept doing both jobs: a singer was "present" iff their live socket count
// was > 0, and the TV roster read straight off that. The only liveness signal in the whole WS path is
// Bun's `idleTimeout`, so locking your phone took you out of the party in ~30 seconds — while you were
// standing right there holding a microphone.
//
// So membership is a POLICY over transport facts, and it is three-valued:
//
//   here  — a live socket. They are unambiguously in the room.
//   away  — no socket, but still in the room. A locked phone, a pocket, a dead battery, a walk to the
//           kitchen. Shown greyed rather than erased, and still counted.
//   gone  — no socket and the grace window has expired. Drops off the roster; their name returns to
//           the pool.
//
// The grace clock deliberately does NOT start when the socket drops. It starts once they hold no
// pending songs, because a queued song is a stake in the room: someone with three songs coming up has
// not left, whatever their phone is doing. Songs drain on their own (they play, or the room skips
// them), so the stake is self-liquidating and the clock always eventually runs.
//
// Pure so it unit-tests as a truth table; the server owns the clock's storage and the sweep that
// advances it.

/** A room setting, not a constant — 90 minutes is only the default. */
export const DEFAULT_PRESENCE_GRACE_MINUTES = 90;
export const MIN_PRESENCE_GRACE_MINUTES = 0;
export const MAX_PRESENCE_GRACE_MINUTES = 1440;

export type MemberState = 'here' | 'away' | 'gone';

export interface MemberFacts {
	/** Live sockets held by this singer. Ref-counted, so two tabs is one member with two sockets. */
	sockets: number;
	/**
	 * When their last socket closed (epoch ms). `undefined` means this process has never seen them —
	 * which is also the state after a restart, since membership is process-lifetime.
	 */
	awaySince?: number;
	/**
	 * When their grace clock started (epoch ms). `undefined` = not started, because they still hold
	 * pending songs or because the sweep has not reached them yet.
	 */
	clockStartedAt?: number;
	/** At least one queued or playing entry of theirs is still in the queue. */
	hasPendingSongs: boolean;
}

/**
 * Resolve one singer's membership.
 *
 * `graceMs` of 0 means "no grace once your songs are done" — NOT "vanish the instant your socket
 * drops". Pending songs hold you in the room at every setting, because that rule is what makes the
 * clock meaningful in the first place.
 */
export function memberState(facts: MemberFacts, now: number, graceMs: number): MemberState {
	if (facts.sockets > 0) return 'here';
	// Never seen (or already forgotten): not a member. Same answer as the old socket-count model gave
	// for anyone without a socket, which is what keeps a restarted server's roster empty until phones
	// reconnect rather than inventing members it cannot vouch for.
	if (facts.awaySince === undefined) return 'gone';
	if (facts.hasPendingSongs) return 'away';
	if (facts.clockStartedAt === undefined) return 'away';
	return now - facts.clockStartedAt >= graceMs ? 'gone' : 'away';
}

/** Whether this singer's grace clock should be started now. */
export function shouldStartClock(facts: MemberFacts): boolean {
	return facts.sockets === 0 && facts.awaySince !== undefined && !facts.hasPendingSongs && facts.clockStartedAt === undefined;
}

/** Whether a started clock should be cleared again — they reconnected, or re-queued a song. */
export function shouldClearClock(facts: MemberFacts): boolean {
	return facts.clockStartedAt !== undefined && (facts.sockets > 0 || facts.hasPendingSongs);
}

export const graceMsOf = (minutes: number): number => Math.max(0, minutes) * 60_000;
