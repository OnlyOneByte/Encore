// /stats LOADS ITS DATA BEFORE THE DOCUMENT COMMITS, which is the whole reason this file exists. With the fetch in
// `onMount` the page was one viewport tall at the moment SvelteKit applied a popped scroll offset — restore runs after
// `root.$set` plus two ticks, a DOM-commit deadline no network round trip can beat — so coming Back to /stats clamped
// to 0 while /library and /settings (which has a server load) both restored to 500, measured in one session.
//
// UNIVERSAL, not `+page.server.ts`: a client-side navigation into /stats must fetch before the commit too, and a
// server-only load would leave that leg exactly as broken as it was.
import type { PageLoad } from './$types';

export interface SongTally {
	mediaId: string;
	title: string;
	plays: number;
}
export interface Stats {
	library: { ready: number; catalog: number };
	sings: { total: number; window: number; distinctSongs: number };
	topSongs: SongTally[];
	topRecent: SongTally[];
	topArtists: { artist: string; plays: number }[];
	perDay: { day: string; plays: number }[];
	window: { days: number; since: number };
}

export const load: PageLoad = async ({ fetch }) => {
	try {
		const res = await fetch('/api/stats?days=30');
		if (!res.ok) throw new Error(String(res.status));
		const stats: Stats = await res.json();
		// `now` comes from the load, not from the component: read at render it would be the server's instant and then the
		// client's, and the trend's right edge would disagree with the `window.since` this same request computed.
		return { stats, failed: false, now: Date.now() };
	} catch {
		// Say so rather than render zeros that look like real data — the page's own rule, kept verbatim.
		return { stats: null, failed: true, now: Date.now() };
	}
};
