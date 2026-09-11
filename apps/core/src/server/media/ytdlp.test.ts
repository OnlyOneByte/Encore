// Done-when: resolve memoizes; cache hit on repeat id. Plus parser + graceful degrade.
import { test, expect, spyOn } from 'bun:test';
import { parseSearchJson, ytDlpSearch, ytThumbnailUrl } from './ytdlp';

test('parseSearchJson parses one-json-object-per-line into SearchResults', () => {
	const lines = [
		JSON.stringify({ id: 'abc', title: 'Mr. Brightside', uploader: 'The Killers', duration: 222.6, view_count: 12345 }),
		JSON.stringify({ id: 'def', title: 'Dancing Queen', channel: 'ABBA', duration: 231 }),
		'', // blank line skipped
		'{ not json' // malformed skipped
	].join('\n');
	const r = parseSearchJson(lines);
	expect(r).toHaveLength(2);
	expect(r[0]).toEqual({
		source: 'youtube',
		sourceRef: 'abc',
		title: 'Mr. Brightside',
		artist: 'The Killers',
		durationSec: 223,
		thumbnail: 'https://i.ytimg.com/vi/abc/mqdefault.jpg',
		viewCount: 12345
	});
	expect(r[1]!.artist).toBe('ABBA');
	expect(r[1]!.durationSec).toBe(231);
	// no view_count in the payload → undefined, NOT 0. The row omits the chip rather than claiming zero.
	expect(r[1]!.viewCount).toBeUndefined();
});

/*
 * The thumbnail is DERIVED from the id and deliberately ignores what yt-dlp reported. This test pins
 * that decision because it looks like discarding data: `thumbnails[].at(-1)` is inconsistent in aspect
 * (measured: `hq720.jpg` 16:9 from a ytsearch3, letterboxed 4:3 `hqdefault.jpg` from a ytsearch1 for
 * the same video), oversized for an 84px slot, and signed with `?sqp=…&rs=…` — which the proxy's
 * URL-keyed disk cache would store as a separate file per signature. See ytThumbnailUrl.
 */
test('thumbnail is derived from the video id, ignoring the reported URLs', () => {
	const line = JSON.stringify({
		id: 'x',
		title: 'X',
		thumbnail: 'https://i.ytimg.com/vi/x/hqdefault.jpg?sqp=SIGNED',
		thumbnails: [{ url: 'low' }, { url: 'high' }]
	});
	expect(parseSearchJson(line)[0]!.thumbnail).toBe('https://i.ytimg.com/vi/x/mqdefault.jpg');
});

test('a result with no reported thumbnail still gets one', () => {
	const line = JSON.stringify({ id: 'noThumb', title: 'X' });
	expect(parseSearchJson(line)[0]!.thumbnail).toBe('https://i.ytimg.com/vi/noThumb/mqdefault.jpg');
});

test('ytThumbnailUrl escapes the id, so it cannot smuggle a path or a query', () => {
	expect(ytThumbnailUrl('../../etc/passwd')).toBe('https://i.ytimg.com/vi/..%2F..%2Fetc%2Fpasswd/mqdefault.jpg');
	expect(ytThumbnailUrl('a&b=c')).toBe('https://i.ytimg.com/vi/a%26b%3Dc/mqdefault.jpg');
});

test('a non-numeric view_count is dropped rather than rendered as NaN', () => {
	const line = JSON.stringify({ id: 'y', title: 'Y', view_count: 'lots' });
	expect(parseSearchJson(line)[0]!.viewCount).toBeUndefined();
});

test('objects without id are skipped', () => {
	expect(parseSearchJson(JSON.stringify({ title: 'no id' }))).toEqual([]);
});

test('GRACEFUL DEGRADE: search returns [] when yt-dlp is unavailable (no throw)', async () => {
	// The degrade is documented (module header, docs/HANDOFF.md:68) and #767 deliberately did NOT
	// change it: an unavailable binary still resolves to [] rather than rejecting.
	const r = await ytDlpSearch('anything', 5, { available: async () => false });
	expect(r).toEqual([]);
});

/*
 * — the four ways this function returns nothing must be TELLABLE APART.
 *
 * Before the fix the timeout was a hand-rolled `setTimeout(proc.kill())` whose result was discarded,
 * the spawn sat outside its own `try`, the exit code was never read and stderr was spawned as
 * 'ignore'. So a killed search, an unspawnable binary, a failed run and a genuinely empty result set
 * all resolved to the same silent `[]`. `parseSearchJson` drops the truncated trailing line of a
 * killed run (its per-line catch), so the killed case was byte-identical to a complete short one —
 * and YouTubeResolver caches that page for 5 minutes.
 *
 * The fakes below model a real child process the way spawn-capture.test.ts does. `timeoutMs` is
 * injected so the kill path is provable inside a test budget rather than the production 10s.
 */

