import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { at, read } from '$test';

/*
 * guard: a field label has ONE dress and ONE wording rule.
 *
 * THE DRESS. `app.css`'s `.control-label` and ui/field's `[data-slot='field-label']` render the same thing
 * (`--ph-text-md`, weight 500, sentence case, `--ink-dim`). `GuidingTrack` used to put an uppercase 0.1em
 * `--ph-text-xs` span — the SECTION register, `.grouphead`'s dress — INSIDE a real `[data-slot='field-label']`,
 * so a field label wore a heading's letterforms. Neither of its hosts AT THE TIME (the drawer, `/components`) rendered
 * a second field label, so nothing on screen contradicted it; the element it sat in was the whole evidence, which is
 * why the first test reads the MARKUP. `/queue` replaced the drawer and does render a second one, so the first test
 * now also asserts that the two AGREE — see its own note. The eyebrow is gone, and the rule is held TWO ways, because the two catch different
 * things. As ITSELF: no class dressed with `text-transform: uppercase` may sit on or inside a field label — that one
 * reaches every tracking value and the inline form, so it sees the defect in the disguises a row list cannot. And as
 * a ROW LIST: the exact set of 0.1em rules on each type ladder, which is the only thing that notices the register
 * SPREADING. A list reddens when a surface legitimately grows a section heading, and for a tripwire that is the point
 * rather than the flaw — the list is re-read and stays true. Neither alone is the whole rule.
 *
 * THE WORDING. Second person exactly when the value is the singer's OWN (`Your name`, `Your color`); a bare noun
 * for anything the room or the box owns. `/settings` passed `label="Color"` while the join screen passed
 * `label="Your color"` and `ColourRing` DEFAULTED to `Your color` — one control under two names on two screens,
 * with nothing recording which was canonical.
 *
 * Both halves are cheap to undo by accident from inside one component, which is what this file is for. Sources
 * are read as TEXT with comments stripped first: the prose in these files quotes both dresses and every label
 * string, so a census that counts comments counts the argument about the rule as instances of it.
 */

