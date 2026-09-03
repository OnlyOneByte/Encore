// Media resolver interface — the abstraction over search sources (local library, YouTube).
// A search hit is resolved to a Media record before it can be queued; it becomes playable only
// once a stems job has produced an instrumental.

import type { Media } from '@encore/shared';

export interface SearchResult {
	source: 'youtube' | 'local';
	sourceRef: string; // local file key, or youtube video id
	title: string;
	artist?: string;
	durationSec: number;
	thumbnail?: string;
}

export interface MediaResolver {
	readonly kind: 'youtube' | 'local';
	/** Search this source for a query; returns lightweight results (not yet persisted Media). */
	search(query: string, limit: number): Promise<SearchResult[]>;
}

/** A result becomes a Media record (with a stable id) when first queued. */
export function resultToMedia(id: string, r: SearchResult): Media {
	return {
		id,
		source: r.source,
		sourceRef: r.sourceRef,
		title: r.title,
		artist: r.artist,
		durationSec: r.durationSec,
		thumbnail: r.thumbnail,
		stemStatus: 'none'
	};
}
