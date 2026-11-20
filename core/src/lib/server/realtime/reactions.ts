// `room:react` intake: a guest's cheer for whoever is singing, shown on the TV and nowhere else. Fire-and-forget
// by design — a tap that is refused or rate-limited gets no reply, because there is nothing a guest could do
// about one, and nothing about a reaction is persisted (the `plays` table stays singer-free on purpose).

import { isReactionKind, type ReactionKind, type ServerEvent } from '../../contract';

/** Three taps land at once; after that, one per second. Enough to cheer a high note, too slow to wallpaper the TV. */
export const REACTION_BURST = 3;
export const REACTION_REFILL_PER_SEC = 1;

/**
 * A token bucket per singer. `now` is injected so a test drives the clock rather than sleeping on it.
 * shortcut: one entry per singer who ever reacted, never pruned — a party is tens of singers, not thousands.
 */
export function createReactionLimiter(now: () => number = Date.now) {
	const buckets = new Map<string, { tokens: number; at: number }>();
	return {
		/** Spends a token and answers whether this tap may go out. */
		take(singerId: string): boolean {
			const t = now();
			const b = buckets.get(singerId) ?? { tokens: REACTION_BURST, at: t };
			b.tokens = Math.min(REACTION_BURST, b.tokens + ((t - b.at) / 1000) * REACTION_REFILL_PER_SEC);
			b.at = t;
			const ok = b.tokens >= 1;
			if (ok) b.tokens -= 1;
			buckets.set(singerId, b);
			return ok;
		}
	};
}

export type ReactionLimiter = ReturnType<typeof createReactionLimiter>;

export interface ReactionDeps {
	/** From the session at WS upgrade, never from the frame. */
	actorSingerId: string | undefined;
	/** The singer on stage right now, or null when nothing is playing. */
	currentSingerId: string | null;
	/** Read LAST, after the bucket, so a tap the bucket drops never costs the settings read behind it. */
	isEnabled: () => boolean;
	colorOf: (singerId: string) => string | null;
	limiter: ReactionLimiter;
	/** Publishes on `roomTvTopic` ONLY. There is deliberately no room-wide `publish` in these deps. */
	publishToTv: (event: Extract<ServerEvent, { type: 'room:reacted' }>) => void;
}

/** Why a reaction is refused before the bucket, or null. In-memory checks only, so a refused tap costs no token. */
export function reactionRefusal(
	kind: unknown,
	deps: Omit<ReactionDeps, 'publishToTv' | 'limiter' | 'isEnabled'>
): string | null {
	if (!deps.actorSingerId) return 'join the room first';
	if (!isReactionKind(kind)) return 'unknown reaction';
	if (!deps.currentSingerId) return 'nobody is singing';
	// The phone hides the row from the singer; this keeps a stale phone from cheering itself.
	if (deps.currentSingerId === deps.actorSingerId) return 'you are the one singing';
	if (!deps.colorOf(deps.actorSingerId)) return 'unknown singer';
	return null;
}

/** Returns whether the reaction was sent to the TV. */
export function handleReaction(kind: unknown, deps: ReactionDeps): boolean {
	if (reactionRefusal(kind, deps) !== null) return false;
	const singerId = deps.actorSingerId!;
	if (!deps.limiter.take(singerId)) return false;
	if (!deps.isEnabled()) return false;
	deps.publishToTv({ type: 'room:reacted', singerId, kind: kind as ReactionKind, color: deps.colorOf(singerId)! });
	return true;
}
