// The gallery is a DEV SURFACE, and until now it only said so in a comment.
//
// `+page.svelte` opens with "Component preview (dev-only gallery). Not a product surface." — but it
// was a plain SvelteKit route with no gate, so it built and served in production. A guest who typed
// /components got a page of fixture songs with invented singer names, which is not a page anyone
// meant to ship.
//
// Gated server-side rather than in a universal load so the 404 is decided before any gallery HTML or
// data exists, matching how /settings resolves its own posture in `+page.server.ts`.
//
// IT REMAINS LOAD-BEARING TEST INFRASTRUCTURE, which is why the file is gated rather than deleted:
// five guards read `src/routes/components/+page.svelte` AS SOURCE and assert on its text — the
// pending-add row, the phone-home shell, the long-name ProcessingCard fixture, the singer-colour
// gallery and the lyrics scale floor. None of them serves the route, so none is affected by this
// gate; they would all break if the file went away. `tests/guards/wiring/dev-only-routes.test.ts`
// pins the gate itself so it cannot quietly come off.
import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	if (!dev) {
		error(404, 'Not found');
	}
	return {};
};
