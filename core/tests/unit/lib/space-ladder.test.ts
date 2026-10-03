import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: the `--space-*` ladder stays NINE rungs with no adjacent pair closer than 1.20, and the two rungs
 * retired to get there stay retired.
 *
 * The ladder ran eleven rungs — 2/4/6/8/10/12/14/16/18/20/24 — so its top half stepped by 2px and its closest
 * pair was 18 -> 20 at 1.111. Nothing about that was a decision: `--space-xl` (14) and `--space-3xl` (18) were
 * each doing a job a neighbour already did, 2px away from it, and `docs/FRONTEND.md` had grown a register table
 * that SANCTIONED four rungs (14/16/18/20) for one job. Retiring the two is cheap to undo by accident — a new
 * rung between `lg` and `2xl` looks like a reasonable local choice from inside one component — which is what
 * this guard is for. The ratio floor is the rule; the rung list is how the rule is spelled.
 */

const appCss = readFileSync(at('src/app.css'), 'utf8');

/** Every `--space-<name>: <n>px;` declaration in `app.css`, in source order. */
function ladder(): { name: string; px: number }[] {
	return [...appCss.matchAll(/(?<![a-z-])--space-([a-z0-9]+):\s*(\d+)px;/g)].map((m) => ({
		name: m[1]!,
		px: Number(m[2])
	}));
}

/** Files under `src/` that spell a needle literally. */
function filesSpelling(needle: string): string[] {
	return readdirSync(at('src'), { recursive: true, encoding: 'utf8' })
		.filter((p) => /\.(css|svelte|ts)$/.test(p))
		.filter((p) => readFileSync(at(`src/${p}`), 'utf8').includes(needle));
}

/** The minimum step this ladder is held to. `--ph-text-*` is held to 1.09; spacing spans 2px to 24px, so it can
 *  and must be coarser. Quoted in `app.css` beside the declarations and in `docs/FRONTEND.md`. */
const MIN_RATIO = 1.2;

test('the ladder is nine rungs, in order, and no adjacent pair is closer than 1.20', () => {
	const rungs = ladder();
	expect(rungs.map((r) => r.name)).toEqual(['3xs', '2xs', 'xs', 'sm', 'md', 'lg', '2xl', '4xl', '5xl']);
	expect(rungs.map((r) => r.px)).toEqual([2, 4, 6, 8, 10, 12, 16, 20, 24]);

	// Collected rather than asserted one at a time, so a regression names the pair AND the ratio.
	const tight = rungs
		.slice(1)
		.map((r, i) => [`${rungs[i]!.name}->${r.name}`, r.px / rungs[i]!.px] as const)
		.filter(([, ratio]) => ratio < MIN_RATIO - 1e-9);
	expect(tight).toEqual([]);

	// The two worst pairs sit exactly ON the floor, which is the number both prose sites quote. If a future rung
	// lifts this, the comments saying "the worst pair is 1.20" have to move with it.
	const ratios = rungs.slice(1).map((r, i) => r.px / rungs[i]!.px);
	expect(Math.min(...ratios)).toBeCloseTo(1.2, 10);
	expect(ratios.filter((r) => Math.abs(r - 1.2) < 1e-9)).toHaveLength(2);
});

test('`--space-xl` and `--space-3xl` are retired: no declaration, no caller, no @theme alias', () => {
	for (const retired of ['xl', '3xl']) {
		expect(appCss).not.toMatch(new RegExp(`--space-${retired}:`));
		expect(appCss).not.toMatch(new RegExp(`--spacing-${retired}:`));
		// A caller would resolve to nothing and silently collapse the box to zero on that axis.
		expect(filesSpelling(`var(--space-${retired})`)).toEqual([]);
	}
});

test('the @theme spacing bridge is 1:1 with the ladder, so no utility name outlives its rung', () => {
	const aliases = [...appCss.matchAll(/(?<![a-z-])--spacing-([a-z0-9]+):\s*var\(--space-([a-z0-9]+)\);/g)];
	// Every alias points at its own name — a crossed pair would make `p-lg` resolve to someone else's value.
	expect(aliases.map((m) => [m[1], m[2]])).toEqual(aliases.map((m) => [m[1], m[1]]));
	expect(aliases.map((m) => m[1])).toEqual(ladder().map((r) => r.name));
});

/** A SPEND is a declaration, not a mention: this block strips `/* … *␣/` and `<!-- … -->` first, because the
 *  ladder's own comments quote `var(--space-2xl)` and a census that counts its own prose reports 36 for a rung
 *  spent 33 times — which is how the previous number in that comment came to be wrong. */
function spends(): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const p of readdirSync(at('src'), { recursive: true, encoding: 'utf8' })) {
		if (!/\.(css|svelte|ts)$/.test(p)) continue;
		const body = readFileSync(at(`src/${p}`), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/<!--[\s\S]*?-->/g, '');
		for (const m of body.matchAll(/var\(--space-([a-z0-9]+)\)/g)) {
			counts[m[1]!] = (counts[m[1]!] ?? 0) + 1;
		}
	}
	return counts;
}

test('the census numbers app.css quotes are the ones the tree produces', () => {
	const counts = spends();
	// The spread `app.css` prints beside the ladder. Pinned here so the prose cannot rot the way "248" did while
	// the tree said 250 — this test is the thing that has to be edited for that comment to change.
	expect(counts).toEqual({
		sm: 47,
		md: 40,
		'2xl': 33,
		'2xs': 33,
		xs: 31,
		lg: 24,
		'3xs': 17,
		'4xl': 10,
		'5xl': 4
	});
	expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(239);
	// `md` at 40 is the OPEN item docs/FRONTEND.md records: the one pair still exactly on the 1.20 floor, and the
	// count is what makes collapsing it a visual ruling rather than a cleanup.
	expect(counts.md).toBe(40);
});

test('the gap census docs/FRONTEND.md quotes is the one the tree produces', () => {
	const VAL = Object.fromEntries(ladder().map((r) => [r.name, r.px]));
	let total = 0;
	let inBand = 0;
	for (const p of readdirSync(at('src'), { recursive: true, encoding: 'utf8' })) {
		if (!/\.(css|svelte|ts)$/.test(p)) continue;
		const body = readFileSync(at(`src/${p}`), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/<!--[\s\S]*?-->/g, '');
		const seen: string[][] = [];
		for (const m of body.matchAll(/(?:row-|column-)?gap:\s*([^;\n}]*)/g)) {
			const ts = [...m[1]!.matchAll(/var\(--space-([a-z0-9]+)\)/g)].map((x) => x[1]!);
			if (ts.length) seen.push(ts);
		}
		// A Tailwind arbitrary gap under components/ui compiles to a real gap, so it counts.
		for (const m of body.matchAll(/(?:gap|gap-x|gap-y)-\[var\(--space-([a-z0-9]+)\)\]/g)) {
			seen.push([m[1]!]);
		}
		for (const ts of seen) {
			total += 1;
			if (ts.every((t) => VAL[t]! >= 4 && VAL[t]! <= 12)) inBand += 1;
		}
	}
	// 54 of 63. Retiring two rungs did NOT thin this band — it was 53 of the same 63 before — and both figures are
	// quoted in docs/FRONTEND.md precisely so the rung count is not read as the measure of that finding.
	expect([inBand, total]).toEqual([54, 63]);
});
