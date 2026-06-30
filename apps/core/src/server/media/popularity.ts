// Zero-keystroke shortcuts: track what's been queued this session so the phone can offer
// "recently queued" + "popular tonight" without typing. In-memory (session-scoped); resets on
// restart, which is the right lifetime for a party.

export interface PopularityTracker {
	recordAdd(mediaId: string, at: number): void;
	recent(limit: number): string[]; // mediaIds, most-recent first
	popular(limit: number): string[]; // mediaIds, most-queued first
}

export function createPopularityTracker(): PopularityTracker {
	const counts = new Map<string, number>();
	const lastAt = new Map<string, number>();

	return {
		recordAdd(mediaId, at) {
			counts.set(mediaId, (counts.get(mediaId) ?? 0) + 1);
			lastAt.set(mediaId, at);
		},
		recent(limit) {
			return [...lastAt.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, limit)
				.map(([id]) => id);
		},
		popular(limit) {
			return [...counts.entries()]
				.sort((a, b) => b[1] - a[1] || (lastAt.get(b[0]) ?? 0) - (lastAt.get(a[0]) ?? 0))
				.slice(0, limit)
				.map(([id]) => id);
		}
	};
}
