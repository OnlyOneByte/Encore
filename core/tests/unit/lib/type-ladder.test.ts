import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * The `--ph-text-*` ladder keeps its 12px floor, keeps its retired rung retired, and keeps the
 * 24 -> 41.6px hole above `2xl` on the record as OPEN rather than quietly closed or quietly forgotten.
 *
 * Two shapes are ruled out (docs/UI-DESIGN.md §3): a crowded bottom (the retired `2xs` put four rungs inside 3.5px,
 * the lowest 10.88px) and a rung minted in the hole at the top before anything reads it (the hole is one step of
 * 1.7333 where nothing else on the ladder steps wider than 1.2). The hole stays open BY RULING: `--ph-text-3xl` has
 * a single font-size site in the whole app and is a DISPLAY size rather than the ladder's next reading step — so an
 * intermediate rung would be declared and read by nothing, the defect `--shadow-md` was until it was deleted.
 *
 * An open-by-ruling gap makes the RECORD the deliverable, and a record is the thing that rots. So this file pins the
 * arithmetic app.css declares, the ladder table docs/UI-DESIGN.md §3 quotes from it, and the one fact the
 * ruling rests on. Minting a rung in the hole, or giving `3xl` a second caller, reds here — which forces the
 * ruling in docs/UI-DESIGN.md §3 to be re-read rather than left behind as a false statement.
 *
 * Sizes only. Nothing here measures a rendered glyph; `bun test` has no layout, and the px figures below are
 * arithmetic on the declarations at the default root.
 */

const appCss = readFileSync(at('src/app.css'), 'utf8');
const frontend = readFileSync(at('../docs/FRONTEND.md'), 'utf8');
const design = readFileSync(at('../docs/UI-DESIGN.md'), 'utf8');

/** `html` declares no font-size — `body` is `font-size: 100%`, deliberately (SC 1.4.4) — so a rem on this ladder
 *  is 16px at default browser settings, which is the basis every px figure in the prose uses. */
const ROOT_PX = 16;

/** The minimum adjacent step this ladder is held to, stated in `app.css` beside the declarations. The `--space-*`
 *  ladder's floor is 1.20; type can be finer because it spans 12px to 41.6px rather than 2px to 24px. */
const MIN_RATIO = 1.09;

/** Every `--ph-text-<name>: <n>rem;` declaration in `app.css`, in source order. */
function ladder(): { name: string; rem: number; px: number }[] {
	return [...appCss.matchAll(/(?<![a-z-])--ph-text-([a-z0-9]+):\s*([\d.]+)rem;/g)].map((m) => ({
		name: m[1]!,
		rem: Number(m[2]),
		px: Number(m[2]) * ROOT_PX
	}));
}

/** Files under `src/` that spell a needle literally, comments included — used to prove a token is UNREACHABLE. */
function filesSpelling(needle: string): string[] {
	return readdirSync(at('src'), { recursive: true, encoding: 'utf8' })
		.filter((p) => /\.(css|svelte|ts)$/.test(p))
		.filter((p) => readFileSync(at(`src/${p}`), 'utf8').includes(needle));
}

/** A RULE SITE sets an element's size: a `font-size` declaration, or a Tailwind `text-[length:…]` under
 *  `components/ui/` (which compiles to a real `font-size`). Comments are stripped first — this file's own prose
 *  quotes `var(--ph-text-sm)` and `var(--ph-text-3xl)`, and a census that counts its own commentary is how the
 *  `--space-*` block came to claim 248 while grep said 250. The `@theme` bridge alias is not a rule site either:
 *  `--text-ph-sm: var(--ph-text-sm)` renames the rung and sizes nothing. */
function ruleSites(name: string): string[] {
	const font = new RegExp(`font-size:\\s*var\\(--ph-text-${name}\\)`, 'g');
	const util = new RegExp(`text-\\[length:var\\(--ph-text-${name}\\)\\]`, 'g');
	const out: string[] = [];
	for (const p of readdirSync(at('src'), { recursive: true, encoding: 'utf8' })) {
		if (!/\.(css|svelte|ts)$/.test(p)) continue;
		const body = readFileSync(at(`src/${p}`), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/<!--[\s\S]*?-->/g, '');
		for (const _ of body.matchAll(font)) out.push(p);
		for (const _ of body.matchAll(util)) out.push(p);
	}
	return out;
}

/* EVERY FIGURE IN THIS TEST IS READ FROM `app.css`'S OWN DECLARATIONS, so no component can red it — only an edit to
   the ladder, which is a design ruling that should stop the build. That is why the whole of it survived the
   count-to-invariant conversion untouched while the per-rung spend tally did not. */
