// guard: every HTTP route's auth posture is pinned, per METHOD — XR-API-12.
//
// WHY THIS EXISTS. There are 15 route modules under `routes/api`, carrying eight session checks and two
// capability gates, and before this file NO test in the repository asserted any of them. Deleting the gate
// on `POST /api/delete-media` — the hard-delete endpoint — reddened nothing.
//
// `capability-wiring.test.ts` looks like the guard that covers this and does not: it scans `hub.ts`, the
// websocket seam, which contains no route path at all. So the HTTP capability gates were unguarded while a
// file named after capability wiring passed.
//
// WHY PER-METHOD, NOT PER-FILE. `settings/+server.ts` is the case that forces it. `PUT` gates on
// `bySessionToken` plus `can('settings:write-global')`; `GET` in the same file is `async () =>` — it takes
// no arguments, so it cannot read a cookie and cannot gate. A per-file scan sees `bySessionToken` in the
// source and reports the whole module protected, which is exactly backwards for the method that answers
// deployment configuration to anyone who asks.
//
// THE REGISTRY IS CLOSED. A new route with no entry FAILS. That is the point: the risk is not an existing
// gate being removed, it is a new endpoint arriving ungated and nobody noticing, which is how seven of the
// eight current `none` postures came to be.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { filesUnder, relative } from '@encore/test-support';

type Posture = 'session' | 'capability' | 'none';

/**
 * The gate each route METHOD is expected to apply.
 *
 * `none` is a legitimate value and always carries WHY. Where the route states its own reasoning, the
 * reason is quoted from it rather than reinvented here, so the two cannot drift apart silently. Where the
 * posture is an OPEN QUESTION rather than a decision, the entry says so — an undecided posture recorded as
 * decided is the failure this registry is meant to prevent.
 */
const POSTURE: Record<string, { gate: Posture; why: string }> = {
	'audit/[mediaId] GET': {
		gate: 'none',
		why: 'self-admittedly ungated: "there is no admin identity in Encore". The payload is one song\'s cook history. OPEN: it also carries worker hostnames and raw error strings, which XR-API-11 argues exceeds what the room can already see.'
	},
	'delete-media POST': {
		gate: 'session',
		why: 'hard delete of media from disk. The single most consequential endpoint on the surface, and the one whose gate could be deleted with no test failing before this file existed.'
	},
	'join POST': {
		gate: 'none',
		why: 'necessarily ungated — it is how a caller ACQUIRES a session. Gating it would make joining impossible.'
	},
	'leave GET': { gate: 'session', why: 'acts on the caller\'s own session, so it needs to identify one.' },
	'leave POST': { gate: 'session', why: 'acts on the caller\'s own session, so it needs to identify one.' },
	'library GET': {
		gate: 'none',
		why: 'the durable catalog for a just-loaded client that has received no broadcasts yet. Everything in it is already on the TV.'
	},
	'lyrics-reselect POST': { gate: 'session', why: 'queues work and attributes it to a singer.' },
	'make-karaoke POST': { gate: 'session', why: 'queues a cook, which is the most expensive work an actor can cause.' },
	'me GET': { gate: 'session', why: 'answers "who am I", which is meaningless without a session.' },
	'me PATCH': { gate: 'session', why: 'mutates the caller\'s own singer record.' },
	'metrics GET': {
		gate: 'none',
		why: 'ungated "deliberately and temporarily" per its own header, for want of an admin identity. The word temporarily is the reason this entry exists rather than being waived.'
	},
	'room-preview GET': {
		gate: 'none',
		why: 'by design: it resolves a scanned join code for an UNJOINED guest, so requiring a session would defeat it. Discloses a head count and a couple of names.'
	},
	'search GET': {
		gate: 'none',
		why: 'matches library and stats. NOTE: despite two files describing it as read-only, it persists a row per hit — see XR-API-09, which asks for that to stop or be renamed, not for a gate.'
	},
	'settings GET': {
		gate: 'none',
		why: 'UNDECIDED, not decided. `GET` is `async () =>` and takes no arguments while `PUT` on the same path is capability-gated, and no comment in either file says that asymmetry was chosen. Recorded as `none` because that is what the code does; XR-API-11 carries the question.'
	},
	'settings PUT': { gate: 'capability', why: 'writes deployment-wide configuration.' },
	'settings/room PUT': { gate: 'capability', why: 'writes room-scoped configuration.' },
	'stats GET': { gate: 'none', why: 'explicitly "the PUBLIC party stats", read-only and unauthenticated by its own header.' },
	'thumb GET': {
		gate: 'none',
		why: 'a thumbnail proxy over an https-only five-host allowlist with the cloud-metadata attack named in its comment. The allowlist, not a session, is what bounds it.'
	}
};

