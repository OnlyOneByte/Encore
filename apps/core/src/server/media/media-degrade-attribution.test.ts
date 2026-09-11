// — a media degrade boundary must be ATTRIBUTABLE: the graceful-degrade return value stays
// exactly as documented ([] for an absent/failed source, 502 for a dead thumbnail upstream), but the
// FAILURE REASON must not be thrown away, or six different causes collapse to one indistinguishable
// observation. This directory has fixed exactly this class three times already — retention.ts:284
//, sidecar.ts:343, and ytdlp.ts — and each fix stopped at its own file. spotify.ts and
// thumbs.ts are the siblings #767 explicitly deferred ("a different file cluster and a future pass's
// business"); this guard pins them so a fourth silent copy cannot re-appear.
//
// Why a SOURCE SCAN and not only behaviour: the fix is behaviour-preserving — every return value is
// unchanged — so no behavioural test can red on it, which is exactly why nothing forced the three
// previous fixes to spread. This scan pins the attribution deterministically.
//
// The regions are sliced by brace balance (appToken, spotifySearch, serveThumb) so a neighbour cannot
// satisfy an arm, and comments are blanked (each block/line comment replaced by spaces, line count
// preserved) so a commented-out `catch {` or `!res.ok return` neither satisfies nor violates an arm.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

// import.meta.dir === apps/core/src/server/media
const MEDIA_DIR = import.meta.dir;
const SPOTIFY = stripComments(readFileSync(join(MEDIA_DIR, 'spotify.ts'), 'utf8'));
const THUMBS = stripComments(readFileSync(join(MEDIA_DIR, 'thumbs.ts'), 'utf8'));

/**
 * Slice one function body out by brace balance, so a match cannot come from a neighbour. Skips the
 * PARAMETER LIST by paren balance first — spotifySearch's signature spans four lines and declares an
 * inline `opts: { ... }` type, so taking the first `{` after the name would close brace balance on
 * the signature and return a stub containing none of the code under guard. (Found by running this
 * guard, exactly as #767's sibling documents for ytDlpSearch.)
 */
function sliceFunction(src: string, name: string): string {
	const at = src.indexOf(`function ${name}(`);
	if (at < 0) return '';
	let parens = 0;
	let i = src.indexOf('(', at);
	for (; i < src.length; i++) {
		if (src[i] === '(') parens++;
		else if (src[i] === ')' && --parens === 0) break;
	}
	const open = src.indexOf('{', i);
	if (open < 0) return '';
	let depth = 0;
	for (let j = open; j < src.length; j++) {
		if (src[j] === '{') depth++;
		else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
	}
	return '';
}

/** File-relative 1-based line numbers of every match, so a citation matches `grep -n`. */
function offenderLines(src: string, region: string, re: RegExp): number[] {
	const start = src.indexOf(region);
	if (start < 0) return [];
	const prefixLines = src.slice(0, start).split('\n').length - 1;
	const out: number[] = [];
	for (const [i, line] of region.split('\n').entries()) {
		if (re.test(line)) out.push(prefixLines + i + 1);
	}
	return out;
}

const APP_TOKEN = sliceFunction(SPOTIFY, 'appToken');
const SPOTIFY_SEARCH = sliceFunction(SPOTIFY, 'spotifySearch');
const SERVE_THUMB = sliceFunction(THUMBS, 'serveThumb');

const REGIONS: [string, string, string][] = [
	['spotify.ts', 'appToken', APP_TOKEN],
	['spotify.ts', 'spotifySearch', SPOTIFY_SEARCH],
	['thumbs.ts', 'serveThumb', SERVE_THUMB]
];

// ── ARM 1: every catch inside a media degrade boundary binds its error ────────────────────────────

