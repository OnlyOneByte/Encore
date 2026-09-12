import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { at, repoRoot } from '@encore/test-support';
import { contrastRatio } from '$lib/contract';
// The registry itself stays a TYPED default import, and it is the one path here that cannot go
// through an alias: `$lib/contract`'s exports map carries only `"."`, so a subpath import of this
// JSON does not resolve — the same reason `colour-tokens.test.ts` reaches it relatively. A wrong
// depth here fails loudly with `Cannot find module`, never silently.
import registry from '$lib/contract/presentation/player-palette-48.json';

/**
 * The 48-stop player palette registry (`XR-COL-01`), and the guards that keep its published figures
 * describing the surfaces the app actually paints (`XR-COL-04`).
 *
 * WHY THIS FILE EXISTS. The registry's figures were generated against the MOCKUP's surfaces
 * — `#060a18 / #131a2e / #1a2238` — not the app's `--bg / --card / --card2`. Nothing measured the
 * difference, so six stops shipped their `accent_ink` below AA on the real `--card`: Cobalt 4.473,
 * Denim 4.477, Rose 4.477, Orchid 4.481, Magenta 4.483, Fuchsia 4.490. The generator now READS the
 * three tokens out of `app.css`, and these tests are what make that unfalsifiable: change `--card`
 * without regenerating and the first test below reds naming both values.
 *
 * The ratios are recomputed here with production's own `contrastRatio` rather than read out of the
 * registry's `r_*` fields. A test that trusts the numbers the generator printed cannot catch a
 * generator that measured against the wrong surface — which is the whole of the mockup-surface defect.
 */

// The repo root, discovered by walking up for the `bunfig.toml` marker, rather than counted
// out of this file's own location as `at('.')`.
// Precedent for reading the token layer from a test outside .: `colors.test.ts`,
// `song-display.test.ts`.
const REPO = repoRoot;
const appCss = readFileSync(at('src/app.css'), 'utf8');

/**
 * Pull a `--name: #hex;` declaration out of `app.css`. Same shape as `colors.test.ts`'s reader, and
 * a local copy for the same stated reason: this package cannot import `.`'s helper across
 * the package boundary. Throws rather than defaulting, so a renamed token reds instead of leaving
 * the suite measuring a value nothing declares.
 */
function token(name: string): string {
	const m = appCss.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
	if (!m) throw new Error(`token --${name} not found in src/app.css (renamed? then update this guard)`);
	return m[1]!;
}

/** Role floors, from `XR-COL-05` (non-text) and `XR-COL-06` / `XR-COL-07` (text). */
const NON_TEXT = 3;
const AA = 4.5;

const CHROMATIC = registry.variants.chromatic;
const STOPS = CHROMATIC.stops;

test('the 48-stop registry is measured against the surfaces app.css paints: the registry surfaces ARE the app.css tokens — not the mockup values (XR-COL-04)', () => {
	// The assertion this file exists for. The generator reads these three tokens; this proves the
	// committed artifact was generated from the values the app still declares. Change `--card` in
	// `app.css` without regenerating and this reds, naming the declared and the recorded value.
	expect(registry.surfaces).toEqual({
		bg: token('bg'),
		card: token('card'),
		card2: token('card2')
	});
	// and specifically NOT the mockup surfaces that produced the six failures
	expect(registry.surfaces.card).not.toBe('#131a2e');
});

