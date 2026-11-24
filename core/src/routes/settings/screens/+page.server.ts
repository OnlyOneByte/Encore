// The Screens page: host only. The list itself comes from /api/screens, which the page polls.
import type { PageServerLoad } from './$types';
import { requireHost } from '$lib/server/host-gate';
import { joinOrigin } from '$lib/server/public-origin';
import { joinAddressLabel } from '$lib/tv/join-address';

export const load: PageServerLoad = (event) => {
	requireHost(event);
	// Where another screen opens the TV, as the TV's own QR advertises its join address.
	return { tvAddress: `${joinAddressLabel(joinOrigin(event.request, event.url))}/tv` };
};
