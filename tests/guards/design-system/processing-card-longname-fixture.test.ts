// guard: the gallery renders a ProcessingCard carrying its queue controls AND a singer name at the full
// profile-name maxlength — the surface the identity dot's `flex: 0 0 auto` protects, which every long-name
// fixture being a QueueRow left un-eyes-on. The demo name must be an UNBROKEN token: a name WITH spaces
// wraps and merely shrinks the dot to ~5.45px at 390px. The maxlength is read from repository.ts.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const PAGE = 'src/routes/components/+page.svelte';
const src = read(PAGE);

// The profile-name maxlength is what a real singer name can reach; the fixture must hit it.
const repo = read('src/lib/server/singers/repository.ts');
const maxLen = Number(repo.match(/\.slice\(0,\s*(\d+)\)/)![1]);

test('the gallery demos a ProcessingCard with actions AND an UNBROKEN maxlength singer name', () => {
	expect(maxLen).toBeGreaterThanOrEqual(1);
	// Every <ProcessingCard ...> element in the gallery, whole tag captured.
	const cards = [...src.matchAll(/<ProcessingCard\b[\s\S]*?\/>/g)].map((m) => m[0]);
	expect(cards.length).toBeGreaterThanOrEqual(1);

	// At least one card must render the actions cluster (which narrows `.who` enough to make the collapse
	// reachable), carry a singerName at the full maxlength, and have NO whitespace in that name.
	const covered = cards.some((card) => {
		const hasActions = /\breorderable\b/.test(card) && /\bonremove=/.test(card);
		const name = card.match(/singerName="([^"]*)"/)?.[1] ?? '';
		const unbroken = name.length > 0 && !/\s/.test(name);
		return hasActions && name.length >= maxLen && unbroken;
	});
	expect(covered).toBe(true);
});

test("ProcessingCard's identity-dot comment states the true 0px-collapse mechanism", () => {
	const CARD = 'src/lib/components/ProcessingCard.svelte';
	const card = read(CARD);

	// Isolate the identity-dot comment block so unrelated prose cannot satisfy or trip this.
	const start = card.indexOf('flex: 0 0 auto is load-bearing');
	expect(start).toBeGreaterThanOrEqual(0); // not vacuous: the comment must exist
	const end = card.indexOf('*/', start);
	expect(end).toBeGreaterThan(start);
	const comment = card.slice(start, end);

	// BAN the over-promises, wrap-tolerant so a re-line-wrapped restatement is still caught, and widened
	// past the literal pre-correction wording so a REWORDED falsehood ("bottoms out", "stops short of
	// vanishing") cannot slip through the truth-plus-contradiction shape past this same guard.
	const claimsNotZero =
		/(?:(?:does\s+not|doesn[\u2019']?t|cannot|can[\u2019']?t|never)(?:\s|\*|\t)+reach(?:es)?(?:\s|\*|\t)+0px)|(?:stops?(?:\s|\*|\t)+short(?:\s|\*|\t)+of(?:\s|\*|\t)+vanish)|(?:bottoms?(?:\s|\*|\t)+out)/i;
	const blamesTrio =
		/(?:lacks|omits|without|lacking|omitting)(?:\s|\*|\t|[A-Za-z0-9.,;:%()\u2192>=+*/-])*?(?:trio|three(?:\s|\*|\t)+declarations)/i;
	expect(claimsNotZero.test(comment)).toBe(false);
	expect(blamesTrio.test(comment)).toBe(false);

	// …and REQUIRE the truths: the dot DOES collapse to 0px, driven by an UNBROKEN name.
	const saysCollapses = /collapses?(?:\s|\*|\t)+to(?:\s|\*|\t)+0px/i;
	expect(saysCollapses.test(comment)).toBe(true);
	expect(/\bunbroken\b/i.test(comment)).toBe(true);
});
