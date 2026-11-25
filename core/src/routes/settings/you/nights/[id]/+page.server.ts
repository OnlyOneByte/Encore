// "Your night": one night's story, for the singer it is about and nobody else. The owner comes from this phone's
// cookies (`historyOwner`), never the URL, and a night you sang nothing in is 404 whoever else did — the same gate
// as GET /api/me/nights/:id (docs/SERVER.md#your-night). No join: off to join, then back here.
import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { settingsSinger } from '$lib/server/settings-gate';
import { historyOwner } from '$lib/server/nights/service';
import { nightStory } from '$lib/night-story';

// shortcut: times in the server's zone, which is the party's own box; pass the phone's zone if a room ever spans two.
const day = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const clockOf = (ms: number) => clock.format(ms).replace(' AM', ' am').replace(' PM', ' pm');

export const load: PageServerLoad = (event) => {
	const me = settingsSinger(event);
	const app = getApp();
	const caller = historyOwner(app, event.cookies, event);
	const found = caller && app.nights.night(caller.owner, event.params.id);
	if (!found) error(404, 'No such night');
	const slides = nightStory(
		found.turns.map((t) => ({
			title: app.mediaById.get(t.mediaId)?.title ?? null,
			startedAt: t.startedAt,
			end: t.end,
			keyShift: t.keyShift,
			cheers: t.cheers
		}))
	);
	if (slides.length === 0) error(404, 'No such night');
	// The songs sung, as the slides count them: a turn that would not play moves neither end of the night.
	const sung = found.turns.filter((t) => t.end !== 'failed');
	const from = Math.min(...sung.map((t) => t.startedAt));
	return {
		name: me.displayName,
		colour: me.color,
		day: day.format(from),
		from: clockOf(from),
		to: clockOf(Math.max(...sung.map((t) => t.endedAt))),
		slides
	};
};
