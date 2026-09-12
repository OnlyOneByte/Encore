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

import type { MediaSource } from '../core/types';
import { makeRegistry } from '../core/registry';

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

const registry = makeRegistry(FETCHERS);

export function getFetcher(id: string): Fetcher | undefined {
	return registry.get(id);
}

export function isValidFetcher(id: string): id is FetcherId {
	return registry.isValid(id);
}

/**
 * Which fetcher owns this media's audio.
 *
 * A local file is `local` regardless of the configured default: its bytes are already here, so no
 * downloader is involved and none can be substituted. Everything else uses the deployment's default.
 */
export function fetcherFor(source: MediaSource, defaultFetcher: string = DEFAULT_FETCHER): FetcherId {
	if (source === 'local') return 'local';
	// `spotify` is a METADATA-ONLY source: there is deliberately no `fetch:spotify` fetcher, so its
	// bytes are never pulled from Spotify (docs/DECISIONS.md, the annotator pattern). `fetcherFor` does
	// NOT refuse it — it returns the default downloader as a FLOOR, so callers always get a valid
	// FetcherId. The refusal lives in `isProcessableSource` below, which is the ONE authority every layer
	// asks. Do NOT read this fallback as proof the branch is unreachable: `/api/search` DOES
	// materialize a spotify hit into a durable, queueable `Media`, so a caller that skips
	// `isProcessableSource` reaches here and forms `youtube.com/watch?v=<spotify-track-id>` — the exact
	// shape-inference bug this whole registry exists to kill (see the header comment). That is an earlier change.
	if (source === 'spotify') return DEFAULT_FETCHER;
	return isValidFetcher(defaultFetcher) && defaultFetcher !== 'local' ? defaultFetcher: DEFAULT_FETCHER;
}

/**
 * Sources that carry METADATA ONLY — no fetcher can pull their bytes, so a song from one can never be
 * processed and therefore can never be sung. This is the extension point: a new search-only provider
 * joins this set, and every layer that already asks `isProcessableSource` refuses it with no further
 * edits.
 */
export const METADATA_ONLY_SOURCES: readonly MediaSource[] = ['spotify'];

/**
 * Can a song from this source be processed at all?
 *
 * The SINGLE authority for the ratified "Spotify is search/metadata only" rule (docs/DECISIONS.md).
 * It lives here, in the acquisition registry, because the reason is an acquisition fact: no fetcher
 * knows how to pull these bytes.
 *
 * WHY IT IS A SHARED PREDICATE AND NOT A CHECK INSIDE ONE FUNCTION. The rule used to be
 * enforced at exactly one point — a `media.source === 'spotify'` line inside `requestProcess` —
 * and asserted at five others. Enforcement there is too late: `processState` still answered `'processable'`,
 * so the phone offered Sing, `processAndQueue` took the singer's turn, and only THEN did the process get
 * refused. The turn was left in the rotation with nothing that could ever make it ready: skipped on
 * every pass, for the rest of the night, with no failure event because no job was ever enqueued.
 * Every layer that decides whether a process is possible now asks this one function.
 */
export function isProcessableSource(source: MediaSource): boolean {
	return !METADATA_ONLY_SOURCES.includes(source);
}

/** Does this media need an acquisition job before it can be separated? */
export function needsFetch(source: MediaSource, defaultFetcher?: string): boolean {
	return getFetcher(fetcherFor(source, defaultFetcher))?.capability !== null;
}

/** The URI a worker pulls for this media. Replaces the core's old source-conditional. */
export function sourceUriFor(media: { source: MediaSource; sourceRef: string }, defaultFetcher?: string): string {
	const f = getFetcher(fetcherFor(media.source, defaultFetcher));
	return f ? f.uri(media.sourceRef): media.sourceRef;
}
