// Membership — who is IN THE ROOM, which is NOT who holds a socket: conflating them drops a singer seconds
// after their phone locks. A three-valued POLICY over transport facts — `here` (live socket), `away` (no
// socket, still counted, shown greyed), `gone` (grace expired, name back in the pool).
//
// THE GRACE CLOCK DOES NOT START WHEN THE SOCKET DROPS. It starts once the singer holds no pending songs,
// because a queued song is a stake in the room — and a self-liquidating one, so the clock always eventually
// runs. Pure; the server owns the clock's storage and the sweep that advances it.

/** A room setting, not a constant — this is only the default. */
export const DEFAULT_PRESENCE_GRACE_MINUTES = 90;
export const MIN_PRESENCE_GRACE_MINUTES = 0;
export const MAX_PRESENCE_GRACE_MINUTES = 1440;

export type MemberState = 'here' | 'away' | 'gone';

export interface MemberFacts {
	/** Live sockets held by this singer. Ref-counted, so two tabs is one member with two sockets. */
	sockets: number;
	/** When their last socket closed. `undefined` means this process has never seen them, which is also the
	 *  state after a restart, since membership is process-lifetime. */
	awaySince?: number;
	/** When their grace clock started. `undefined` = not started, because they still hold pending songs or
	 *  the sweep has not reached them. */
	clockStartedAt?: number;
	/** At least one queued or playing entry of theirs is still in the queue. */
	hasPendingSongs: boolean;
}

/**
 * Resolve one singer's membership. `graceMs` of 0 means "no grace ONCE YOUR SONGS ARE DONE" and never
 * "vanish the instant your socket drops": pending songs hold a singer in the room at every setting, which is
 * what makes the clock meaningful at all.
 */
export function memberState(facts: MemberFacts, now: number, graceMs: number): MemberState {
	if (facts.sockets > 0) return 'here';
	// Never seen, or already forgotten: not a member. This keeps a restarted server's roster empty until
	// phones reconnect, rather than inventing members it cannot vouch for.
	if (facts.awaySince === undefined) return 'gone';
	if (facts.hasPendingSongs) return 'away';
	if (facts.clockStartedAt === undefined) return 'away';
	return now - facts.clockStartedAt >= graceMs ? 'gone' : 'away';
}

/** Whether this singer's grace clock should be started now. */
export function shouldStartClock(facts: MemberFacts): boolean {
	return (
		facts.sockets === 0 && facts.awaySince !== undefined && !facts.hasPendingSongs && facts.clockStartedAt === undefined
	);
}

/** Whether a started clock should be cleared again — they reconnected, or re-queued a song. */
export function shouldClearClock(facts: MemberFacts): boolean {
	return facts.clockStartedAt !== undefined && (facts.sockets > 0 || facts.hasPendingSongs);
}

export const graceMsOf = (minutes: number): number => Math.max(0, minutes) * 60_000;
