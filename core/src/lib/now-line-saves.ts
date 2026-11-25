// The now-line heart's saved set (proposal 36): ONE singer's, read once per singer, flipped on the tap and sent in
// tap order per song. See docs/FRONTEND.md#the-now-playing-strip.
import { SvelteSet } from 'svelte/reactivity';

type Deps = { fetch: (url: string, init?: RequestInit) => Promise<Response>; refused: (message: string) => void };

export class NowLineSaves {
	readonly ids = new SvelteSet<string>();
	#singer: string | null = null;
	// Per song, the request still in the air: a tap during it waits its turn.
	#saving = new Map<string, Promise<void>>();
	#deps: Deps;

	constructor(deps: Deps) {
		this.#deps = deps;
	}

	/** The singer this phone is now, or null. A change empties the set first, so after a Leave the next singer never
	 *  sees the last one's saves filled while their own are on the way. */
	setSinger(singer: string | null): Promise<void> {
		if (singer === this.#singer) return Promise.resolve();
		this.#singer = singer;
		this.ids.clear();
		return singer ? this.#load(singer) : Promise.resolve();
	}

	async #load(singer: string): Promise<void> {
		const res = await this.#deps.fetch('/api/me/songs').catch(() => null);
		if (!res?.ok) return;
		const { songs } = (await res.json()) as { songs: { mediaId: string | null; saved: unknown }[] };
		// Someone else is this phone by now: their answer, not this one, fills the set.
		if (this.#singer !== singer) return;
		this.ids.clear();
		for (const s of songs) if (s.saved && s.mediaId) this.ids.add(s.mediaId);
	}

	/** Flips the mark at once, then sends the request behind any still in the air for this song, so a double tap
	 *  reaches the server in the order it was made. Only the last tap rolls back and speaks if refused. */
	toggle(id: string): Promise<void> {
		const singer = this.#singer;
		const want = !this.ids.has(id);
		const flip = (on: boolean) => void (on ? this.ids.add(id) : this.ids.delete(id));
		flip(want);
		const run: Promise<void> = (this.#saving.get(id) ?? Promise.resolve()).then(async () => {
			if (this.#singer !== singer) return;
			const res = await this.#deps
				.fetch(`/api/me/songs/${encodeURIComponent(id)}`, { method: want ? 'PUT' : 'DELETE' })
				.catch(() => null);
			// 404 on an unsave is "already out", from another phone of yours.
			const ok = res?.ok || (!want && res?.status === 404);
			if (!ok && this.#singer === singer && this.#saving.get(id) === run) {
				flip(!want);
				this.#deps.refused(want ? "Couldn't save it to your songs." : "Couldn't take it out of your songs.");
			}
		});
		this.#saving.set(id, run);
		return run.finally(() => {
			if (this.#saving.get(id) === run) this.#saving.delete(id);
		});
	}
}
