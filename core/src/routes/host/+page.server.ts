import type { PageServerLoad } from './$types';
import { getApp } from '$lib/server/app';
import { isHost } from '$lib/server/host-gate';

// The kept people, for Reset phones, go to the host alone.
export const load: PageServerLoad = ({ cookies }) => {
	const host = isHost(cookies);
	return { host, people: host ? getApp().people.list() : [] };
};
