import type { PageServerLoad } from './$types';
import { isHost } from '$lib/server/host-gate';

export const load: PageServerLoad = ({ cookies }) => ({ host: isHost(cookies) });
