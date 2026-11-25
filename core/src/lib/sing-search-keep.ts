// The Sing tab's search, kept across a trip to another tab (#1245). Module scope outlives the page, so a host back
// from Queue finds the same text and rows without a new request; a reload clears it. Written only on unmount, so
// it is browser-only.
import type { Media } from '$lib/contract';

export type KeptSearch = {
	query: string;
	widened: boolean;
	ready: Media[];
	raw: Media[];
	processing: Media[];
	failed: boolean;
	answeredFor: string | null;
	/** Left mid-search or mid-debounce, so no answer was kept and the search must be asked again. */
	pending: boolean;
};

let kept: { singer: string; source: string; search: KeptSearch } | null = null;

/** Keeps this singer's search. With no one joined it keeps nothing, so a shared phone never hands it on. */
export function keepSearch(singer: string | undefined, source: string, search: KeptSearch): void {
	kept = singer ? { singer, source, search } : null;
}

/** The search this same singer left under this same `?source=`, or null. */
export function keptSearch(singer: string | undefined, source: string): KeptSearch | null {
	return singer && kept?.singer === singer && kept.source === source ? kept.search : null;
}
