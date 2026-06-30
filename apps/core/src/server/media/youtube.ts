// YouTube resolver — keyless search via yt-dlp (no API key; matches the self-host ethos).
// MASTER-DESIGN decision (2026-06-29 default): keyless yt-dlp search with graceful degradation
// when the binary is absent (dev). Results cached + deduped by query so re-typing a song is free.
//
// The actual yt-dlp invocation is injected (`runSearch`) so this unit-tests without the binary.

import type { MediaResolver, SearchResult } from './resolver';

export type YtSearchBackend = (query: string, limit: number) => Promise<SearchResult[]>;

interface CacheEntry {
	at: number;
	results: SearchResult[];
}

export class YouTubeResolver implements MediaResolver {
	readonly kind = 'youtube' as const;
	#backend: YtSearchBackend;
	#cache = new Map<string, CacheEntry>();
	#ttlMs: number;
	#now: () => number;
	#inflight = new Map<string, Promise<SearchResult[]>>();

	constructor(backend: YtSearchBackend, opts: { ttlMs?: number; now?: () => number } = {}) {
		this.#backend = backend;
		this.#ttlMs = opts.ttlMs ?? 5 * 60_000;
		this.#now = opts.now ?? Date.now;
	}

	async search(query: string, limit: number): Promise<SearchResult[]> {
		const key = `${query.trim().toLowerCase()}#${limit}`;
		if (!key.replace(/#\d+$/, '')) return [];

		const hit = this.#cache.get(key);
		if (hit && this.#now() - hit.at < this.#ttlMs) return hit.results; // cache hit — free

		// dedupe concurrent identical queries (a single keystroke burst) into one backend call
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
