// guard: the metrics tables have exactly ONE horizontal scroll container, and it is the page's own
// `.scroller`. See docs/GUARDS.md#vendored-component-seams.
//
// shadcn's `Table` renders its own `<div data-slot="table-container" class="… overflow-x-auto">` INSIDE
// `.scroller`, and because that wrapper is `w-full` it is exactly as wide, so it absorbed all the overflow
// and did all the scrolling while `.scroller` reported `scrollWidth === clientWidth`. Nothing was
// unreachable, but the page cannot own the scroll state of a box it does not render: the right-edge shadow
// that tells a phone user there are more columns is painted by `.scroller` and is dead the moment the
// inner container takes the overflow back.
//
// Invisible to `tsc` and `svelte-check` (it is CSS) and to every behavioural test, because the page still
// LOOKS right — the table scrolls, just from the wrong element. Re-vendoring the table, or tidying away a
// `:global` rule that appears to do nothing, restores it in one line.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';

const SRC = srcDir;
const METRICS = join(SRC, 'routes/metrics/+page.svelte');
const TABLE = join(SRC, 'lib/components/ui/table/table.svelte');

// ARM 1: the vendored component still ships the wrapper the rule below exists to neutralise.
test('shadcn Table still renders its own overflow-x-auto container, so the neutralising rule is not vacuous', () => {
	const table = readFileSync(TABLE, 'utf8');
	expect(table.includes('data-slot="table-container"'), 'the vendored table no longer renders a table-container').toBe(
		true
	);
	expect(
		/table-container[^>]*overflow-x-auto/.test(table),
		'the table-container no longer carries overflow-x-auto — if the vendor dropped it, delete the ' +
			'neutralising rule in routes/metrics/+page.svelte rather than leaving a rule that guards nothing'
	).toBe(true);
});

// ARM 2: the page neutralises it, so `.scroller` is the one scroll container.
test('the metrics page neutralises the inner container so .scroller owns the overflow', () => {
	const metrics = readFileSync(METRICS, 'utf8');
	const rule = metrics.match(/:global\(\.scroller \[data-slot='table-container'\]\)\s*\{([^}]*)\}/);
	expect(rule, 'routes/metrics/+page.svelte no longer neutralises the inner table-container').not.toBe(null);
	const body = rule![1];
	// Both halves: `overflow-x` stops it scrolling, and `width: auto` stops `w-full` pinning it to the
	// scroller's width so the table's min-width can push past it.
	expect(/overflow-x:\s*visible/.test(body), 'the inner container still has its own overflow-x').toBe(true);
	expect(/width:\s*auto/.test(body), 'the inner container is still w-full, so it cannot overflow').toBe(true);
});

// ARM 3: the affordance that depends on ARM 2.
test('.scroller still paints the right-edge scroll shadow that ARM 2 exists to enable', () => {
	const metrics = readFileSync(METRICS, 'utf8');
	const scroller = metrics.match(/\n\t\.scroller \{([\s\S]*?)\n\t\}/);
	expect(scroller, '.scroller rule is gone').not.toBe(null);
	const body = scroller![1];
	expect(/overflow-x:\s*auto/.test(body), '.scroller no longer scrolls').toBe(true);
	// A cover in the CONTENT's coordinate space over a shadow pinned to the viewport; either alone is not
	// the affordance, and `local` is what makes it honest at the end of the scroll.
	expect((body.match(/linear-gradient/g) ?? []).length, 'the cover+shadow pair is not both present').toBe(2);
	expect(/no-repeat local/.test(body), 'the cover is not painted in the content coordinate space').toBe(true);
	expect(/no-repeat scroll/.test(body), 'the shadow is not pinned to the scroll viewport').toBe(true);
});
