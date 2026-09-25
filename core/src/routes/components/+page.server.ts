// Dev-only surface: gated server-side so the 404 is decided before any gallery HTML or data exists.
// The gallery is still load-bearing test infrastructure — `tests/playwright/specs/shot/frames.spec.ts`
// screenshots this route — so gate, never delete. See ../../../docs/FRONTEND.md#the-components-gallery
import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	if (!dev) {
		error(404, 'Not found');
	}
	return {};
};