/** A child that emits `stdout` immediately but NEVER exits on its own — only `kill()` ends it. */
function hungSpawn(stdout: string) {
	let resolveExited: (code: number) => void;
	const exited = new Promise<number>((r) => {
		resolveExited = r;
	});
	const stream = (text: string) =>
		new ReadableStream<Uint8Array>({
			start(c) {
				if (text) c.enqueue(new TextEncoder().encode(text));
				c.close();
			}
		});
	return {
		exited,
		get exitCode() {
			return null as number | null;
		},
		stdout: stream(stdout),
		stderr: stream(''),
		kill: () => resolveExited(143)
	} as unknown as ReturnType<typeof Bun.spawn>;
}

/** A child that has already finished with `code`. */
function doneSpawn(code: number, stdout = '', stderr = '') {
	const stream = (text: string) =>
		new ReadableStream<Uint8Array>({
			start(c) {
				if (text) c.enqueue(new TextEncoder().encode(text));
				c.close();
			}
		});
	return {
		exited: Promise.resolve(code),
		get exitCode() {
			return code;
		},
		stdout: stream(stdout),
		stderr: stream(stderr),
		kill: () => {}
	} as unknown as ReturnType<typeof Bun.spawn>;
}

const TWO_LINES_PLUS_TRUNCATED = [
	JSON.stringify({ id: 'aaa', title: 'A', duration: 100 }),
	JSON.stringify({ id: 'bbb', title: 'B', duration: 200 }),
	'{"id":"ccc","tit' // the third line, cut off mid-write by the kill — parseSearchJson drops it
].join('\n');

test('a search KILLED by the kill timer is reported as a timeout, not as a short page', async () => {
	const warn = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const r = await ytDlpSearch('hung query', 12, {
			spawn: () => hungSpawn(TWO_LINES_PLUS_TRUNCATED),
			available: async () => true,
			timeoutMs: 30
		});
		// Behaviour PRESERVED: the same partial page the hand-rolled body returned.
		expect(r.map((x) => x.sourceRef)).toEqual(['aaa', 'bbb']);
		// …but the kill is now visible, which is the whole point. Hard-coded expectations: '30ms' is
		// the budget this test chose and '2' is counted by hand from the fixture above, so neither is
		// derived by re-running the code's own arithmetic.
		const lines = warn.mock.calls.map((c) => c.join(' '));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('KILLED after 30ms');
		expect(lines[0]).toContain('2 result(s)');
		expect(lines[0]).toContain('"hung query"');
	} finally {
		warn.mockRestore();
	}
});

test('a search that CANNOT SPAWN is logged and degrades, instead of escaping the function', async () => {
	// The real trigger: yt-dlp present at the first probe (positive, cached for the process lifetime
	// on purpose) and gone by the time a search runs — `Bun.spawn` throws ENOENT synchronously, and
	// the old spawn sat outside its own `try`, so the rejection left this file entirely.
	const warn = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const boom = new Error('ENOENT: no such file or directory, posix_spawn yt-dlp');
		const r = await ytDlpSearch('gone', 12, {
			spawn: () => {
				throw boom;
			},
			available: async () => true
		});
		expect(r).toEqual([]); // still no throw out of this function
		const lines = warn.mock.calls.map((c) => c.map(String).join(' '));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('could not spawn despite a positive availability probe');
		expect(lines[0]).toContain('ENOENT');
	} finally {
		warn.mockRestore();
	}
});

test('a non-zero yt-dlp exit is attributed WITH its stderr', async () => {
	const warn = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const r = await ytDlpSearch('bad', 12, {
			spawn: () => doneSpawn(1, '', 'ERROR: Unable to extract yt initial data\n'),
			available: async () => true
		});
		expect(r).toEqual([]);
		const lines = warn.mock.calls.map((c) => c.join(' '));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('exited 1');
		expect(lines[0]).toContain('Unable to extract yt initial data');
	} finally {
		warn.mockRestore();
	}
});

test('a GENUINELY empty result set stays silent — that is what makes the other lines mean something', async () => {
	const warn = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const r = await ytDlpSearch('no such song', 12, {
			spawn: () => doneSpawn(0, ''),
			available: async () => true
		});
		expect(r).toEqual([]);
		expect(warn.mock.calls).toHaveLength(0);
	} finally {
		warn.mockRestore();
	}
});
