// guard: the leave route's header comment must name only routes that exist.
//
// This repo has a documented habit of comments asserting behaviour the code does not deliver
//. The offender here was a header that documented `GET /api/leave/preview` — a route
// that has never existed. Under SvelteKit's filesystem router the GET/POST handlers in this file
// answer `/api/leave` (the directory), not a `/preview` sub-route, and there is no `preview/`
// directory on disk. This guard makes that class of drift machine-checkable:
//
//   (1) the false path string `leave/preview` must stay ABSENT from the file, and
//   (2) both live verbs (`GET /api/leave`, `POST /api/leave`) must stay PRESENT in the header, and
//   (3) every `/api/leave...`-style path this file's COMMENTS mention must resolve to a real route
//       on disk — so a future edit that documents another non-existent sub-route reds here too.
//
// It reads raw source (comments included) on purpose: the defect lives in a comment, so stripping
// comments would blind the guard to its whole subject.
import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { at, read } from '@encore/test-support';

// Was `at('apps/core/src/routes/api/leave/+server.ts')` — the subject was the handler this guard SAT BESIDE in
// apps/core/src/routes/api/leave, so the route is now named explicitly. `read` throws if it is absent,
// which matters here: this guard's whole subject is that file's header comment.
const SERVER = 'apps/core/src/routes/api/leave/+server.ts';
// The routes/ root, was `at('apps/core/src/routes')` from the leave leaf. A path claim like
// /api/leave still maps to <ROUTES>/api/leave. The existsSync below asserts TRUE, so a wrong root reds.
const ROUTES = at('apps/core/src/routes');

const src = read(SERVER);

test('the leave route header does not name the non-existent /api/leave/preview route', () => {
	expect(src).not.toContain('leave/preview');
});

test('the leave route header names both live verbs of /api/leave', () => {
	expect(src).toContain('GET /api/leave');
	expect(src).toContain('POST /api/leave');
});

test('every /api/leave... path the header comments name resolves to a route on disk', () => {
	// Only inspect comment lines — the header is where the route docs live.
	const commentLines = src.split('\n').filter((l) => l.trim().startsWith('//'));
	// Match an /api/leave path, optionally with a sub-segment (e.g. /api/leave/preview).
	const re = /\/api\/leave(?:\/[a-z0-9-]+)*/g;
	const claimed = new Set<string>();
	for (const line of commentLines) {
		for (const m of line.matchAll(re)) claimed.add(m[0]);
	}
	// At least the base path must be claimed, or the header stopped documenting the endpoint.
	expect(claimed.has('/api/leave')).toBe(true);
	for (const path of claimed) {
		// '/api/leave' -> ['api','leave'] -> routes/api/leave/+server.ts must exist.
		const segs = path.split('/').filter(Boolean);
		const dir = join(ROUTES, ...segs);
		const ok = existsSync(join(dir, '+server.ts'));
		expect(ok, `header names ${path} but ${path}/+server.ts does not exist`).toBe(true);
	}
});
