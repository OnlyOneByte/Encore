// Guard for F2 — five sites described an enforcement that did not exist.
//
// With the not-cookable rule enforced in exactly ONE place, five other sites explained it. Four named
// `fetcherFor` as the refusal, and `fetcherFor` does not refuse: measured against the real helpers,
// `fetcherFor('spotify')` returns `'ytdlp'`, `needsFetch('spotify')` is `true`, and
// `sourceUriFor({ source: 'spotify', sourceRef: '4uLU…' })` forms
// `https://www.youtube.com/watch?v=4uLU…` — the bogus URI the whole fetcher registry exists to
// prevent. A fifth site (fetchers.ts) went further and asserted a spotify hit "is not materialised
// into a queueable media", which /api/search does on every query.
//
// This matters beyond tidiness, which is why it is guarded rather than just corrected: a reader who
// believes either claim will not look for the gap that IS there, and docs/DECISIONS.md is specifically
// the text a future author is told not to re-litigate. REVIEW.md §3 names "a credible-sounding
// docstring rationale" as the first trap, and the fetchers.ts comment was exactly that — a completed
// argument for why a live branch was dead code.
//
// A comment-STRIPPED scan is the wrong shape here, because the subject IS the comments. So this asserts
// the prose, anchored on the mechanism it names.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { fetcherFor, needsFetch, sourceUriFor, DEFAULT_FETCHER } from '$lib/contract';

// The old `const REPO = at('.')` is gone: SITES below are already
// repo-relative, so `read` takes them directly off the repo-root anchor. It also THROWS on a missing
// site, which reinforces the non-vacuity sentinel this file already carries — a moved or renamed file
// now reds as a path failure instead of reaching that sentinel at all.

/** The five sites the finding names, each read from the real tree. */
const SITES = [
	'src/lib/contract/cook/fetchers.ts',
	'src/lib/contract/core/types.ts',
	'src/lib/server/media/spotify.ts',
	'src/routes/api/search/+server.ts',
	'docs/DECISIONS.md'
] as const;

const sources = new Map(SITES.map((rel) => [rel, read(rel)]));

test('F2 non-vacuous: all five named sites exist, are non-empty, and still discuss spotify', () => {
	// Without this sentinel a moved or renamed file passes every scan below on an empty read, and the
	// guard silently stops guarding.
	for (const rel of SITES) {
		const src = sources.get(rel)!;
		expect(src.length).toBeGreaterThan(200);
		expect(src.toLowerCase()).toContain('spotify');
	}
});

/**
 * Every ±80-character context window around a refusal verb that also mentions `fetcherFor`.
 *
 * A SYMMETRIC window, not a between-tokens match: the subject of "refuses" usually sits BEFORE the
 * verb, so a regex anchored from the verb forwards cuts off the very word that says who refuses, and
 * then reports a correctly-attributed sentence as a false claim.
 */
function refusalWindows(src: string): string[] {
	const flat = src.replace(/\s+/g, ' ');
	const out: string[] = [];
	for (const m of flat.matchAll(/refus[a-z]*/gi)) {
		const at = m.index;
		const w = flat.slice(Math.max(0, at - 80), Math.min(flat.length, at + m[0].length + 80));
		if (/fetcherFor/.test(w)) out.push(w);
	}
	return out;
}

/**
 * Is this window innocent — i.e. does it NOT assert that `fetcherFor` refuses?
 *
 * Two ways to be innocent, and both are needed because the honest correction has to be able to discuss
 * the mechanism it refutes:
 *  - the pairing is explicitly DENIED ("`fetcherFor` does NOT refuse it"), or
 *  - the refusal is ATTRIBUTED to the real authority inside the same window, which is what a sentence
 *    like "`isCookableSource` … refuses it … (`fetcherFor` does not)" does — the verb has a different
 *    subject, and adjacency alone is not a claim about fetcherFor.
 */
function isInnocent(window: string): boolean {
	return isDenial(window) || /isCookableSource/.test(window);
}

/** An explicit denial that the refusal belongs to `fetcherFor`. */
function isDenial(window: string): boolean {
	return /\b(does\s+not|do\s+not|doesn.t|never|no\s+longer|not)\s+refus/i.test(window);
}

test('F2 no site ASSERTS that fetcherFor refuses a spotify source (it returns the default)', () => {
	// Anchored on the mechanism, within ~80 characters, so a re-introduction under different wording is
	// still caught — the false claim is the pairing of that function name with a refusal verb, however
	// it is phrased.
	//
	// A DENIED or otherwise-ATTRIBUTED window is allowed, deliberately (see isInnocent): a guard that
	// banned the words outright would push the next author into vagueness, and vagueness is what let a
	// reader believe the enforcement existed in the first place. The positive half below makes sure the
	// denial is actually present rather than merely permitted.
	for (const rel of SITES) {
		const asserted = refusalWindows(sources.get(rel)!).filter((w) => !isInnocent(w));
		expect(asserted).toEqual([]);
	}
});

