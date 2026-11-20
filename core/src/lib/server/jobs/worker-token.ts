// The role=worker upgrade gate's comparison. Constant-time: both sides are hashed first so
// timingSafeEqual always sees two equal-length buffers, and an absent token is just a mismatch.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s: string) => createHash('sha256').update(s).digest();

export function workerTokenMatches(presented: string | null, expected: string): boolean {
	return presented !== null && timingSafeEqual(digest(presented), digest(expected));
}