test('the 48-stop registry is measured against the surfaces app.css paints: all 48 stops carry a distinct, canonical fill (XR-COL-09)', () => {
	expect(STOPS.length).toBe(48);
	expect(new Set(STOPS.map((s) => s.fill)).size).toBe(48);
	expect(STOPS.filter((s) => !/^#[0-9a-f]{6}$/.test(s.fill))).toEqual([]);
});

const bg = token('bg');
const card = token('card');

test('every stop clears every role floor with margin > 0: fill is visible as an identity dot on --bg and on --card (XR-COL-05, 3:1)', () => {
	const weak = STOPS.filter(
		(s) => contrastRatio(s.fill, bg) <= NON_TEXT || contrastRatio(s.fill, card) <= NON_TEXT
	).map((s) => s.name);
	expect(weak).toEqual([]);
});

test('every stop clears every role floor with margin > 0: on_fill clears AA against its own fill (XR-COL-06, 4.5:1)', () => {
	// Surface-independent, so the surface remeasurement did not move it. Pinned here because it is one of the four
	// roles the registry claims to have measured, and nothing else measures it.
	const weak = STOPS.filter((s) => contrastRatio(s.on_fill, s.fill) <= AA).map((s) => s.name);
	expect(weak).toEqual([]);
});

test('every stop clears every role floor with margin > 0: accent_ink clears AA as text on the real --card (XR-COL-07, 4.5:1)', () => {
	const weak = STOPS.filter((s) => contrastRatio(s.accent_ink, card) <= AA).map((s) => s.name);
	expect(weak).toEqual([]);
});

test('every stop clears every role floor with margin > 0: the six stops named above now clear the real --card, and by more than a rounding error', () => {
	// The regression fixture. Each of these measured 4.47–4.49 against `--card` while the registry
	// recorded ~4.50 against the mockup card. `> AA` alone would have passed at 4.5000001, which is
	// exactly the margin that let a surface change go unnoticed, so the floor asserted here is the
	// generator's own `AA + INK_MARGIN`.
	const NAMED = ['Cobalt', 'Denim', 'Rose', 'Orchid', 'Magenta', 'Fuchsia'] as const;
	const measured = NAMED.map((name) => {
		const stop = STOPS.find((s) => s.name === name);
		if (!stop) throw new Error(`stop ${name} is gone from the registry — the owner ratified 48`);
		return [name, contrastRatio(stop.accent_ink, card)] as const;
	});
	expect(measured.filter(([, r]) => r < 4.55).map(([n]) => n)).toEqual([]);
});

test('every stop clears every role floor with margin > 0: the published r_* figures agree with a fresh measurement', () => {
	// Catches a hand-edited hex whose recorded ratio was not updated with it — the cheap half of
	// `XR-COL-02`, which runs without a Python interpreter.
	const drift = STOPS.filter(
		(s) =>
			Math.abs(contrastRatio(s.fill, bg) - s.r_dot_bg) > 0.005 ||
			Math.abs(contrastRatio(s.fill, card) - s.r_dot_card) > 0.005 ||
			Math.abs(contrastRatio(s.on_fill, s.fill) - s.r_label) > 0.005 ||
			Math.abs(contrastRatio(s.accent_ink, card) - s.r_ink_card) > 0.005
	).map((s) => s.name);
	expect(drift).toEqual([]);
});

test('every stop clears every role floor with margin > 0: the generator recorded zero failures against these surfaces', () => {
	expect(CHROMATIC.stats.failures).toEqual([]);
	expect(CHROMATIC.stats.unresolved).toEqual([]);
	expect(CHROMATIC.stats.surfaces).toEqual(registry.surfaces);
});

test('the registry regenerates byte-identically from its committed inputs (XR-COL-02)', () => {
	// "Generated, never hand-edited" is only true if a hand edit is detectable. This is the only
	// assertion that detects one, so it pays ~10s of interpreter time to run the real generator.
	const out = join(mkdtempSync(join(tmpdir(), 'palette-')), 'regenerated.json');
	const run = spawnSync('python3', [join(REPO, 'src/lib/contract/scripts/_player_palette.py')], {
		env: { ...process.env, PLAYER_PALETTE_OUT: out },
		encoding: 'utf8'
	});
	// A missing interpreter fails loudly rather than skipping: a silent skip is how this guard
	// would stop guarding without anyone noticing. `python3` is already a build prerequisite —
	// `worker` is a pytest suite.
	expect(run.error ?? null).toBeNull();
	expect(run.status).toBe(0);

	const committed = readFileSync(join(REPO, 'src/lib/contract/presentation/player-palette-48.json'), 'utf8');
	const regenerated = readFileSync(out, 'utf8');
	if (regenerated !== committed) {
		// Name the stop that differs, per XR-COL-02's acceptance, instead of dumping 42 KB of JSON.
		const a = JSON.parse(committed) as typeof registry;
		const b = JSON.parse(regenerated) as typeof registry;
		const differing = a.variants.chromatic.stops
			.map((s, i) => [s, b.variants.chromatic.stops[i]!] as const)
			.filter(([x, y]) => JSON.stringify(x) !== JSON.stringify(y))
			.map(([x]) => x.name);
		throw new Error(
			`committed registry is not what the generator produces. Differing chromatic stops: ` +
				`${differing.length ? differing.join(', ') : '(none — surfaces or stats block)'}. ` +
				`Run: python3 src/lib/contract/scripts/_player_palette.py`
		);
	}
	expect(regenerated).toBe(committed);
}, 60_000);
