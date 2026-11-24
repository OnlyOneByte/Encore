// POST /api/host/people/reset — { personId } -> the host signs out every phone a kept person is kept on and forgets
// the person, so they can join fresh and tap Keep me again. Host only. See docs/SERVER.md#kept-people.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';
import { forgetPerson } from '$lib/server/people/keep';

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!can({ host: isHost(cookies) }, 'people:reset'))
		return json({ error: 'only the host can reset phones' }, { status: 403 });
	const app = getApp();
	const personId = requiredString(await readJsonBody(request), 'personId');
	if (!personId) return json({ error: 'personId required' }, { status: 400 });
	if (!app.people.exists(personId)) return json({ error: 'unknown person' }, { status: 404 });
	forgetPerson(app, personId);
	return json({ reset: true });
};
