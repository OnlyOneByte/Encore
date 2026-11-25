// A long boot pass over the whole library runs on the event loop the phones and the TV are answered on (#1297).

/** How long a pass may hold the event loop before it lets requests in. */
export const SLICE_MS = 16;

/** A pass calls the returned function between items: it gives the event loop back once `sliceMs` has passed since
 *  the last time, so requests are answered between items, never behind the whole library. */
export function slicer(sliceMs = SLICE_MS): () => Promise<void> {
	let since = performance.now();
	return async () => {
		if (performance.now() - since < sliceMs) return;
		await new Promise((r) => setImmediate(r));
		since = performance.now();
	};
}
