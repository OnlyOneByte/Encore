// Join logic — pure-ish handler so it unit-tests without HTTP. The +server.ts route is a thin
// wrapper that parses the request, calls this, sets the session cookie, and returns JSON.

import { isValidColor, SINGER_COLORS, type Singer } from '@encore/shared';
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
	const color = isValidColor(input.color) ? input.color : SINGER_COLORS[0];

	const singer = app.singers.create(name, color, app.now());
	app.publish({ type: 'singer:joined', singer });
	return { singer };
}
