// Dev-only surface: gated server-side so the 404 is decided before any gallery HTML or data exists.
// The gallery itself is load-bearing test infrastructure — guards read its source — so gate, never
// delete. tests/guards/wiring/dev-only-routes.test.ts pins this gate. docs/FRONTEND.md#the-components-gallery
import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	if (!dev) {
		error(404, 'Not found');
	}
	return {};
};