/** Comments out. An HTML comment in markup and a block comment in `<script>`/`<style>` both quote label copy. */
function strip(source: string): string {
	return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const guidingTrack = strip(read('src/lib/components/GuidingTrack.svelte'));
/* `/settings` IS THREE SCOPE ROUTES — the room scope at `/settings`, plus `/settings/you` and `/settings/server` —
   so the surface's labels are read as the three files joined. `read` throws when a subject is gone, so a renamed or
   deleted scope reds here rather than quietly shrinking the census below. */
const settings = ['+page.svelte', 'you/+page.svelte', 'server/+page.svelte']
	.map((f) => strip(read(`src/routes/settings/${f}`)))
	.join('\n');
const joinLanding = strip(read('src/lib/components/JoinLanding.svelte'));
const colourRing = strip(read('src/lib/components/ColourRing.svelte'));
const codeEntry = strip(read('src/lib/components/CodeEntry.svelte'));

/** The text a `<Field.Label>` renders, tags and whitespace flattened. Interpolations are left spelled as written:
 *  `Skip a quiet phone after · {graceLabel}` is one label whose tail is a value, not a second label. */
function fieldLabelTexts(source: string): string[] {
	return [...source.matchAll(/<Field\.Label[^>]*>([\s\S]*?)<\/Field\.Label\s*>/g)]
		.map((m) =>
			m[1]!
				.replace(/<[^>]*>/g, '')
				.replace(/\s+/g, ' ')
				.trim()
		)
		.filter((text) => text !== '{label}'); // `SelectField`'s own hole, were this ever pointed at that component
}

/** The `label` of every `<SelectField>` — `$lib/ui/SelectField.svelte` is the one registry-backed select shape, and
 *  it renders a real `<Field.Label>` whose text its caller supplies. */
function selectFieldLabels(source: string): string[] {
	return [...source.matchAll(/<SelectField\b[\s\S]{0,400}?\/>/g)]
		.map((m) => m[0].match(/label="([^"]*)"/)?.[1])
		.filter((label): label is string => label !== undefined);
}

test("GuidingTrack's rail label wears the field primitive's own dress, with no eyebrow inside it", () => {
	// The label's TEXT is a bare child of the primitive — no span, so nothing can override the dress.
	expect(guidingTrack).toMatch(/<Field\.Label data-inline for="guiding-track">\s*Guide\s*<span class="gt-val">/);
	// The section register's two properties are absent from the whole file, not merely from that row.
	expect(guidingTrack).not.toMatch(/text-transform|letter-spacing|class="lab"/);

	// ONE RUNG for the row: the value matches the rung `label.svelte` sets, so the label cannot outsize the reading
	// it labels (the objection the retired comment raised, and the reason the fix moved the VALUE up).
	expect(guidingTrack).toMatch(/\.gt-val \{[^}]*font-size: var\(--ph-text-md\);/);
	expect(read('src/lib/components/ui/label/label.svelte')).toContain('text-[length:var(--ph-text-md)]');
	expect(read('src/lib/components/ui/label/label.svelte')).toContain('font-medium');
	// `.gt-val` is `SEL.guideReadout`; a rename here silently unhooks p16's level reading.
	expect(read('tests/playwright/world/selectors.ts')).toContain("guideReadout: '.gt-val'");

	/* WHY THE MARKUP WAS THE EVIDENCE: when the eyebrow was retired, this row's two hosts were the now-playing sheet
	   and the dev gallery, and neither rendered a second field label — so the screen comparison that caught the You
	   card was not available, and the element the eyebrow sat in had to carry the whole argument.
	   THE HOSTS CHANGED AND SO DOES THE CLAIM. `/queue` replaced the sheet, and its now-playing card DOES render a
	   second field label: the key row's, directly above this one. So the comparison exists here now, and the thing
	   worth asserting is no longer "there is nothing to compare against" but that the two AGREE — which they do by
	   both deferring to a shared declaration rather than by two local copies happening to match. `.ctl-lab` was such a
	   copy, and it had already dropped `line-height`. The gallery's half of the original argument is unchanged. */
	const queue = strip(read('src/routes/queue/+page.svelte'));
	expect(queue).toContain('<span class="control-label">{facts.keyLabel}</span>');
	// No local re-declaration of the dress beside it — the defect the swap removed, asserted so it cannot come back.
	expect(queue).not.toMatch(/ctl-lab/);
	expect(strip(read('src/routes/components/+page.svelte'))).not.toMatch(
		/<Field\.Label|class="control-label"|<ColourRing|<CodeEntry/
	);
});

test('the section register never lands on a field label, in CSS or inline', () => {
	/* THE REGISTER IS NOT THE DEFECT — putting it on a FIELD LABEL is. This used to be held only by the row list that
	   now sits in the test BELOW, and a list cannot see the defect in its most likely disguise: that scan keys on the
	   literal `letter-spacing: 0.1em`, so `app.css`'s own `.grouphead` (0.14em), the television's rows
	   (0.16/0.18/0.2em) and /components' inline `.1em` sites are all invisible to it. So the list kept the WHERE and
	   this test took over the RULE; the gap the list's own comment recorded and could not close is closed here.
	   It states the RULE directly: a class dressed in the SECTION register may not appear on, or anywhere inside, a
	   `<Field.Label>` or a `.control-label`. It keys on `text-transform: uppercase`, which is the register's defining
	   property and the one `app.css` names, so it reaches every tracking value and the inline form too. A `.grouphead`
	   over a list and an eyebrow over a block are what the register is FOR, and THIS guard lets them grow freely — the
	   row list below is the one that asks to be re-read when they do. */
	function registerClasses(body: string): string[] {
		const out = new Set<string>();
		for (const rule of body.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
			if (!/text-transform:\s*uppercase/.test(rule[2]!)) continue;
			for (const c of rule[1]!.matchAll(/\.([a-zA-Z][\w-]*)/g)) out.add(c[1]!);
		}
		return [...out];
	}
	/** A field label's WHOLE element, so a dressed class INSIDE it is caught and not just one ON it — the F7 defect
	 *  was a dressed `<span>` nested in the label, not the label itself. */
	function labelSubtrees(body: string): string[] {
		const out: string[] = [];
		for (const m of body.matchAll(/<Field\.Label\b[\s\S]*?<\/Field\.Label\s*>/g)) out.push(m[0]);
		for (const m of body.matchAll(/<(\w+)[^>]*class="[^"]*\bcontrol-label\b[^"]*"[\s\S]*?<\/\1\s*>/g)) out.push(m[0]);
		return out;
	}
	/* KNOWN GAP, recorded rather than claimed away: the rule regex cannot see inside a nested block, so a
	   `text-transform: uppercase` rule nested in an `@media` is invisible to it. Harmless by DIRECTION rather than by
	   luck — the assertion below is a ZERO, so a class the scan misses can only cause a false PASS, never a false
	   red. Verified on this tree: `app.css`'s only register class is its unnested `.grouphead`. */
	const globalRegister = registerClasses(strip(readFileSync(at('src/app.css'), 'utf8')));
	const offenders: string[] = [];
	let carriers = 0;
	for (const rel of readdirSync(at('src'), { recursive: true, encoding: 'utf8' })) {
		if (!/\.svelte$/.test(rel)) continue;
		const body = strip(readFileSync(at('src', rel), 'utf8'));
		// app.css's register classes are GLOBAL, so they are checked against every file's markup, not just its own;
		// a file's own scoped register classes reach only that file, which is what Svelte's hashing guarantees.
		const dressed = [...new Set([...registerClasses(body), ...globalRegister])];
		for (const sub of labelSubtrees(body)) {
			carriers += 1;
			for (const c of dressed) if (new RegExp(`class="[^"]*\\b${c}\\b`).test(sub)) offenders.push(`${rel} .${c}`);
			if (/style="[^"]*text-transform:\s*uppercase/i.test(sub)) offenders.push(`${rel} inline uppercase`);
		}
	}
	// A ZERO IS ONLY WORTH SOMETHING IF THE SCAN FOUND ANYTHING, so the carrier count is asserted as a FLOOR and not
	// as a tally. A markup idiom change that made `labelSubtrees` match nothing would otherwise pass silently
	// forever. Re-derived on this tree: 20 carriers across nine files, the three /settings scope routes holding
	// fourteen of them and `SelectField` — the one shape all fourteen selects render through — holding one.
	expect(carriers).toBeGreaterThanOrEqual(5);
	expect(offenders).toEqual([]);

	// AND THE PREDICATE STILL BITES, proved on the F7 shape itself rather than on a defect that no longer exists:
	// GuidingTrack rendered exactly this, an uppercase letterspaced span inside a real field label.
	const f7Css = '.lab { font-size: var(--ph-text-xs); letter-spacing: 0.1em; text-transform: uppercase; }';
	const f7Markup = '<Field.Label for="g">Guiding track <span class="lab">50%</span></Field.Label>';
	expect(registerClasses(f7Css)).toContain('lab');
	expect(labelSubtrees(f7Markup)).toHaveLength(1);
	expect(labelSubtrees(f7Markup).some((s) => /class="[^"]*\blab\b/.test(s))).toBe(true);
});

