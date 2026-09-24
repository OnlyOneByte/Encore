// guard: five sites described an enforcement that did not exist. Four named `fetcherFor` as the refusal,
// and it does not refuse: measured against the real helpers, `fetcherFor('spotify')` returns `'ytdlp'`,
// `needsFetch('spotify')` is true, and a Spotify ref forms `https://www.youtube.com/watch?v=…` — the bogus
// URI the whole fetcher registry exists to prevent. A fifth (fetchers.ts) asserted a spotify hit "is not
// materialised into a queueable media", which /api/search does on every query. A reader who believes
// either claim will not look for the gap that IS there, so the prose is the subject here: a
// comment-STRIPPED scan is the wrong shape, and each arm is anchored on the mechanism it names.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetcherFor, needsFetch, sourceUriFor, DEFAULT_FETCHER } from '$lib/contract';
import { at } from '@encore/test-support';

const REPO = at('.');

/** The five sites the finding names, each read from the real tree. */
const SITES = [
	'src/lib/contract/process/fetchers.ts',
	'src/lib/contract/core/types.ts',
	'src/lib/server/media/spotify.ts',
	'src/routes/api/search/+server.ts'
] as const;

const sources = new Map(SITES.map((rel) => [rel, readFileSync(join(REPO, rel), 'utf8')]));

test('F2 non-vacuous: all five named sites exist, are non-empty, and still discuss spotify', () => {
	// Without this sentinel a moved or renamed file passes every scan below on an empty read.
	for (const rel of SITES) {
		const src = sources.get(rel)!;
		expect(src.length).toBeGreaterThan(200);
		expect(src.toLowerCase()).toContain('spotify');
	}
});

/**
 * Every ±80-character context window around a refusal verb that also mentions `fetcherFor`. SYMMETRIC, not
 * a between-tokens match: the subject of "refuses" usually sits BEFORE the verb, so a forward-anchored regex
 * cuts off the word that says who refuses and reports a correctly-attributed sentence as a false claim.
 */
function refusalWindows(src: string): string[] {
	// Comment markers come off BEFORE the flatten, or a denial that WRAPS across two comment lines reads as
	// `does NOT // refuse` and `isDenial` misses its own negation. Plain sentences are unaffected.
	const flat = src.replace(/^[ \t]*(?:\/\/+|\*)[ \t]?/gm, ' ').replace(/\s+/g, ' ');
	const out: string[] = [];
	for (const m of flat.matchAll(/refus[a-z]*/gi)) {
		const at = m.index;
		const w = flat.slice(Math.max(0, at - 80), Math.min(flat.length, at + m[0].length + 80));
		if (/fetcherFor/.test(w)) out.push(w);
	}
	return out;
}

/**
 * Is this window innocent — does it NOT assert that `fetcherFor` refuses? Two ways, both needed because the
 * honest correction has to discuss the mechanism it refutes: the pairing is explicitly DENIED, or the
 * refusal is ATTRIBUTED to the real authority inside the same window, where the verb has another subject.
 */
function isInnocent(window: string): boolean {
	return isDenial(window) || /isProcessableSource/.test(window);
}

/** An explicit denial that the refusal belongs to `fetcherFor`. */
function isDenial(window: string): boolean {
	return /\b(does\s+not|do\s+not|doesn.t|never|no\s+longer|not)\s+refus/i.test(window);
}

test('F2 no site ASSERTS that fetcherFor refuses a spotify source (it returns the default)', () => {
	// Anchored on the mechanism within ~80 characters, so a re-introduction under different wording is still
	// caught: the false claim is the pairing of that function name with a refusal verb, however phrased. A
	// DENIED or otherwise-ATTRIBUTED window is allowed deliberately (see isInnocent) — banning the words
	// outright would push the next author into vagueness, which is what let a reader believe the enforcement
	// existed. The positive half below makes sure the denial is present rather than merely permitted.
	for (const rel of SITES) {
		const asserted = refusalWindows(sources.get(rel)!).filter((w) => !isInnocent(w));
		expect(asserted).toEqual([]);
	}
});