test('F2 the guard DISCRIMINATES — it still flags the exact prose that shipped', () => {
	// Without this the two rules above could be passing because the matcher never fires. Replay the five
	// original sentences verbatim: each must be caught, and each must survive its correction. This is
	// the not-vacuous arm for a scan whose subject is prose.
	const materializationClaim =
		'in practice a spotify SearchResult is not materialised into a queueable media (see /api/search)';
	const fetcherForClaims = [
		'so a spotify-sourced media is not directly cookable - `fetcherFor` refuses it.',
		'`sourceRef` is the Spotify track id, which is NEVER fetched (fetcherFor refuses a spotify source).',
		'a spotify-sourced media is not cookable (see requestMakeKaraoke, and fetcherFor which refuses it)',
		'a spotify-sourced media is not cookable (`fetcherFor` refuses it, `requestMakeKaraoke` declines it).'
	];
	// four of the five are fetcherFor-attribution claims and must be flagged
	for (const s of fetcherForClaims) {
		expect(refusalWindows(s).filter((w) => !isInnocent(w))).not.toEqual([]);
	}
	// the fifth is the materialization denial, caught by the other ban
	expect(materializationClaim.replace(/\s+/g, ' ')).toMatch(/not\s+materiali[sz]ed/i);
});

test('F2 the denial is PRESENT where the false claim did the most damage', () => {
	// The positive half of the rule above: silence would satisfy the ban while leaving the next author
	// free to re-derive the same wrong conclusion from the `if (source === 'spotify') return
	// DEFAULT_FETCHER` line, which reads as a refusal until something says otherwise. fetchers.ts owns
	// that line, so fetchers.ts has to carry the denial — and in the explicit form, not by attribution.
	const fetchers = sources.get('src/lib/contract/cook/fetchers.ts')!;
	expect(refusalWindows(fetchers).filter(isDenial).length).toBeGreaterThan(0);
	// and it must say what the floor IS, not merely what it is not
	expect(fetchers).toMatch(/floor/i);
});

test('F2 no site claims a spotify hit is not materialized into a queueable media', () => {
	// /api/search materializes EVERY hit (`[...local, ...yt, ...spotify].map(...)`), sets it in
	// mediaById and upserts it, so it is durable and queueable. The fetchers.ts comment denied exactly
	// that, seven lines above the route comment that describes it.
	for (const rel of SITES) {
		const flat = sources.get(rel)!.replace(/\s+/g, ' ');
		expect(flat).not.toMatch(/not\s+materiali[sz]ed/i);
		expect(flat).not.toMatch(/never\s+materiali[sz]ed/i);
	}
});

test('F2 the sites name the real authority instead', () => {
	// The positive half: correcting the prose to say nothing at all would pass the two bans above while
	// leaving a reader with no pointer to where the rule actually lives. Every site must name it.
	for (const rel of SITES) {
		expect(sources.get(rel)!).toContain('isCookableSource');
	}
});

test('F2 the measurements the false claims contradicted still hold', () => {
	// These are the numbers that made the prose false, and they are DELIBERATE — the fetcher floor keeps
	// `fetcherFor`'s return type total. So this pins them rather than "fixing" them: asserting
	// `fetcherFor('spotify') !== DEFAULT_FETCHER` would pin the opposite of the ratified design, which
	// the issue says explicitly. It is the PROSE that was wrong, not the code it described.
	expect(fetcherFor('spotify')).toBe(DEFAULT_FETCHER);
	expect(needsFetch('spotify')).toBe(true);
	expect(sourceUriFor({ source: 'spotify', sourceRef: '4uLU6hMCjMI75M1A2tKUQC' })).toBe(
		'https://www.youtube.com/watch?v=4uLU6hMCjMI75M1A2tKUQC'
	);
});

test('F2 the ratified DECISION itself is untouched', () => {
	// The issue upholds the ratified decision and must not reopen it. Only the sentence describing HOW the rule is
	// enforced was wrong. If a later edit weakens the decision, this reds.
	const decisions = sources.get('docs/DECISIONS.md')!;
	expect(decisions).toMatch(/Spotify as a SEARCH \/ METADATA\s*source only|SEARCH \/ metadata\s*source only/i);
	expect(decisions).toMatch(/no `fetch:spotify` worker capability/);
	expect(decisions).toMatch(/bytes are\s*never pulled from Spotify/);
});