test('the ladder is eight rungs, opens on the 12px floor, and no adjacent pair is closer than 1.09', () => {
	const rungs = ladder();
	expect(rungs.map((r) => r.name)).toEqual(['xs', 'sm', 'md', 'base', 'lg', 'xl', '2xl', '3xl']);
	expect(rungs.map((r) => r.rem)).toEqual([0.75, 0.82, 0.9, 1, 1.1, 1.25, 1.5, 2.6]);
	expect(rungs.map((r) => r.px)).toEqual([12, 13.12, 14.4, 16, 17.6, 20, 24, 41.6]);

	// THE FLOOR IS A RULE, not an observation: the ladder opens at 12px and nothing on it goes under.
	expect(Math.min(...rungs.map((r) => r.px))).toBe(12);
	// `base` and `2xl` are fixed points — the 16px form-control floor, and the join wordmark's `scale(0.667)`.
	expect(rungs.find((r) => r.name === 'base')!.px).toBe(16);
	expect(rungs.find((r) => r.name === '2xl')!.px).toBe(24);

	// Collected rather than asserted one at a time, so a regression names the pair AND the ratio.
	const ratios = rungs.slice(1).map((r, i) => [`${rungs[i]!.name}->${r.name}`, r.px / rungs[i]!.px] as const);
	expect(ratios.filter(([, v]) => v < MIN_RATIO - 1e-9)).toEqual([]);
	// The closest pair is xs -> sm, and 1.0933 is the digit app.css and docs/UI-DESIGN.md §3 both quote.
	const tightest = ratios.reduce((a, b) => (b[1] < a[1] ? b : a));
	expect(tightest[0]).toBe('xs->sm');
	expect(tightest[1]).toBeCloseTo(1.0933, 4);

	// No crowded bottom: the three rungs under base sit inside 2.4px, where the retired 2xs put four inside 3.5px.
	const subBase = rungs.filter((r) => r.px < 16);
	expect(subBase).toHaveLength(3);
	expect(subBase[subBase.length - 1]!.px - subBase[0]!.px).toBeCloseTo(2.4, 10);
});

test('`--ph-text-2xs` is retired: no declaration, no @theme alias, and no rule site', () => {
	expect(appCss).not.toMatch(/--ph-text-2xs:/);
	// The bridge alias outliving the rung would keep a `text-ph-2xs` utility minting 10.88px text.
	expect(appCss).not.toMatch(/--text-ph-2xs:/);
	// A caller would resolve to nothing and fall back to the inherited size, silently.
	expect(filesSpelling('var(--ph-text-2xs)')).toEqual([]);
	expect(ruleSites('2xs')).toEqual([]);
	/* A ONE, KEPT, and no ratio carries it: it says the retired name survives ONLY as `app.css`'s record that the
	   rung existed — the same idiom the two retired `--space-*` rungs use, and deleting that history is a separate
	   (and worse) loss. Any OTHER file naming it is either a resurrection or a stale copy of the history, and both
	   want a diff. Structurally this is a zero (zero files outside app.css), not a tally. */
	expect(filesSpelling('--ph-text-2xs')).toEqual(['app.css']);
});

test("the hole above 2xl is the ladder's only wide step, and 3xl still has the ONE caller the ruling rests on", () => {
	const rungs = ladder();
	// Nothing between the two. This is the assertion that reds when someone mints the 2rem rung that was tried
	// and removed — at which point the ruling in docs/UI-DESIGN.md §3 is what has to be revisited, not this line.
	expect(rungs.filter((r) => r.px > 24 && r.px < 41.6)).toEqual([]);

	const ratios = rungs.slice(1).map((r, i) => r.px / rungs[i]!.px);
	const top = ratios[ratios.length - 1]!;
	const widestOther = Math.max(...ratios.slice(0, -1));
	expect(top).toBeCloseTo(1.7333, 4);
	expect(widestOther).toBeCloseTo(1.2, 10); // xl -> 2xl
	expect(top / widestOther).toBeCloseTo(1.4444, 4);
	// And in absolute terms: one step of 17.6px sits above the 12px that the seven rungs xs..2xl share.
	expect(41.6 - 24).toBeCloseTo(17.6, 10);
	const upTo2xl = rungs.filter((r) => r.px <= 24);
	expect(upTo2xl).toHaveLength(7);
	expect(upTo2xl[6]!.px - upTo2xl[0]!.px).toBe(12);

	/* THE FACT THE RULING RESTS ON stays an exact list rather than a bound:
	   the hole stays open BECAUSE `3xl` is a display size with a single caller — /stats' hero tile,
	   sitting over that page's own secondary tiles at `2xl`. A SECOND caller makes the 24 -> 41.6px hole a real
	   reading step, so it must red here and send the reader back to docs/UI-DESIGN.md §3 rather than pass quietly.
	   Structurally a zero (zero second callers), which is why it is not the kind of count this file retired. */
	expect(ruleSites('3xl')).toEqual(['routes/stats/+page.svelte']);
	const stats = readFileSync(at('src/routes/stats/+page.svelte'), 'utf8');
	expect(stats).toContain('.primary .n {\n\t\tfont-size: var(--ph-text-3xl);');
	expect(stats).toContain('.n {\n\t\tfont-size: var(--ph-text-2xl);');
});

