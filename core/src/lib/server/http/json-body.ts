// The body-parse step the POST/PATCH routes share. Four handlers each re-spelled "parse the JSON, degrade a
// malformed body to nothing, coerce a field to a string or treat it as absent" — three of them refusing an
// absent `mediaId` with the same 400. One definition, so the degrade rule cannot drift between them.

import { error } from '@sveltejs/kit';
import { isJsonBody } from './same-origin';

/** Refuse (415) a body that is not `application/json`, a missing Content-Type included, so a route never depends
 *  on hooks.server.ts alone to keep a cross-site form or no-cors post out. */
export function requireJsonType(request: Request): void {
	if (!request.headers.get('content-type') || !isJsonBody(request)) error(415, 'send application/json');
}

/**
 * A JSON request body as a bag of fields. An UNPARSEABLE body, or valid JSON that is not an object (`null`,
 * `[]`, `4`), degrades to `{}`, so a malformed request takes the caller's own required-field 400 rather than
 * escaping the handler as a 500.
 */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	requireJsonType(request);
	const body: unknown = await request.json().catch(() => ({}));
	return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** A string field, or `''` when absent or of another type — the shape a required-field 400 check wants. */
export function requiredString(body: Record<string, unknown>, field: string): string {
	const value = body[field];
	return typeof value === 'string' ? value : '';
}

/** A string field, or `undefined` when absent or of another type — for a genuinely optional one. */
export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
	const value = body[field];
	return typeof value === 'string' ? value : undefined;
}