test('the 0.1em register is an exact set on each ladder, and no row of it labels a control', () => {
	/* THE ENUMERATION, kept as an enumeration. The test above states the RULE and is the better guard against the F7
	   defect returning — it reaches every tracking value and the inline form, which this cannot. This one answers a
	   different question: WHERE the register currently is. It is a review tripwire, and reddening when a surface grows
	   a section heading is what it is FOR rather than a flaw in it — the row arrives, someone reads the list, and the
	   list stays true. The two are not redundant: the rule cannot notice the register spreading across the app, and
	   the enumeration cannot notice it landing inside a label.
	   WHY THE SPLIT ON `--ph-text-*`: the television runs its own type ladder, so a 0.1em row there says nothing about
	   the phone's register and the claim has to be scoped or it means nothing. */
	const onPhLadder: string[] = [];
	const onTvLadder: string[] = [];
	for (const rel of readdirSync(at('src'), { recursive: true, encoding: 'utf8' })) {
		if (!/\.(css|svelte)$/.test(rel)) continue;
		for (const rule of strip(readFileSync(at('src', rel), 'utf8')).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
			if (!/letter-spacing:\s*0\.1em/.test(rule[2]!)) continue;
			const selector = rule[1]!.trim().split('\n').pop()!.trim();
			(/var\(--ph-text-/.test(rule[2]!) ? onPhLadder : onTvLadder).push(`${rel} ${selector}`);
		}
	}
	/* RE-DERIVED, AND IT GREW RATHER THAN SHRANK — which is the thing worth recording here, because the obvious
	   expectation was the opposite. The now-playing sheet's `.key .lab` row left with the sheet (-1), and the new
	   `/queue` tab brought TWO (+2): a `.grouphead` over the queue list and a `.now-eyebrow` over the now-playing
	   card. Both are section headings over blocks, which is precisely what the register is for, so the growth is
	   correct and the old "exactly two, a third means the eyebrow came back" reading of this list no longer holds.
	   What still holds is the clause below it: not one of these three sits on a field label. */
	// +1 with the on-deck card: its `.eyebrow` heads the card exactly as `.now-eyebrow` heads the one above it.
	expect(onPhLadder.sort()).toEqual([
		'lib/components/OnDeckCard.svelte .eyebrow',
		'routes/queue/+page.svelte .grouphead',
		'routes/queue/+page.svelte .now-eyebrow',
		'routes/song/[mediaId]/+page.svelte .lab'
	]);
	// The television's rows are unchanged by the phone rebuild, and this is their only guard.
	expect(onTvLadder.sort()).toEqual(['lib/tv/TvProgress.svelte .pill .lab', 'routes/tv/+page.svelte .phrase-kick']);

	// The song page renders no field label at all, so its row cannot be one wearing the section register.
	expect(strip(read('src/routes/song/[mediaId]/+page.svelte'))).not.toMatch(/<Field\.Label|class="control-label"/);
	/* /queue DOES render one — the key row's `.control-label` — so its two rows are cleared PER ELEMENT instead of by
	   the file carrying no label at all. The test above holds this for the whole tree off the register's defining
	   property; this states it for the two rows this list enumerates, which is the claim that would otherwise be
	   left resting on a file-level absence that is no longer true. */
	const queueLabels = [
		...strip(read('src/routes/queue/+page.svelte')).matchAll(
			/<(\w+)[^>]*class="[^"]*\bcontrol-label\b[^"]*"[\s\S]*?<\/\1\s*>/g
		)
	].map((m) => m[0]);
	expect(queueLabels).toHaveLength(1);
	for (const row of ['grouphead', 'now-eyebrow']) {
		expect(queueLabels.some((label) => new RegExp(`\\b${row}\\b`).test(label))).toBe(false);
	}
});

test("the second person marks the singer's own two values, on both surfaces that edit them", () => {
	// The You scope's card, which was the divergent site on both strings.
	expect(settings).toContain('<Field.Label for="profile-name">Your name</Field.Label>');
	expect(settings).toMatch(/<ColourRing[\s\S]{0,80}label="Your color"/);
	// The join screen's identity pane, which already read this way.
	expect(joinLanding).toContain('<span class="control-label">Your name</span>');
	expect(joinLanding).toMatch(/<ColourRing[\s\S]{0,80}label="Your color"/);
	// The component default IS the rule, so a new caller that passes nothing lands on it.
	expect(colourRing).toMatch(/label = 'Your color'/);

	// And nothing the ROOM or the box owns takes it — including the same knob's room-scope label.
	const roomOrBox = [...fieldLabelTexts(settings), ...selectFieldLabels(settings), ...fieldLabelTexts(guidingTrack)]
		.filter((text) => text !== 'Your name')
		.filter((text) => /^Your\b/.test(text));
	expect(roomOrBox).toEqual([]);
	expect(codeEntry).toMatch(/label = 'Room code'/);
});

test('the field-label census is 33: 4 possessive, 29 bare, on exactly the two surfaces that edit them', () => {
	// Every label the app renders through either carrier, counted where it is WRITTEN.
	const census = [
		...fieldLabelTexts(settings), // every label the three scope routes spell inline
		...selectFieldLabels(settings), // every label they render through `SelectField`
		...fieldLabelTexts(guidingTrack), // the rail label, now the primitive's own text
		'Your name', // JoinLanding's `.control-label` over its wrapped Input
		'Room code', // CodeEntry's `.control-label`, its one call site passing the default's own wording
		'Your color', // ColourRing on the You scope
		'Your color' // ColourRing on the join screen
	];

	// THE TOTAL, re-derived on this tree and unmoved by either the phone rebuild or the settings split: 14 spelled
	// inline across the three scope routes, 14 more through `SelectField`, GuidingTrack's rail label, and the four
	// written below. Splitting one route into three moved labels between FILES and added none, which is why the
	// figure is the same 33 it was before — and why this census reads the three as one surface.
	expect(census).toHaveLength(33);

	const possessive = census.filter((text) => /^Your\b/.test(text));
	/* A CLOSED SET rather than a tally: this is 2 values × 2 surfaces, and it says no OTHER label may be possessive,
	   so it moves only when a surface that edits the singer's own name or colour is added or removed — exactly the
	   change that should force this rule to be re-read.
	   WHICH DIRECTION THIS ASSERTION ACTUALLY HOLDS, measured rather than assumed: the last four census entries are
	   WRITTEN here, not read from the tree, because neither `ColourRing` nor `JoinLanding`'s wrapped `Input` nor
	   `CodeEntry` renders a `<Field.Label>` or a `<SelectField>`, so the two readers above cannot reach them.
	   So this test proves only the OUTWARD direction — nothing else in the two readable carriers is possessive. The
	   inward direction (those four strings really being what the four sites pass) is held by the test ABOVE, which
	   reads each site's source; changing the You scope's `label="Your color"` to `"Color"` reds that one and not this
	   one. Two tests, one rule, and neither alone is the whole of it. */
	expect(possessive).toEqual(['Your name', 'Your name', 'Your color', 'Your color']);
	// And the bare remainder, which is also the non-vacuity check: the census has to have found the bare labels too,
	// or the filter above proves nothing.
	expect(census.length - possessive.length).toBe(29);
});
