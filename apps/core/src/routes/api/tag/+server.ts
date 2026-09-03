// POST /api/tag — set the genres (or free tags) on a library song.
//
// Writes the SIDECAR first, because that is the authoritative record (docs/ARCHITECTURE.md),
// then mirrors into the browse index. Order matters: if the process died between the two, a restart
// re-syncs the index from the sidecars, whereas the reverse order would silently lose the edit.
//
// Requires a joined singer — same bar as queueing. Curating someone else's party library from an
// un-joined browser is not a thing we want to allow, and the cookie is already there for free.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { SESSION_COOKIE } from '$server/singers/repository';
import { readSidecar, writeSidecar, browseArtist, lookupTitle } from '$server/media/sidecar';

/** Genres are lowercased and trimmed so "Pop", "pop " and "pop" are one bucket, not three. */
function normalizeValues(input: unknown): string[] | null {
	if (!Array.isArray(input)) return null;
	const out = [...new Set(input.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase()).filter(Boolean))];
	// A cap, because this is free text from a phone and the sidecar is meant to stay readable.
	return out.length <= 16 ? out.map((v) => v.slice(0, 32)) : null;
}

export const POST: RequestHandler = async ({ request, cookies }) => {
	const app = getApp();
	const singer = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));
	if (!singer) return json({ error: 'join first' }, { status: 401 });

	let body: { mediaId?: string; kind?: string; values?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid json' }, { status: 400 });
	}

	const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';
	const kind = body.kind === 'tag' ? 'tag' : 'genre';
	const values = normalizeValues(body.values);
	if (!mediaId) return json({ error: 'mediaId required' }, { status: 400 });
	if (values === null) return json({ error: 'values must be an array of at most 16 strings' }, { status: 400 });

	const sidecar = await readSidecar(mediaId);
	if (!sidecar) return json({ error: 'unknown media' }, { status: 404 });

	// Authoritative write. `by: 'manual'` is what stops the normalizer overwriting this on the next
	// persist — a human decision outranks a parse, forever.
	if (kind === 'genre') {
		sidecar.canonical.genre = values;
		sidecar.provenance.genre = { by: 'manual', confidence: 'high' };
	} else {
		sidecar.library.tags = values;
	}
	await writeSidecar(sidecar);

	// Then the index.
	app.media.setTags(mediaId, kind, values);
	app.media.setCanonical(mediaId, { artist: browseArtist(sidecar), title: lookupTitle(sidecar), album: sidecar.canonical.album, year: sidecar.canonical.year });

	return json({ ok: true, mediaId, kind, values });
};
