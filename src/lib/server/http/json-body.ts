// The body-parse step the POST/PATCH routes share. Four handlers each re-spelled "parse the JSON, degrade a
// malformed body to nothing, coerce a field to a string or treat it as absent" — three of them refusing an
// absent `mediaId` with the same 400. One definition, so the degrade rule cannot drift between them.

/**
 * A JSON request body as a bag of fields. An UNPARSEABLE body degrades to `{}`, so a malformed request takes
 * the caller's own required-field 400 rather than escaping the handler as a 500.
 *
 * A body that is valid JSON but NOT an object (`null`, `[]`, `4`) is returned as parsed, so the caller's
 * first field read throws and SvelteKit answers 500 where 400 is the honest status. That gap predates this
 * helper and is left exactly as it was, because closing it changes a wire status — but it is now one edit
 * here rather than four.
 */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	return await request.json().catch(() => ({}));
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
