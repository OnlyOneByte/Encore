// Guard: the components gallery must render a ProcessingCard that carries its queue controls AND a
// singer name at the full profile-name maxlength — the surface `.who i { flex: 0 0 auto }` protects.
//
// THE GAP THIS EXISTS FOR (issue #216). The identity dot collapses to 0px only on a card whose
// actions cluster is present (it cuts `.who` to ~134px) with a name long enough to overflow it.
// Every long-name gallery fixture used to be a QueueRow, so this exact ProcessingCard surface was
// never eyes-on and the collapse could regress unseen. design-system.test.ts pins the CSS rule; this
// pins the DEMO that makes the rule's necessity visible, so a future edit can't quietly drop the
// long-name-with-actions card and restore the blind spot.
//
// A SOURCE SCAN because bun test has no Svelte compiler here: it reads the gallery source directly.
// The name-length threshold is read from repository.ts (the code's own single source of truth for the
// maxlength) rather than hard-coded, so the test cannot pass by coincidence if the maxlength moves.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = join(import.meta.dir, '+page.svelte');
const src = readFileSync(PAGE, 'utf8');

// The profile-name maxlength is what a real singer name can reach; the fixture must hit it.
const repo = readFileSync(
	join(import.meta.dir, '../../server/singers/repository.ts'),
	'utf8'
);
const maxLen = Number(repo.match(/\.slice\(0,\s*(\d+)\)/)![1]);

test('the gallery demos a ProcessingCard with actions AND a maxlength singer name', () => {
	expect(maxLen).toBeGreaterThanOrEqual(1);
	// Every <ProcessingCard ...> element in the gallery, whole tag captured.
	const cards = [...src.matchAll(/<ProcessingCard\b[\s\S]*?\/>/g)].map((m) => m[0]);
	expect(cards.length).toBeGreaterThanOrEqual(1);

	// At least one must (a) render the actions cluster (reorderable + onremove) — that is what
	// narrows `.who` enough to make the collapse reachable — and (b) carry a singerName at the
	// full maxlength, the case that actually overflows the narrowed `.who`.
	const covered = cards.some((card) => {
		const hasActions = /\breorderable\b/.test(card) && /\bonremove=/.test(card);
		const name = card.match(/singerName="([^"]*)"/)?.[1] ?? '';
		return hasActions && name.length >= maxLen;
	});
	expect(covered).toBe(true);
});