/**
 * Split a route module into its exported method handlers.
 *
 * These modules are flat — one `export const METHOD` per handler at top level — so a handler's body runs
 * until the next `export const` or end of file. That assumption is asserted by a mutation arm below rather
 * than trusted, because a nested `export` would silently merge two handlers and could make an ungated one
 * inherit its neighbour's gate.
 */
function methodBodies(src: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /export const (GET|POST|PUT|PATCH|DELETE)\b/g;
	const marks = [...src.matchAll(re)];
	for (let i = 0; i < marks.length; i += 1) {
		const start = marks[i]!.index!;
		const end = i + 1 < marks.length ? marks[i + 1]!.index! : src.length;
		out[marks[i]![1]!] = src.slice(start, end);
	}
	return out;
}

function postureOf(body: string): Posture {
	if (/\bcan\(/.test(body)) return 'capability';
	if (/bySessionToken\(/.test(body)) return 'session';
	return 'none';
}

test('every API route method applies the auth gate this registry records', () => {
	const routes = filesUnder('apps/core/src/routes/api', ['+server.ts']);
	// Non-vacuity: the walk found the route tree. An empty walk yields no offenders, which reads exactly
	// like a surface whose every gate is correct.
	expect(routes.length).toBeGreaterThan(10); // @nvf-floor routes.length

	const offenders: string[] = [];
	const seen = new Set<string>();
	let methodsChecked = 0;

	for (const abs of routes) {
		const route = relative(abs)
			.replace('apps/core/src/routes/api/', '')
			.replace('/+server.ts', '');
		const bodies = methodBodies(readFileSync(abs, 'utf8'));
		for (const [method, body] of Object.entries(bodies)) {
			const key = `${route} ${method}`;
			seen.add(key);
			methodsChecked += 1;
			const actual = postureOf(body);
			const expected = POSTURE[key];
			if (!expected) {
				offenders.push(
					`${key} has NO entry in this registry. A new endpoint must state its auth posture here — ` +
						`including \`none\` with a reason. It currently applies: ${actual}.`
				);
				continue;
			}
			if (expected.gate !== actual) {
				offenders.push(
					`${key} applies \`${actual}\` but is recorded as \`${expected.gate}\`. Recorded reason: ` +
						`${expected.why} If the change is intended, change the record and say why; if it is not, ` +
						`this is a gate that moved without anyone noticing.`
				);
			}
		}
	}

	// Non-vacuity: methods were actually parsed. A splitter that returned nothing would make the loop clean.
	expect(methodsChecked).toBeGreaterThan(15); // @nvf-floor methodsChecked

	// And the registry does not outlive its subject: an entry for a route that is gone is dead weight that
	// would silently excuse a future endpoint reusing the name.
	for (const key of Object.keys(POSTURE)) {
		if (!seen.has(key)) {
			offenders.push(`${key} is recorded here but no such route method exists — delete the entry.`);
		}
	}

	expect(offenders).toEqual([]);
});

test('the method splitter separates handlers, and does not let one inherit its neighbour gate', () => {
	/*
	 * The load-bearing case: a gated handler followed by an ungated one. If the splitter merged them, the
	 * ungated GET would read as `session` and this guard would pass while the endpoint was open — the exact
	 * error a per-file scan makes on settings/+server.ts.
	 */
	const src = [
		"export const PUT: RequestHandler = async ({ cookies }) => {",
		"\tconst s = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));",
		"\tif (!can({ singerId: s?.id }, 'settings:write-global')) return json({}, { status: 401 });",
		'};',
		'export const GET: RequestHandler = async () => {',
		'\treturn json(app.settings.getEffective());',
		'};'
	].join('\n');
	const bodies = methodBodies(src);
	expect(Object.keys(bodies).sort()).toEqual(['GET', 'PUT']);
	expect(postureOf(bodies.PUT!)).toBe('capability');
	expect(postureOf(bodies.GET!)).toBe('none');
	// order independence: the ungated handler first must not pick up the later gate either
	const flipped = methodBodies([src.split('};')[1]! + '};', src.split('};')[0]! + '};'].join('\n'));
	expect(postureOf(flipped.GET ?? '')).toBe('none');
});

test('postureOf ranks a capability gate above a bare session check', () => {
	// A capability gate implies a session lookup, so a handler with both must report the stronger of the
	// two. Reporting `session` there would let a capability gate be deleted while this guard stayed green.
	expect(postureOf("const s = bySessionToken(c); if (!can({}, 'x')) return;")).toBe('capability');
	expect(postureOf('const s = bySessionToken(c);')).toBe('session');
	expect(postureOf('return json(app.settings.getEffective());')).toBe('none');
});