test('both records state the floor, the hole above 2xl as open by ruling, and its reason', () => {
	// The design doc's type section is where a reader goes to ask "is this gap a mistake?", so the ruling has to
	// be IN that section, beside the ladder it describes.
	const start = design.indexOf('## 3. The type ladder');
	const end = design.indexOf('## 4. ');
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	const typeSection = design.slice(start, end);
	expect(typeSection).toContain('12px is the floor');
	expect(typeSection).toContain('1.0933');
	// The open half has to be named, and with the reason it stays open, or "open" reads as forgotten.
	expect(typeSection).toContain('hole above `2xl` is open by ruling');
	expect(typeSection).toContain('exactly one font-size site');
	expect(typeSection).toContain('minted WITH its first caller');

	// The design-system contract says the same thing where the rule itself is stated.
	expect(frontend).toContain('and that gap is deliberately left open');
	expect(frontend).toContain('minted WITH its first caller');
});

test("docs/UI-DESIGN.md §3's ladder table quotes app.css's names, rem and px exactly", () => {
	/* A QUOTED FIGURE NO TEST HOLDS is the rot this file exists to stop: the table is the first thing a reader of §3
	   sees, and with only its prose pinned, editing `sm` to 0.85 / 13.6 left every test green. So each row is parsed
	   out of the fenced block and compared with `ladder()`, which reads the declarations themselves. */
	const typeSection = design.slice(design.indexOf('## 3. The type ladder'), design.indexOf('## 4. '));
	const block = /```\n([\s\S]*?)\n```/.exec(typeSection);
	expect(block).not.toBeNull();
	const rows = block![1]!.split('\n').map((line) => line.split(/\s+/).filter((t) => t !== '' && !/^·+$/.test(t)));
	expect(rows).toHaveLength(3);
	const [names, rem, px] = rows as [string[], string[], string[]];
	// The unit closes its row, so a row that lost or swapped its unit is a different table rather than a match.
	expect(rem.at(-1)).toBe('rem');
	expect(px.at(-1)).toBe('px');
	const rungs = ladder();
	expect(names).toEqual(rungs.map((r) => r.name));
	expect(rem.slice(0, -1).map(Number)).toEqual(rungs.map((r) => r.rem));
	expect(px.slice(0, -1).map(Number)).toEqual(rungs.map((r) => r.px));
});

test("every rung on the ladder is read, and `sm`'s three non-sites are each accounted for", () => {
	const rungs = ladder();
	/* A RUNG NOTHING READS is the defect the deleted `--shadow-md` was, which this file's prose refuses by name, and it
	   is the ground the 2rem rung was removed on. Asserted over the WHOLE ladder rather than as `sm`'s tally, which
	   is what used to sit here: `expect(ruleSites('sm')).toHaveLength(20)` reddened on every component that
	   legitimately took a secondary line, and the comment beside it reasoned about a leading term it described as
	   having already moved three times. */
	expect(rungs.filter((r) => ruleSites(r.name).length === 0)).toEqual([]);
	// AND THE CONVERSE: a `var(--ph-text-*)` naming no declaration falls back to the inherited size, silently.
	const spelled = new Set<string>();
	for (const p of readdirSync(at('src'), { recursive: true, encoding: 'utf8' })) {
		if (!/\.(css|svelte|ts)$/.test(p)) continue;
		const body = readFileSync(at(`src/${p}`), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/<!--[\s\S]*?-->/g, '');
		for (const m of body.matchAll(/var\(--ph-text-([a-z0-9]+)\)/g)) spelled.add(m[1]!);
	}
	expect([...spelled].filter((n) => !rungs.some((r) => r.name === n))).toEqual([]);

	/* `sm`'s THREE non-sites, named as FACTS rather than closed as arithmetic. The old form asserted
	   `linesSpelling === ruleSites + 3`, which held only while nobody added a comment mentioning the token or spelled
	   it outside a `font-size` — and it bought nothing the three facts below do not state directly. */
	expect(appCss).toContain('--text-ph-sm: var(--ph-text-sm);'); // the @theme bridge, which sizes nothing
	expect(appCss).toMatch(/--ph-text-sm:\s*0\.82rem;/); // the declaration itself
	expect(filesSpelling('--ph-text-sm')).toContain('lib/components/GuidingTrack.svelte');
	expect(ruleSites('sm')).not.toContain('lib/components/GuidingTrack.svelte'); // ...recording the move AWAY from it
});