test('F2 the guard DISCRIMINATES — it still flags the exact prose that shipped', () => {
	// Or the two rules above could be passing because the matcher never fires. The five original sentences are
	// replayed verbatim: each must be caught, and each must survive its correction.
	const materializationClaim =
		'in practice a spotify SearchResult is not materialised into a queueable media (see /api/search)';
	const fetcherForClaims = [
		'so a spotify-sourced media is not directly processable - `fetcherFor` refuses it.',
		'`sourceRef` is the Spotify track id, which is NEVER fetched (fetcherFor refuses a spotify source).',
		'a spotify-sourced media is not processable (see requestProcess, and fetcherFor which refuses it)',
		'a spotify-sourced media is not processable (`fetcherFor` refuses it, `requestProcess` declines it).'
	];
	// four of the five are fetcherFor-attribution claims and must be flagged
	for (const s of fetcherForClaims) {
		expect(refusalWindows(s).filter((w) => !isInnocent(w))).not.toEqual([]);
	}
	// the fifth is the materialization denial, caught by the other ban
	expect(materializationClaim.replace(/\s+/g, ' ')).toMatch(/not\s+materiali[sz]ed/i);
});

test('F2 the denial is PRESENT where the false claim did the most damage', () => {
	// The positive half of the rule above: silence would satisfy the ban while leaving the next author free to
	// re-derive the same wrong conclusion from `if (source === 'spotify') return DEFAULT_FETCHER`, which reads
	// as a refusal until something says otherwise. fetchers.ts owns that line, so it carries the denial —
	// explicitly, not by attribution.
	const fetchers = sources.get('src/lib/contract/process/fetchers.ts')!;
	expect(refusalWindows(fetchers).filter(isDenial).length).toBeGreaterThan(0);
	// and it must say what the floor IS, not merely what it is not
	expect(fetchers).toMatch(/floor/i);
});

test('F2 no site claims a spotify hit is not materialized into a queueable media', () => {
	// /api/search materializes EVERY hit (`[...local,...yt,...spotify].map(...)`), sets it in mediaById and
	// upserts it, so it is durable and queueable. The fetchers.ts comment denied exactly that.
	for (const rel of SITES) {
		const flat = sources.get(rel)!.replace(/\s+/g, ' ');
		expect(flat).not.toMatch(/not\s+materiali[sz]ed/i);
		expect(flat).not.toMatch(/never\s+materiali[sz]ed/i);
	}
});

test('F2 the sites name the real authority instead', () => {
	// The positive half: correcting the prose to say nothing at all would pass both bans above while leaving a
	// reader with no pointer to where the rule actually lives.
	for (const rel of SITES) {
		expect(sources.get(rel)!).toContain('isProcessableSource');
	}
});

test('F2 the measurements the false claims contradicted still hold', () => {
	// These are the numbers that made the prose false, and they are DELIBERATE — the fetcher floor keeps
	// `fetcherFor`'s return type total. So they are pinned rather than "fixed": asserting
	// `fetcherFor('spotify') !== DEFAULT_FETCHER` would pin the opposite of the ratified design.
	expect(fetcherFor('spotify')).toBe(DEFAULT_FETCHER);
	expect(needsFetch('spotify')).toBe(true);
	expect(sourceUriFor({ source: 'spotify', sourceRef: '4uLU6hMCjMI75M1A2tKUQC' })).toBe(
		'https://www.youtube.com/watch?v=4uLU6hMCjMI75M1A2tKUQC'
	);
});

/*
 * A retired arm read `docs/DECISIONS.md` to check the ratified decision itself was untouched. The docs
 * cleanup deleted that file, so there is no prose left to compare — but THE DECISION IS STILL ENFORCED by
 * the arms above rather than by prose, which is the half that could actually break.
 */
