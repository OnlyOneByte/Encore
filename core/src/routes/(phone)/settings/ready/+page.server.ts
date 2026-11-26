// Ready for tonight (proposal 39): host only. The rows come with the page, so it paints whole; opening it then runs
// Check again, and the page reads the answers as they land. See docs/FRONTEND.md#ready-for-tonight.
import type { PageServerLoad } from './$types';
import { getApp } from '$lib/server/app';
import { requireHost } from '$lib/server/host-gate';
import { joinOrigin } from '$lib/server/public-origin';
import { joinAddressLabel } from '$lib/tv/join-address';
import { readyFacts } from '$lib/server/ready';
import { readyRows } from '$lib/ready';

export const load: PageServerLoad = async (event) => {
	requireHost(event);
	return {
		rows: readyRows(await readyFacts(getApp())),
		tvAddress: `${joinAddressLabel(joinOrigin(event.request, event.url))}/tv`
	};
};