test('ARM 1: no bare `catch {` inside appToken / spotifySearch / serveThumb', () => {
	const offenders: string[] = [];
	for (const [file, name, region] of REGIONS) {
		const src = file === 'spotify.ts' ? SPOTIFY : THUMBS;
		for (const ln of offenderLines(src, region, /catch\s*\{/)) {
			offenders.push(`${file} ${name} (line ${ln}): } catch {`);
		}
	}
	// On base: spotify.ts appToken :101, spotify.ts spotifySearch :137, thumbs.ts serveThumb :79.
	expect(offenders).toEqual([]);
});

// ── ARM 2: every `!res.ok` refusal in those regions names res.status in its own statement ──────────

test('ARM 2: every `!res.ok` refusal in a guarded region names res.status', () => {
	const offenders: string[] = [];
	for (const [file, name, region] of REGIONS) {
		const src = file === 'spotify.ts' ? SPOTIFY : THUMBS;
		// Split the region into `if (!res.ok) { ... }` statements and require res.status inside the
		// block that the refusal opens — not merely somewhere in the region.
		const re = /if\s*\(\s*!res\.ok\s*\)\s*\{([\s\S]*?)\n\t*\}/g;
		let m: RegExpExecArray | null;
		let found = false;
		while ((m = re.exec(region)) !== null) {
			found = true;
			if (!/res\.status/.test(m[1])) {
				const ln = offenderLines(src, region, /if\s*\(\s*!res\.ok\s*\)/)[0] ?? 0;
				offenders.push(`${file} ${name} (line ${ln}): !res.ok refusal drops res.status`);
			}
		}
		// A one-line `if (!res.ok) return ...;` (base shape) has no block to match — catch it too.
		if (!found) {
			for (const ln of offenderLines(src, region, /if\s*\(\s*!res\.ok\s*\)\s*return/)) {
				offenders.push(`${file} ${name} (line ${ln}): one-line !res.ok refusal drops res.status`);
			}
		}
	}
	// On base: spotify.ts appToken :96, spotify.ts spotifySearch :135, thumbs.ts serveThumb :69.
	expect(offenders).toEqual([]);
});

// ── ARM 3: a specific failure cause is OBSERVABLE — the discriminating behavioural check ──────────

test('ARM 3: distinct Spotify token failures (401, 200-no-token) are observable, clean empty is not', async () => {
	const { spotifySearch, _resetSpotifyToken } = await import('./spotify');
	const env = { clientId: 'id', clientSecret: 'secret' };

	const warned: string[] = [];
	const origWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warned.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
	};
	try {
		// Cause A — bad credentials: the token endpoint 401s. Degrade value is still [], but it must warn.
		_resetSpotifyToken();
		const badCreds = (async () =>
			new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 })) as unknown as typeof fetch;
		const before = warned.length;
		const resA = await spotifySearch('abba', 10, { env, fetchImpl: badCreds, now: () => 0 });
		const linesA = warned.slice(before);
		expect(resA).toEqual([]); // degrade UNCHANGED
		expect(linesA.length).toBeGreaterThan(0); // but the reason is now observable
		expect(linesA.some((l) => l.includes('401'))).toBe(true);

		// Cause B — a 200 token response with NO access_token field: a malformed/unexpected token
		// response, not a credential refusal and not a miss. This exit (#872 named it: "give :98 its
		// warn too") falls between all three arms on a source scan — it is not a bare `catch {` (ARM 1)
		// and not a `!res.ok` (ARM 2) — so this drive is the one thing that keeps hunk #2's warn from
		// being reverted invisibly. Degrade value is still [].
		_resetSpotifyToken();
		const noToken = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
		const beforeB = warned.length;
		const resB = await spotifySearch('abba', 10, { env, fetchImpl: noToken, now: () => 0 });
		const linesB = warned.slice(beforeB);
		expect(resB).toEqual([]); // degrade UNCHANGED
		expect(linesB.length).toBeGreaterThan(0); // the reason is observable
		expect(linesB.some((l) => l.includes('no access_token'))).toBe(true);

		// Control — a healthy account with no match: 200 token, 200 search with an empty items list.
		// SAME [] observation, and it must stay SILENT so silence still carries "genuine empty".
		_resetSpotifyToken();
		const healthyEmpty = (async (input: string | URL | Request) => {
			const u = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
			if (u.includes('accounts.spotify.com'))
				return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
			return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
		}) as unknown as typeof fetch;
		const beforeC = warned.length;
		const resC = await spotifySearch('zzznomatchzzz', 10, { env, fetchImpl: healthyEmpty, now: () => 0 });
		const linesC = warned.slice(beforeC);
		expect(resC).toEqual([]);
		expect(linesC.length).toBe(0); // clean empty is byte-identical in VALUE but distinguishable in LOG
	} finally {
		console.warn = origWarn;
		_resetSpotifyToken();
	}
});

// ── Sentinels: all PASS on base, so no arm above can go green vacuously ───────────────────────────

test('sentinel 1: all three regions were sliced and each holds real code (>150 chars)', () => {
	// A rename or deletion reds here rather than silently emptying ARM 1/ARM 2's haystack.
	expect(APP_TOKEN.length).toBeGreaterThan(150);
	expect(SPOTIFY_SEARCH.length).toBeGreaterThan(150);
	expect(SERVE_THUMB.length).toBeGreaterThan(150);
});

test('sentinel 2: isAllowedThumbUrl sits OUTSIDE the guarded regions and keeps its bare catch', () => {
	// ARM 1 must neither be satisfiable by rewriting isAllowedThumbUrl nor demand that its legitimate
	// `try { new URL(u) } catch { return false }` predicate change — it is not a degrade boundary.
	const guard = sliceFunction(THUMBS, 'isAllowedThumbUrl');
	expect(guard.length).toBeGreaterThan(50);
	expect(/catch\s*\{/.test(guard)).toBe(true); // the pure-predicate bare catch is correct and stays
	expect(SERVE_THUMB.includes(guard)).toBe(false); // and it is not inside the guarded region
});

test('sentinel 3: the anchors still exist and each region still holds the degrade it attributes', () => {
	// Deleting the feature must red rather than pass.
	expect(SPOTIFY).toMatch(/export\s+async\s+function\s+spotifySearch\(/);
	expect(SPOTIFY).toMatch(/export\s+function\s+spotifyEnv\(/);
	expect(THUMBS).toMatch(/export\s+async\s+function\s+serveThumb\(/);
	expect(APP_TOKEN).toMatch(/return null/); // token helper's degrade signal
	expect(SPOTIFY_SEARCH).toMatch(/return \[\]/); // search's degrade value
	expect(SERVE_THUMB).toMatch(/status:\s*502/); // thumb proxy's degrade status
});

test('sentinel 4: the comment stripper removes a planted bare catch and !res.ok, preserving lines', () => {
	const planted = [
		'/* } catch { and if (!res.ok) return null; in a block comment',
		'   line two */',
		'// } catch { if (!res.ok) return [];'
	].join('\n');
	const stripped = stripComments(planted);
	expect(/catch\s*\{/.test(stripped)).toBe(false);
	expect(/!res\.ok/.test(stripped)).toBe(false);
	expect(stripped.split('\n')).toHaveLength(3); // line count preserved so citations match grep -n
});

test('sentinel 5: the creds-unset default exit is deliberately silent (not swept into an arm)', () => {
	// :122 (spotifyEnv → null) is the documented default deployment; a structural guard cannot decide
	// "this early return names a reason", and a warn per keystroke would be noise. Pin that it stays
	// a plain `return []` with no res.status/console.warn attached to the creds-unset branch.
	expect(SPOTIFY_SEARCH).toMatch(/if\s*\(\s*!env\s*\)\s*return \[\]/);
});
