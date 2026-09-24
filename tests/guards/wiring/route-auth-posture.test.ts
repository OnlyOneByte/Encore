// guard: every HTTP route's auth posture is pinned per METHOD. Caught: deleting the gate on
// `POST /api/delete-media`, the hard-delete endpoint, reddened nothing. PER-METHOD, not per-file:
// `settings/+server.ts` gates `PUT` but its `GET` is `async () =>`, taking no arguments and so unable to
// read a cookie, and a per-file scan sees `bySessionToken` and reports the whole module protected. The
// registry is CLOSED — a route method with no entry FAILS — because the risk is a new endpoint arriving
// ungated. See docs/GUARDS.md#wiring-routes

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { filesUnder, relative } from '@encore/test-support';

type Posture = 'session' | 'capability' | 'none';

/**
 * The gate each route METHOD is expected to apply. `none` is legitimate and always carries WHY, quoted
 * from the route where the route states its own reasoning so the two cannot drift. An entry whose posture
 * is an OPEN QUESTION says so: an undecided posture recorded as decided is the failure this prevents.
 */
const POSTURE: Record<string, { gate: Posture; why: string }> = {
	'audit/[mediaId] GET': {
		gate: 'none',
		why: 'self-admittedly ungated: "there is no admin identity in Encore". The payload is one song\'s process history. OPEN: it also carries worker hostnames and raw error strings, which argues exceeds what the room can already see.'
	},
	'delete-media POST': {
		gate: 'session',
		why: 'hard delete of media from disk. The single most consequential endpoint on the surface, and the one whose gate could be deleted with no test failing before this file existed.'
	},
	'join POST': {
		gate: 'none',
		why: 'necessarily ungated — it is how a caller ACQUIRES a session. Gating it would make joining impossible.'
	},
	'leave GET': { gate: 'session', why: "acts on the caller's own session, so it needs to identify one." },
	'leave POST': { gate: 'session', why: "acts on the caller's own session, so it needs to identify one." },
	'library GET': {
		gate: 'none',
		why: 'the durable catalog for a just-loaded client that has received no broadcasts yet. Everything in it is already on the TV.'
	},
	'lyrics-reselect POST': { gate: 'session', why: 'queues work and attributes it to a singer.' },
	'process POST': { gate: 'session', why: 'queues a process, which is the most expensive work an actor can cause.' },
	'me GET': { gate: 'session', why: 'answers "who am I", which is meaningless without a session.' },
	'me PATCH': { gate: 'session', why: "mutates the caller's own singer record." },
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
		why: 'matches library and stats. NOTE: despite two files describing it as read-only, it persists a row per hit —, which asks for that to stop or be renamed, not for a gate.'
	},
	'settings GET': {
		gate: 'none',
		why: 'UNDECIDED, not decided. `GET` is `async () =>` and takes no arguments while `PUT` on the same path is capability-gated, and no comment in either file says that asymmetry was chosen. Recorded as `none` because that is what the code does; carries the question.'
	},
	'settings PUT': { gate: 'capability', why: 'writes deployment-wide configuration.' },
	'settings/room PUT': { gate: 'capability', why: 'writes room-scoped configuration.' },
	'stats GET': {
		gate: 'none',
		why: 'explicitly "the PUBLIC party stats", read-only and unauthenticated by its own header.'
	},
	'thumb GET': {
		gate: 'none',
		why: 'a thumbnail proxy over an https-only five-host allowlist with the cloud-metadata attack named in its comment. The allowlist, not a session, is what bounds it.'
	}
};

/**
 * Split a route module into its exported method handlers. These modules are flat, so a body runs until the
 * next `export const` or end of file — an assumption the mutation arm below asserts rather than trusts,
 * because merged handlers would let an ungated method inherit its neighbour's gate.
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
	const routes = filesUnder('src/routes/api', ['+server.ts']);
	// An empty walk yields no offenders, which reads exactly like a fully gated surface.
	expect(routes.length).toBeGreaterThan(10); // @nvf-floor routes.length

	const offenders: string[] = [];
	const seen = new Set<string>();
	let methodsChecked = 0;

	for (const abs of routes) {
		const route = relative(abs).replace('src/routes/api/', '').replace('/+server.ts', '');
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

	// A splitter that returned nothing would make the loop above clean.
	expect(methodsChecked).toBeGreaterThan(15); // @nvf-floor methodsChecked

	// The registry must not outlive its subject: a stale entry would silently excuse a future endpoint
	// that reuses the name.
	for (const key of Object.keys(POSTURE)) {
		if (!seen.has(key)) {
			offenders.push(`${key} is recorded here but no such route method exists — delete the entry.`);
		}
	}

	expect(offenders).toEqual([]);
});

test('the method splitter separates handlers, and does not let one inherit its neighbour gate', () => {
	// A gated handler followed by an ungated one: merged, the ungated GET reads as `session` and the guard
	// passes over an open endpoint.
	const src = [
		'export const PUT: RequestHandler = async ({ cookies }) => {',
		'\tconst s = app.singers.bySessionToken(cookies.get(SESSION_COOKIE));',
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
	// Order independence: the ungated handler first must not pick up the later gate either.
	const flipped = methodBodies([src.split('};')[1]! + '};', src.split('};')[0]! + '};'].join('\n'));
	expect(postureOf(flipped.GET ?? '')).toBe('none');
});

test('postureOf ranks a capability gate above a bare session check', () => {
	// A capability gate implies a session lookup, so a handler with both must report the STRONGER posture;
	// reporting `session` would let the capability gate be deleted with this guard green.
	expect(postureOf("const s = bySessionToken(c); if (!can({}, 'x')) return;")).toBe('capability');
	expect(postureOf('const s = bySessionToken(c);')).toBe('session');
	expect(postureOf('return json(app.settings.getEffective());')).toBe('none');
});
