import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { at, repoRoot } from '$test';
import { contrastRatio } from '$lib/contract';
// A subpath import: `$lib/contract`'s exports map carries only `"."`. A wrong path fails loudly with
// `Cannot find module`, never silently.
import registry from '$lib/contract/presentation/player-palette-48.json';

/*
 * guard: the 48-stop player palette registry's published figures describe the surfaces the app actually
 * paints. The figures were once generated against the MOCKUP's surfaces, so six stops shipped `accent_ink`
 * at 4.473–4.490 on the real `--card`. The generator READS `--bg`/`--card`/`--card2` out of `app.css` now,
 * and every ratio here is recomputed with production's own `contrastRatio` rather than read out of the
 * registry's `r_*` fields — a test that trusts the generator's own numbers cannot catch a generator that
 * measured the wrong surface.
 */

const REPO = repoRoot;
const appCss = readFileSync(at('src/app.css'), 'utf8');

/** Pull a `--name: #hex;` declaration out of `app.css`. Throws rather than defaulting, so a renamed token
 *  reds instead of leaving the suite measuring a value nothing declares. */
function token(name: string): string {
	const m = appCss.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
	if (!m) throw new Error(`token --${name} not found in src/app.css (renamed? then update this guard)`);
	return m[1]!;
}

/** Role floors: non-text and text. */
const NON_TEXT = 3;
const AA = 4.5;

const CHROMATIC = registry.variants.chromatic;
const STOPS = CHROMATIC.stops;

test('the 48-stop registry is measured against the surfaces app.css paints: the registry surfaces ARE the app.css tokens — not the mockup values', () => {
	// The generator reads these three tokens, so this proves the committed artifact was generated from the
	// values the app still declares: change `--card` without regenerating and this reds, naming both.
	expect(registry.surfaces).toEqual({
		bg: token('bg'),
		card: token('card'),
		card2: token('card2')
	});
	// and specifically NOT the mockup surfaces that produced the six failures
	expect(registry.surfaces.card).not.toBe('#131a2e');
});

test('the 48-stop registry is measured against the surfaces app.css paints: all 48 stops carry a distinct, canonical fill', () => {
	expect(STOPS.length).toBe(48);
	expect(new Set(STOPS.map((s) => s.fill)).size).toBe(48);
	expect(STOPS.filter((s) => !/^#[0-9a-f]{6}$/.test(s.fill))).toEqual([]);
});

const bg = token('bg');
const card = token('card');

test('every stop clears every role floor with margin > 0: fill is visible as an identity dot on --bg and on --card (3:1)', () => {
	const weak = STOPS.filter(
		(s) => contrastRatio(s.fill, bg) <= NON_TEXT || contrastRatio(s.fill, card) <= NON_TEXT
	).map((s) => s.name);
	expect(weak).toEqual([]);
});

test('every stop clears every role floor with margin > 0: on_fill clears AA against its own fill (4.5:1)', () => {
	// Surface-independent, so the remeasurement did not move it — pinned because it is one of the four roles
	// the registry claims to have measured and nothing else measures it.
	const weak = STOPS.filter((s) => contrastRatio(s.on_fill, s.fill) <= AA).map((s) => s.name);
	expect(weak).toEqual([]);
});

test('every stop clears every role floor with margin > 0: accent_ink clears AA as text on the real --card (4.5:1)', () => {
	const weak = STOPS.filter((s) => contrastRatio(s.accent_ink, card) <= AA).map((s) => s.name);
	expect(weak).toEqual([]);
});

test('every stop clears every role floor with margin > 0: the six stops named above now clear the real --card, and by more than a rounding error', () => {
	// Each of these measured 4.47–4.49 against `--card` while the registry recorded ~4.50 against the mockup
	// card, and `> AA` alone passes at 4.5000001 — exactly the margin that let a surface change go
	// unnoticed. The floor asserted here is the generator's own `AA + INK_MARGIN`.
	const NAMED = ['Cobalt', 'Denim', 'Rose', 'Orchid', 'Magenta', 'Fuchsia'] as const;
	const measured = NAMED.map((name) => {
		const stop = STOPS.find((s) => s.name === name);
		if (!stop) throw new Error(`stop ${name} is gone from the registry — the owner ratified 48`);
		return [name, contrastRatio(stop.accent_ink, card)] as const;
	});
	expect(measured.filter(([, r]) => r < 4.55).map(([n]) => n)).toEqual([]);
});

test('every stop clears every role floor with margin > 0: the published r_* figures agree with a fresh measurement', () => {
	// Catches a hand-edited hex whose recorded ratio was not updated with it: the cheap half of the
	// reproducibility claim, which runs without a Python interpreter.
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

test('the registry regenerates byte-identically from its committed inputs', () => {
	// "Generated, never hand-edited" is only true if a hand edit is detectable, and this is the only
	// assertion that detects one — so it pays ~10s of interpreter time to run the real generator.
	const out = join(mkdtempSync(join(tmpdir(), 'palette-')), 'regenerated.json');
	const run = spawnSync('python3', [join(REPO, 'src/lib/contract/scripts/_player_palette.py')], {
		env: { ...process.env, PLAYER_PALETTE_OUT: out },
		encoding: 'utf8'
	});
	// A missing interpreter fails loudly rather than skipping, because a silent skip is how this guard
	// stops guarding without anyone noticing. `python3` is already a build prerequisite.
	expect(run.error ?? null).toBeNull();
	expect(run.status).toBe(0);

	const committed = readFileSync(join(REPO, 'src/lib/contract/presentation/player-palette-48.json'), 'utf8');
	const regenerated = readFileSync(out, 'utf8');
	if (regenerated !== committed) {
		// Name the differing stop rather than dumping 42 KB of JSON.
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
