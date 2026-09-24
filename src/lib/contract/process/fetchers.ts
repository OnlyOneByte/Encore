// The acquisition axis, alongside separator engine and model. A job DECLARES its fetcher and the worker
// parses that declaration at its boundary, so an unknown value fails before any work starts. Acquisition is
// NEVER inferred from a URI's shape: inference classifies a ref matching neither assumption as a local file,
// which dies stages later inside ffmpeg naming the symptom and not the cause. A registry, so a new fetcher
// cannot be added without a label and a capability. See docs/SERVER.md#what-the-worker-is-told.

import type { MediaSource } from '../core/types';
import { makeRegistry } from '../core/registry';

/** `local` is NOT a downloader: the bytes are already on the media volume. A first-class member rather than
 *  an absence, because "already here" is precisely the case shape inference gets wrong. */
export type FetcherId = 'ytdlp' | 'local';

export interface Fetcher {
	id: FetcherId;
	label: string;
	/** `null` when no acquisition job is needed. Routed exactly as a separator engine's capability is, which
	 *  is what lets a fetch-capable box and a separation-capable box be different machines. */
	capability: string | null;
	note: string;
	/** Turn a media's immutable `sourceRef` into the URI this fetcher pulls. PURE. */
	uri: (sourceRef: string) => string;
}

export const FETCHERS: readonly Fetcher[] = [
	{
		id: 'ytdlp',
		label: 'YouTube (yt-dlp)',
		capability: 'fetch:ytdlp',
		note: 'Keyless search and download. Needs yt-dlp, ffmpeg and a JS runtime on the worker.',
		uri: (sourceRef) => `https://www.youtube.com/watch?v=${sourceRef}`
	},
	{
		id: 'local',
		label: 'Local library',
		capability: null, // nothing to acquire — the file is already on the volume
		note: 'A file already under the media volume. Still needs separating before anyone can sing it.',
		uri: (sourceRef) => sourceRef
	}
];

export const DEFAULT_FETCHER: FetcherId = 'ytdlp';

const registry = makeRegistry(FETCHERS);

export function getFetcher(id: string): Fetcher | undefined {
	return registry.get(id);
}

export function isValidFetcher(id: string): id is FetcherId {
	return registry.isValid(id);
}

/** A local file is `local` regardless of the configured default: no downloader is involved. */
export function fetcherFor(source: MediaSource, defaultFetcher: string = DEFAULT_FETCHER): FetcherId {
	if (source === 'local') return 'local';
	// `spotify` is METADATA-ONLY: there is deliberately no `fetch:spotify` fetcher. `fetcherFor` does NOT
	// refuse it — it returns the default downloader as a FLOOR, so callers always get a valid `FetcherId`.
	// The refusal is `isProcessableSource` below, the ONE authority every layer asks. This branch is LIVE:
	// search materializes a spotify hit into a durable, queueable media, so a caller skipping that
	// predicate reaches here and forms a watch URL from a Spotify track id.
	if (source === 'spotify') return DEFAULT_FETCHER;
	return isValidFetcher(defaultFetcher) && defaultFetcher !== 'local' ? defaultFetcher : DEFAULT_FETCHER;
}

/** METADATA ONLY: no fetcher can pull their bytes, so such a song can never be processed or sung. THE
 *  extension point — a new search-only provider joins this set and every layer already declines it. */
export const METADATA_ONLY_SOURCES: readonly MediaSource[] = ['spotify'];

/**
 * The SINGLE authority, living in the acquisition registry because the reason is an acquisition fact.
 *
 * IT MUST BE ASKED BY EVERY LAYER THAT DECIDES WHETHER A PROCESS IS POSSIBLE, not just the one that
 * enqueues. At enqueue alone it is too late: `processState` still answers `processable`, the phone offers
 * Sing, the turn is taken, and the refusal lands afterwards — leaving a rotation turn nothing can ever make
 * ready, skipped on every pass with no failure event, because no job was enqueued to fail.
 */
export function isProcessableSource(source: MediaSource): boolean {
	return !METADATA_ONLY_SOURCES.includes(source);
}

/** Does this media need an acquisition job before it can be separated? */
export function needsFetch(source: MediaSource, defaultFetcher?: string): boolean {
	return getFetcher(fetcherFor(source, defaultFetcher))?.capability !== null;
}

/** The one place a `sourceRef` becomes a fetchable address. */
export function sourceUriFor(media: { source: MediaSource; sourceRef: string }, defaultFetcher?: string): string {
	const f = getFetcher(fetcherFor(media.source, defaultFetcher));
	return f ? f.uri(media.sourceRef) : media.sourceRef;
}
