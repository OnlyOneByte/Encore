// Where a song's audio comes FROM — the third axis, alongside separator engine and model.
//
// WHY THIS EXISTS. Acquisition used to be inferred from a URI's *shape*, in two places on opposite
// sides of the wire and with no shared vocabulary: the core turned a media into either a watch URL or
// a bare file key (`sourceUri`), and the worker turned it back by testing for an `http(s)` prefix
// (`is_local_source`). Nothing declared the intent, so a ref that matched neither assumption — a
// `spotify:track:…` URI, say — was silently classified as a local file and died several stages later
// at ffmpeg with "No such file", which names the symptom and not the cause.
//
// A job now DECLARES its fetcher and the worker parses that declaration at the boundary, the way it
// already parses engines. An unknown value fails before any work starts.
//
// Mirrors separators.ts deliberately: a registry rather than a bare union, so a settings value can be
// validated against it, the phone can render a picker from one source, and a new fetcher cannot be
// added without a label and a capability.

import type { MediaSource } from './types';

/**
 * `local` is not a downloader — it means the bytes are already on the media volume, so `sourceRef` is
 * a path to read rather than something to acquire. It is a first-class member because "already here"
 * is exactly the case the old shape-inference got wrong, and naming it is what removes the guess.
 */
export type FetcherId = 'ytdlp' | 'local';

export interface Fetcher {
	id: FetcherId;
	label: string;
	/**
	 * The worker capability a job needs to run, or `null` when no acquisition job is needed at all.
	 * Routed by `requiredCapability` exactly as a separator engine's capability is, which is what lets
	 * a fetch-capable box and a separation-capable box be different machines.
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

export function getFetcher(id: string): Fetcher | undefined {
	return FETCHERS.find((f) => f.id === id);
}

export function isValidFetcher(id: string): id is FetcherId {
	return getFetcher(id) !== undefined;
}

/** Fetchers a deployment can actually choose as its default — `local` is a property of a media. */
export function selectableFetchers(): readonly Fetcher[] {
	return FETCHERS.filter((f) => f.capability !== null);
}

/**
 * Which fetcher owns this media's audio.
 *
 * A local file is `local` regardless of the configured default: its bytes are already here, so no
 * downloader is involved and none can be substituted. Everything else uses the deployment's default.
 */
export function fetcherFor(source: MediaSource, defaultFetcher: string = DEFAULT_FETCHER): FetcherId {
	if (source === 'local') return 'local';
	return isValidFetcher(defaultFetcher) && defaultFetcher !== 'local' ? defaultFetcher : DEFAULT_FETCHER;
}

/** Does this media need an acquisition job before it can be separated? */
export function needsFetch(source: MediaSource, defaultFetcher?: string): boolean {
	return getFetcher(fetcherFor(source, defaultFetcher))?.capability !== null;
}

/** The URI a worker pulls for this media. Replaces the core's old source-conditional. */
export function sourceUriFor(
	media: { source: MediaSource; sourceRef: string },
	defaultFetcher?: string
): string {
	const f = getFetcher(fetcherFor(media.source, defaultFetcher));
	return f ? f.uri(media.sourceRef) : media.sourceRef;
}
