// The YOU scope's load. `me` only — the two controls here patch `/api/me`, so no settings object, no join address
// and no worker catalogue is serialised into this page. See $lib/server/settings-gate for the gate itself and for
// why each scope route loads for itself rather than through a `+layout.server.ts`.
import type { PageServerLoad } from './$types';
import { settingsSinger } from '$lib/server/settings-gate';

export const load: PageServerLoad = (event) => ({ me: settingsSinger(event) });
