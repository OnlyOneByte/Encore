// The role=worker upgrade gate's comparison. Constant-time: both sides are hashed first so
// timingSafeEqual always sees two equal-length buffers, and an absent token is just a mismatch.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Same floor as the host key: a short token is one a LAN device could guess, then fabricate job results. */
export const WORKER_TOKEN_MIN = 24;

/** Why `ENCORE_WORKER_TOKEN` cannot be used, or null when it is unset or long enough. */
export function workerTokenProblem(raw: string | null | undefined): string | null {
	const token = raw?.trim();
	if (!token || token.length >= WORKER_TOKEN_MIN) return null;
	return `ENCORE_WORKER_TOKEN is ${token.length} characters; it must be at least ${WORKER_TOKEN_MIN}. Make a random one with \`openssl rand -base64 24\` and set the same value on core and every worker.`;
}

export function workerTokenMatches(presented: string | null, expected: string): boolean {
	return presented !== null && timingSafeEqual(digest(presented), digest(expected));
}
