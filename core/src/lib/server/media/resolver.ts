// Media resolver interface — the abstraction over search sources (local library, YouTube).
// A search hit is resolved to a Media record before it can be queued; it becomes playable only
// once a stems job has produced an instrumental.

import type { Media } from '../../contract';
import { parseTrackTitle } from './track-title';

export interface SearchResult {
	source: 'youtube' | 'local' | 'spotify';
	sourceRef: string; // local file key, or youtube video id
	title: string;
	artist?: string;
	durationSec: number;
	thumbnail?: string;
	/** Views as the source reported them. Display-only tiebreaker — see Media.viewCount. */
	viewCount?: number;
}

export interface MediaResolver {
	readonly kind: 'youtube' | 'local' | 'spotify';
	/** Search this source for a query; returns lightweight results (not yet persisted Media). */
	search(query: string, limit: number): Promise<SearchResult[]>;
}

/** A result becomes a Media record (with a stable id) when first queued. */
export function resultToMedia(id: string, r: SearchResult): Media {
	// Parse the canonicals HERE, at the earliest point the raw title and uploader are both known — a
	// fresh search hit that skips this never gets a confident artist/title for the `fetch` job's
	// MusicBrainz lookup to search with, and declines silently. Gated on `confidence !== 'low'`, same
	// rule as browseArtist/lookupTitle: a guessed title sent to a metadata/lyrics lookup returns
	// nothing, or another song's data — worse than a miss. An absent key is how a consumer learns to decline.
	const parsed = parseTrackTitle(r.title, r.artist);
	// Narrow on the VALUE: `low` must be excluded from the type too, so a future caller can't read a
	// low-confidence guess as trustworthy provenance.
	const confidence = parsed.confidence === 'low' ? undefined : parsed.confidence;
	return {
		id,
		source: r.source,
		sourceRef: r.sourceRef,
		title: r.title,
		artist: r.artist,
		artistCanonical: confidence && parsed.artist ? parsed.artist : undefined,
		// Only kept when it says something the primary doesn't — a credit identical to
		// artistCanonical would add a column with no signal.
		artistCredit:
			confidence && parsed.artistFull && parsed.artistFull !== parsed.artist ? parsed.artistFull : undefined,
		titleCanonical: confidence ? parsed.title : undefined,
		// Provenance only claimed when there's a canonical artist to stand behind — the parser can be
		// confident about TITLE alone, and recording `normalizer` then would overstate what's known.
		annotation: confidence && parsed.artist ? { source: 'normalizer', confidence } : undefined,
		durationSec: r.durationSec,
		thumbnail: r.thumbnail,
		viewCount: r.viewCount,
		stemStatus: 'none'
	};
}
