// Media resolver interface — the abstraction over search sources (local library, YouTube).
// A search hit is resolved to a Media record before it can be queued; it becomes playable only
// once a stems job has produced an instrumental.

import type { Media } from '$shared';
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
	// Parse the canonicals HERE, at the earliest point the raw title and uploader are both known.
	//
	// They used to appear only when a sidecar was read at boot, which meant a freshly materialised
	// search hit carried none — and the `fetch` job's MusicBrainz lookup, which needs a confident
	// artist/title to search with, could therefore never fire for a new song. It would have declined
	// silently and looked like "annotation never matches anything".
	//
	// Gated on `confidence !== 'low'`, the same rule browseArtist/lookupTitle apply: a guessed title
	// sent to a metadata or lyrics lookup returns nothing, or another song's data, and the second is
	// worse than a miss. An absent key is how a consumer learns to decline.
	const parsed = parseTrackTitle(r.title, r.artist);
	// Narrow on the VALUE, not a boolean: `low` has to be excluded from the type as well as the logic,
	// so a future caller cannot read a low-confidence guess as though it were trustworthy provenance.
	const confidence = parsed.confidence === 'low' ? undefined : parsed.confidence;
	return {
		id,
		source: r.source,
		sourceRef: r.sourceRef,
		title: r.title,
		artist: r.artist,
		artistCanonical: confidence && parsed.artist ? parsed.artist : undefined,
		// Gated the same way, and additionally only kept when it says something the primary does not:
		// storing a credit identical to `artistCanonical` would add a column with no signal in it.
		artistCredit:
			confidence && parsed.artistFull && parsed.artistFull !== parsed.artist ? parsed.artistFull : undefined,
		titleCanonical: confidence ? parsed.title : undefined,
		// Provenance is only claimed when there is actually a canonical artist to stand behind: the
		// parser can be confident about a TITLE while genuinely unable to name the artist, and recording
		// `normalizer` in that case would overstate what is known.
		annotation: confidence && parsed.artist ? { source: 'normalizer', confidence } : undefined,
		durationSec: r.durationSec,
		thumbnail: r.thumbnail,
		viewCount: r.viewCount,
		stemStatus: 'none'
	};
}
