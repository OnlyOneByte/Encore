import type { PageServerLoad } from './$types';
import { requireHost } from '$lib/server/host-gate';

export const load: PageServerLoad = (event) => requireHost(event);
