// The Screens page: host only. The first list comes with the page, so it paints whole; the page polls
// /api/screens for changes after that.
import type { PageServerLoad } from './$types';
import { getApp } from '$lib/server/app';
import { requireHost } from '$lib/server/host-gate';
import { joinOrigin } from '$lib/server/public-origin';
import { joinAddressLabel } from '$lib/tv/join-address';

export const load: PageServerLoad = (event) => {
	requireHost(event);
	const screens = getApp().screens;
	return {
		screens: screens?.list() ?? [],
		midSong: screens?.midSong() ?? false,
		// Where another screen opens the TV, as the TV's own QR advertises its join address.
		tvAddress: `${joinAddressLabel(joinOrigin(event.request, event.url))}/tv`
	};
};
