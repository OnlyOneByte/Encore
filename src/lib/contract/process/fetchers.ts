// Where a song's audio comes FROM — the acquisition axis, alongside separator engine and model.
//
// A job DECLARES its fetcher and the worker parses that declaration at its boundary, so an unknown value
// fails before any work starts. Acquisition is NEVER inferred from a URI's shape: inference silently
// classifies a ref matching neither assumption as a local file, which then dies stages later inside ffmpeg
// naming the symptom and not the cause. See docs/ARCHITECTURE.md §7.
//
// A registry, like the separator one, so a settings value can be validated, one source renders the picker,
// and a new fetcher cannot be added without a label and a capability.

import type { MediaSource } from '../core/types';
import { makeRegistry } from '../core/registry';

/**
 * `local` is NOT a downloader: it means the bytes are already on the media volume, so `sourceRef` is a path
 * to read. A first-class member rather than an absence, because "already here" is precisely the case shape
 * inference gets wrong.
 */
export type FetcherId = 'ytdlp' | 'local';

export interface Fetcher {
	id: FetcherId;
	label: string;
	/**
	 * The capability a job needs, or `null` when no acquisition job is needed at all. Routed exactly as a
	 * separator engine's capability is, which is what lets a fetch-capable box and a separation-capable box
	 * be different machines.
	 */
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

/**
 * Which fetcher owns this media's audio. A local file is `local` regardless of the configured default — its
 * bytes are already here, so no downloader is involved and none can be substituted.
 */
export function fetcherFor(source: MediaSource, defaultFetcher: string = DEFAULT_FETCHER): FetcherId {
	if (source === 'local') return 'local';
	// `spotify` is METADATA-ONLY: there is deliberately no `fetch:spotify` fetcher. `fetcherFor` does NOT
	// refuse it — it returns the default downloader as a FLOOR, so callers always get a valid `FetcherId`.
	// The refusal is `isProcessableSource` below, the ONE authority every layer asks. Do not read this
	// fallback as proof the branch is dead: search materializes a spotify hit into a durable, queueable
	// media, so a caller that skips that predicate reaches here and forms a watch URL from a Spotify track
	// id — the exact shape-inference defect this registry exists to kill.
	if (source === 'spotify') return DEFAULT_FETCHER;
	return isValidFetcher(defaultFetcher) && defaultFetcher !== 'local' ? defaultFetcher : DEFAULT_FETCHER;
}

/**
 * Sources carrying METADATA ONLY: no fetcher can pull their bytes, so a song from one can never be processed
 * and therefore never sung. THE extension point — a new search-only provider joins this set and every layer
 * already asking `isProcessableSource` declines it with no further edits.
 */
export const METADATA_ONLY_SOURCES: readonly MediaSource[] = ['spotify'];

/**
 * Can a song from this source be processed at all? The SINGLE authority, living in the acquisition registry
 * because the reason is an acquisition fact: no fetcher knows how to pull these bytes.
 *
 * IT MUST BE ASKED BY EVERY LAYER THAT DECIDES WHETHER A PROCESS IS POSSIBLE, not just by the one that
 * enqueues. Enforcing it only at enqueue is too late: `processState` still answers `processable`, the phone
 * offers Sing, the singer's turn is taken, and the process is declined afterwards — leaving a turn in the
 * rotation that nothing can ever make ready, skipped on every pass with no failure event, because no job
 * was enqueued to fail.
 */
export function isProcessableSource(source: MediaSource): boolean {
	return !METADATA_ONLY_SOURCES.includes(source);
}

/** Does this media need an acquisition job before it can be separated? */
export function needsFetch(source: MediaSource, defaultFetcher?: string): boolean {
	return getFetcher(fetcherFor(source, defaultFetcher))?.capability !== null;
}

/** The URI a worker pulls for this media — the one place a `sourceRef` becomes a fetchable address. */
export function sourceUriFor(media: { source: MediaSource; sourceRef: string }, defaultFetcher?: string): string {
	const f = getFetcher(fetcherFor(media.source, defaultFetcher));
	return f ? f.uri(media.sourceRef) : media.sourceRef;
}
