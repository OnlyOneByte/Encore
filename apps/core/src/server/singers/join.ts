// Join logic — pure-ish handler so it unit-tests without HTTP. The +server.ts route is a thin
// wrapper that parses the request, calls this, sets the session cookie, and returns JSON.

import { normalizeSingerColor, type Singer } from '@encore/shared';
import type { EncoreApp } from '../app';

export interface JoinInput {
	displayName: string;
	color: string;
}

export interface JoinResult {
	singer: Singer;
}

/** Validate + create a singer, then broadcast singer:joined. Throws on invalid input. */
export function doJoin(app: EncoreApp, input: JoinInput): JoinResult {
	const name = (input.displayName ?? '').trim();
	if (!name) throw new Error('display name required');
	/*
	 * Was `isValidColor(input.color) ? input.color : SINGER_COLORS[0]` — an allowlist of the eight
	 * presets, so every other hue was silently rewritten to violet and a guest who picked teal joined
	 * as violet with nothing said. normalizeSingerColor accepts any hex whose dot stays visible and
	 * canonicalises it, falling back to a preset only for input that is genuinely unusable.
	 */
	const color = normalizeSingerColor(input.color);

	const singer = app.singers.create(name, color, app.now());
	app.publish({ type: 'singer:joined', singer });
	return { singer };
}
