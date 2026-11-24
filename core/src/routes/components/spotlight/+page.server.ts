// Dev-only, the same gate as the gallery above it: the Spotlight primitive's story until step 3 gives it a screen.
import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	if (!dev) {
		error(404, 'Not found');
	}
	return {};
};
