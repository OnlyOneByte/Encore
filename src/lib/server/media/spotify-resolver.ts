// Spotify resolver — a SEARCH / metadata source only (the annotator pattern).
// A Spotify hit carries clean canonical artist/title/duration, but its bytes are never fetched from
// Spotify: the audio is still acquired from YouTube, and `fetcherFor` refuses a spotify source. There
// is no fetch:spotify worker capability and no librespot acquisition — that half stays parked.
//
// Structurally identical to YouTubeResolver: the backend is injected (so it unit-tests without creds
// or the network), results are cached + deduped by query, and concurrent identical queries share one
// in-flight call. When the creds are unset the injected backend returns [], so the resolver is a
// no-op source that the search fan-out tolerates by design.

import type { MediaResolver, SearchResult } from './resolver';

export type SpotifySearchBackend = (query: string, limit: number) => Promise<SearchResult[]>;

interface CacheEntry {
	at: number;
	results: SearchResult[];
}

export class SpotifyResolver implements MediaResolver {
	readonly kind = 'spotify' as const;
	#backend: SpotifySearchBackend;
	#cache = new Map<string, CacheEntry>();
	#ttlMs: number;
	#now: () => number;
	#inflight = new Map<string, Promise<SearchResult[]>>();

	constructor(backend: SpotifySearchBackend, opts: { ttlMs?: number; now?: () => number } = {}) {
		this.#backend = backend;
		this.#ttlMs = opts.ttlMs ?? 5 * 60_000;
		this.#now = opts.now ?? Date.now;
	}

	async search(query: string, limit: number): Promise<SearchResult[]> {
		const key = `${query.trim().toLowerCase()}#${limit}`;
		if (!key.replace(/#\d+$/, '')) return [];

		const hit = this.#cache.get(key);
		if (hit && this.#now() - hit.at < this.#ttlMs) return hit.results;

		const existing = this.#inflight.get(key);
		if (existing) return existing;

		const p = this.#backend(query.trim(), limit)
			.then((results) => {
				this.#cache.set(key, { at: this.#now(), results });
				return results;
			})
			.finally(() => this.#inflight.delete(key));
		this.#inflight.set(key, p);
		return p;
	}

	/** test/diagnostic: current cache size */
	get cacheSize(): number {
		return this.#cache.size;
	}
}
