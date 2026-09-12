// Guard: the components gallery must render a ProcessingCard that carries its queue controls AND a
// singer name at the full profile-name maxlength — the surface `.who i { flex: 0 0 auto }` protects.
//
// THE GAP THIS EXISTS FOR. The identity dot collapses to 0px only on a card whose
// actions cluster is present (it cuts `.who` to ~134px) with a name long enough to overflow it.
// Every long-name gallery fixture used to be a QueueRow, so this exact ProcessingCard surface was
// never eyes-on and the collapse could regress unseen. design-system.test.ts pins the CSS rule; this
// pins the DEMO that makes the rule's necessity visible, so a future edit can't quietly drop the
// long-name-with-actions card and restore the blind spot.
//
// The follow-up correction hardened this in two ways. (1) The demo name must be an UNBROKEN token
// (no whitespace): only
// an unbreakable name makes the dot absorb the ENTIRE deficit and collapse to 0px — the unmissable
// witness. A name WITH spaces wraps and merely shrinks the dot to ~5.45px (measured at 390px), a
// half-size dot an eye can miss, so a spaced name is too weak a demo for the rule the fixture guards.
// (2) A second test pins ProcessingCard.svelte's own comment to the true mechanism: the old comment
// claimed the dot "does NOT reach 0px here", which is false at the maxlength with an unbroken name,
// so the guard reds if that over-promise returns.
//
// A SOURCE SCAN because bun test has no Svelte compiler here: it reads the gallery source directly.
// The name-length threshold is read from repository.ts (the code's own single source of truth for the
// maxlength) rather than hard-coded, so the test cannot pass by coincidence if the maxlength moves.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// SIBLING READ, now named explicitly. This guard used to live in apps/core/src/routes/components/, so
// `at('apps/core/src/routes/components/+page.svelte')` meant "the gallery route next to me" — a subject nothing can
// infer from tests/. Confirmed present at this path before re-anchoring.
const PAGE = 'apps/core/src/routes/components/+page.svelte';
const src = read(PAGE);

// The profile-name maxlength is what a real singer name can reach; the fixture must hit it.
const repo = read('apps/core/src/server/singers/repository.ts');
const maxLen = Number(repo.match(/\.slice\(0,\s*(\d+)\)/)![1]);

test('the gallery demos a ProcessingCard with actions AND an UNBROKEN maxlength singer name', () => {
	expect(maxLen).toBeGreaterThanOrEqual(1);
	// Every <ProcessingCard ...> element in the gallery, whole tag captured.
	const cards = [...src.matchAll(/<ProcessingCard\b[\s\S]*?\/>/g)].map((m) => m[0]);
	expect(cards.length).toBeGreaterThanOrEqual(1);

	// At least one must (a) render the actions cluster (reorderable + onremove) — that is what
	// narrows `.who` enough to make the collapse reachable — (b) carry a singerName at the full
	// maxlength, the case that overflows the narrowed `.who`, AND (c) that name must contain NO
	// whitespace. Only an unbreakable name makes the dot collapse to 0px; a spaced name wraps
	// and only shrinks it to ~5.45px, so it is too weak a witness for the rule this fixture guards.
	const covered = cards.some((card) => {
		const hasActions = /\breorderable\b/.test(card) && /\bonremove=/.test(card);
		const name = card.match(/singerName="([^"]*)"/)?.[1] ?? '';
		const unbroken = name.length > 0 && !/\s/.test(name);
		return hasActions && name.length >= maxLen && unbroken;
	});
	expect(covered).toBe(true);
});

test("ProcessingCard's identity-dot comment states the true 0px-collapse mechanism", () => {
	const CARD = 'apps/core/src/lib/components/ProcessingCard.svelte';
	const card = read(CARD);

	// Isolate the `.who i` explanatory comment block so unrelated prose can't satisfy or trip us.
	const start = card.indexOf('flex: 0 0 auto is load-bearing');
	expect(start).toBeGreaterThanOrEqual(0); // not vacuous: the comment must exist
	const end = card.indexOf('*/', start);
	expect(end).toBeGreaterThan(start);
	const comment = card.slice(start, end);

	// BAN the false over-promises the original comment carried, wrap-tolerant so a
	// re-line-wrapped restatement is still caught. Both were literally present in the pre-correction text.
	// Bans widened past the literal pre-correction wording so a *reworded* falsehood ("bottoms out", "stops
	// short of vanishing", "omits those three declarations") can't slip the truth-plus-contradiction
	// shape an earlier correction shipped past this same guard. Sanity-checked: none of these match the corrected text.
	const claimsNotZero =
		/(?:(?:does\s+not|doesn[\u2019']?t|cannot|can[\u2019']?t|never)(?:\s|\*|\t)+reach(?:es)?(?:\s|\*|\t)+0px)|(?:stops?(?:\s|\*|\t)+short(?:\s|\*|\t)+of(?:\s|\*|\t)+vanish)|(?:bottoms?(?:\s|\*|\t)+out)/i;
	const blamesTrio =
		/(?:lacks|omits|without|lacking|omitting)(?:\s|\*|\t|[A-Za-z0-9.,;:%()\u2192>=+*/-])*?(?:trio|three(?:\s|\*|\t)+declarations)/i;
	expect(claimsNotZero.test(comment)).toBe(false);
	expect(blamesTrio.test(comment)).toBe(false);

	// REQUIRE the corrected truths: the dot DOES collapse to 0px, driven by an UNBROKEN name.
	const saysCollapses = /collapses?(?:\s|\*|\t)+to(?:\s|\*|\t)+0px/i;
	expect(saysCollapses.test(comment)).toBe(true);
	expect(/\bunbroken\b/i.test(comment)).toBe(true);
});
