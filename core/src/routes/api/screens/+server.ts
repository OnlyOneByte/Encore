// GET /api/screens -> the room's screens; POST { action: 'rename' | 'remove' | 'tv', id, name? } acts on one.
// Host only (docs/SERVER.md#screens). A screen becomes the TV mid-song only when tapped on it, so 'tv' waits for no
// song to be current (owner ruling, proposal 34).
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { can } from '$lib/server/capabilities';
import { isHost } from '$lib/server/host-gate';
import { readJsonBody, requiredString } from '$lib/server/http/json-body';
import { cleanScreenName } from '$lib/server/rooms/tv-screens';

const forbidden = () => json({ error: 'only the host can manage screens' }, { status: 403 });

export const GET: RequestHandler = ({ cookies }) => {
	if (!can({ host: isHost(cookies) }, 'screens:manage')) return forbidden();
	const screens = getApp().screens;
	return json({ screens: screens?.list() ?? [], midSong: screens?.midSong() ?? false });
};

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!can({ host: isHost(cookies) }, 'screens:manage')) return forbidden();
	const screens = getApp().screens;
	if (!screens) return json({ error: 'screens are not served here' }, { status: 503 });
	const body = await readJsonBody(request);
	const id = requiredString(body, 'id');
	if (!id) return json({ error: 'id required' }, { status: 400 });

	switch (requiredString(body, 'action')) {
		case 'rename': {
			const name = cleanScreenName(body.name);
			if (!name) return json({ error: 'a name is required' }, { status: 400 });
			return screens.rename(id, name) ? json({ ok: true, name }) : json({ error: 'unknown screen' }, { status: 404 });
		}
		case 'remove': {
			const r = screens.remove(id);
			if (r === 'unknown') return json({ error: 'unknown screen' }, { status: 404 });
			if (r === 'is-tv') return json({ error: 'the TV cannot be removed', reason: r }, { status: 409 });
			return json({ ok: true });
		}
		case 'tv': {
			const r = screens.makeTv(id);
			if (r === 'unknown') return json({ error: 'unknown screen' }, { status: 404 });
			if (r !== 'ok') return json({ error: 'this screen cannot be made the TV now', reason: r }, { status: 409 });
			return json({ ok: true });
		}
		default:
			return json({ error: 'unknown action' }, { status: 400 });
	}
};
