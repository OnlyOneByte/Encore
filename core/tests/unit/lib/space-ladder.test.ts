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
 *
 * THE PER-RUNG SPEND TALLY THAT USED TO LIVE AT THE FOOT OF THIS FILE IS GONE, and so is the exact gap pair. Both
 * reddened repeatedly through the phone-shell rebuild, every single time because a new component legitimately spent
 * a rung — a guard that cries wolf is a guard someone deletes. What replaced them: no undeclared rung is spelled, no
 * declared rung is unread, `md` stays top-three by spend so the one pair on the floor is still a visual ruling
 * rather than a cleanup, and at least three quarters of the rung-spelling gaps land wholly in the 4-12px band. The
 * figures `app.css` and `docs/FRONTEND.md` still print are HISTORY — readings taken as rungs were retired — and are
 * marked as such there, because a live tally in prose with no guard behind it is what rotted the last two.
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
	/* KEPT AS AN EXACT SET, and it cannot cry wolf: every figure in this test is read from `app.css`'s own
	   declarations, so no component can red it — only an edit to the ladder itself, which is a design ruling that
	   should stop the build. NAMING the pairs rather than counting them is what proves the clause `app.css` and
	   `docs/UI-DESIGN.md` §2 both state; a bare `toHaveLength(2)` said nothing about WHICH two. */
	const named = rungs.slice(1).map((r, i) => [`${rungs[i]!.name}->${r.name}`, r.px / rungs[i]!.px] as const);
	expect(
		named
			.filter(([, v]) => Math.abs(v - 1.2) < 1e-9)
			.map(([k]) => k)
			.sort()
	).toEqual(['4xl->5xl', 'md->lg']);
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

/** A SPEND is a rule that SIZES something, not a mention and not a rename. Two exclusions, and both are
 *  load-bearing:
 *
 *  COMMENTS, because the ladder's own prose quotes `var(--space-2xl)` — on this tree a raw grep finds 36 occurrences
 *  of that spelling and only 33 survive the strip, which is how the previous number in this comment came to be wrong.
 *
 *  THE `@theme` BRIDGE, for the reason `type-ladder.test.ts`'s `ruleSites()` already states about its own alias:
 *  `--spacing-md: var(--space-md)` RENAMES the rung and sizes nothing. It has to go, because the sibling test
 *  above REQUIRES one alias per declared rung — so counting the alias gave every rung a floor of 1 by
 *  construction, and the dead-rung zero below could not fail. Verified by falsification: with the bridge counted,
 *  rewriting away all three real `var(--space-5xl)` sites — a rung declared, aliased, and read by no rule, which is
 *  the defect the deleted `--shadow-md` was — left this file 5 pass / 0 fail. With it stripped, the same edit reds.
 *  Net effect on this tree: each of the nine rungs loses exactly its one alias, so `2xl` lands at 32 sizing rules of
 *  that 33, and the ladder's total at 221 of 230. */
function spends(): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const p of readdirSync(at('src'), { recursive: true, encoding: 'utf8' })) {
		if (!/\.(css|svelte|ts)$/.test(p)) continue;
		const body = readFileSync(at(`src/${p}`), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/--spacing-[a-z0-9]+:\s*var\(--space-[a-z0-9]+\);/g, '');
		for (const m of body.matchAll(/var\(--space-([a-z0-9]+)\)/g)) {
			counts[m[1]!] = (counts[m[1]!] ?? 0) + 1;
		}
	}
	return counts;
}

test('no rung is dead and no spelled rung is undeclared', () => {
	const rungs = ladder();
	const counts = spends();
	// A SPELLING OF A RUNG THAT DOES NOT EXIST resolves to nothing and collapses the box to zero on that axis. This
	// generalises the two named retirements above to every typo and every resurrection at once.
	expect(Object.keys(counts).filter((n) => !rungs.some((r) => r.name === n))).toEqual([]);
	// AND THE CONVERSE: a declared rung nothing reads is the defect the deleted `--shadow-md` was, refused by name,
	// and the ground the 2rem type rung was removed on. It bites only because `spends()` drops the `@theme` bridge —
	// see its comment, and the falsification recorded there. `5xl` is the rung with the least room: three rules.
	expect(rungs.filter((r) => !counts[r.name])).toEqual([]);
	/* A RANK, NOT A TALLY. What the old `counts.md === 40` carried is that collapsing `md` -> `lg` — the one pair
	   still exactly on the 1.20 floor, and the OPEN item `docs/FRONTEND.md` records — is a visual ruling over a busy
	   rung rather than a cleanup. Rank says that without printing a figure that moves whenever a component takes a
	   padding, and the headroom is larger than a swap: measured on this tree `md` is SECOND at 39 spends, behind `sm`'s
	   42 and ahead of `2xl`'s 32 and `2xs`'s 30. Leaving the top three needs TWO rungs to pass it, not one — a straight
	   md/2xl reorder leaves `md` third and this green — so `2xl` would need eight more spends AND `2xs` ten more, or
	   `md` would have to shed most of its own. That is the reorder worth being told about. */
	const bySpend = Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.map(([n]) => n);
	expect(bySpend.slice(0, 3)).toContain('md');
});

test('the gap register holds the 4-12px band, and no gap spells a rung off the ladder', () => {
	const VAL = Object.fromEntries(ladder().map((r) => [r.name, r.px]));
	let total = 0;
	let inBand = 0;
	const rungsUsed = new Set<string>();
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
			ts.forEach((t) => rungsUsed.add(t));
			if (ts.every((t) => VAL[t]! >= 4 && VAL[t]! <= 12)) inBand += 1;
		}
	}
	// A zero here would make the floor below vacuous, which is the one way a fraction guard dies silently.
	expect(rungsUsed.size).toBeGreaterThan(0);
	// A TRUE ZERO, and the companion invariant worth having: every gap spells a rung the ladder declares. Note what
	// is NOT asserted — "every out-of-band gap is a SECTION gap" is false on this tree, because two of the ten
	// out-of-band gaps are BELOW the band (`3xs`/2px icon gaps in `TabBar` and `Trend`), not above it.
	expect([...rungsUsed].filter((t) => VAL[t] === undefined)).toEqual([]);
	/* A FLOOR, NOT A TALLY. This used to assert an exact pair and reddened on every feature that added a gap rule —
	   its own comment admitted as much. The finding it records is that retiring two rungs did not thin the histogram,
	   and the shape of that claim is "most gaps are small, because this is a 480px-max phone column of 8px-spaced
	   `.list-row`s". Three quarters sits below every reading ever taken here — 85.1% on this tree, 86.5% with the
	   now-playing sheet in it, 85.7% before the phone shell, 84.1% before the retirement — so it reds only if roughly
	   one gap in four leaves the control-cluster band, which is a register drift rather than a feature. */
	expect(inBand / total).toBeGreaterThanOrEqual(0.75);
});
