// guard: the TV surface is read from three metres, not held at 40cm. See docs/GUARDS.md#ten-foot-stage-scale.
//
// Caught: the room-state labels, the song title, the score sub-line and the join URL all rendering at
// 12–19px on a wall, and every edge element using a fixed 34–48px offset — inside the overscan region
// many television sets still apply (~5%, ≈54px vertically at 1080p), so the lower-third naming the
// singer and the join QR could be clipped off the screen entirely.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';
import { svelteFiles, TAP, TAP_FLOOR } from '@encore/test-support/scan';

const SRC = srcDir;
const TV_DIRS = [join(SRC, 'lib', 'tv'), join(SRC, 'routes', 'tv')];

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

function lineOf(src: string, i: number): number {
	return src.slice(0, i).split('\n').length;
}

const FILES = TV_DIRS.flatMap(svelteFiles);

/** 1.5rem = 24px, the ten-foot floor. Below it on the stage is the phone scale leaking back in. */
const MIN_TV_REM = 1.5;
const MIN_TV_PX = MIN_TV_REM * 16;

test('no TV type is sized below the ten-foot floor with a literal size', () => {
	// px alongside rem, because the two are interchangeable to whoever writes them and this once matched
	// `rem` only. `em` is out of scope: it is relative to its PARENT, so a factor below 1 is the normal way to
	// size a decorative child rather than a leak — the bouncing-ball dot is `0.5em` of the lyric it tracks.
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/font-size:\s*([0-9.]+)(rem|px)/g)) {
			const n = Number(m[1]);
			const unit = m[2]!;
			const px = unit === 'px' ? n : n * 16;
			if (px >= MIN_TV_PX) continue;
			offenders.push(
				`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${n}${unit} (${px}px) — use var(--tv-label|body|name|hero)`
			);
		}
	}
	expect(offenders).toEqual([]);
});

/**
 * The ONE declaration that owns the TV scale; every rem tier multiplies it. The arm above rejects only literals BELOW
 * the floor, so it would pass a hard-coded `44px` on the stage — a tier that stopped tracking the root.
 */
const TV_ROOT_FLOOR_RE =
	/^calc\(\s*max\(\s*2\.7vh\s*,\s*20px\s*\)\s*\*\s*clamp\(\s*0\.8\s*,\s*var\(--ui-scale\)\s*,\s*1\.6\s*\)\s*\)$/;

test('no TV font-size is a px literal or a per-token viewport term — the floor is the one exception', () => {
	const offenders: string[] = [];
	let rootFloorsSeen = 0;
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/font-size:\s*([^;]+);/g)) {
			const value = m[1]!.trim();
			if (TV_ROOT_FLOOR_RE.test(value)) {
				rootFloorsSeen++;
				continue;
			}
			if (/\b[0-9.]+px\b/.test(value)) {
				offenders.push(
					`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: font-size "${value}" carries a px literal — size it in rem off the .tv root floor (var(--tv-*))`
				);
			}
			// A per-token viewport term under a vh-scaled root multiplies the panel twice.
			if (/\b[0-9.]+(vh|vw|vmin|vmax)\b/.test(value)) {
				offenders.push(
					`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: font-size "${value}" carries a viewport term — only the .tv root may; tokens express rem ratios`
				);
			}
		}
	}
	// Without this, a rename makes the guard a scan that exempts nothing AND finds nothing — a green proving
	// the floor moved rather than that it holds.
	expect(rootFloorsSeen, 'the .tv root font-size floor declaration was not found — did it move or change shape?').toBe(
		1
	);
	expect(offenders).toEqual([]);
});

test('the TV type ladder in app.css is rem off the root — no tier carries a viewport term', () => {
	const css = stripComments(readFileSync(join(SRC, 'app.css'), 'utf8'));
	// --tv-safe-* and --tv-qr are the named geometry exemption and are intentionally NOT in this list.
	const TYPE_TOKENS = [
		'--tv-small',
		'--tv-eyebrow',
		'--tv-label',
		'--tv-body',
		'--tv-name',
		'--tv-joinurl',
		'--tv-hero',
		'--tv-lyric'
	] as const;
	const offenders: string[] = [];
	let smallestRem = Infinity;
	for (const tok of TYPE_TOKENS) {
		const decl = new RegExp(`${tok}:\\s*([^;]+);`).exec(css);
		if (!decl) {
			offenders.push(`${tok}: declaration not found`);
			continue;
		}
		const value = decl[1]!.trim();
		if (/\b[0-9.]+(vh|vw|vmin|vmax)\b/.test(value)) {
			offenders.push(`${tok}: "${value}" carries a viewport term — the root owns the scale, tokens own ratios`);
		}
		const rem = /^([0-9.]+)rem$/.exec(value);
		if (!rem) {
			offenders.push(`${tok}: "${value}" is not a bare rem multiple`);
			continue;
		}
		smallestRem = Math.min(smallestRem, Number(rem[1]));
	}
	expect(offenders).toEqual([]);
	// 0.93rem ≈ 27px at the 29.16px root, clearing the 24px floor.
	expect(smallestRem).toBeGreaterThanOrEqual(0.93);
});

test('nothing on the stage is docked to an edge with a fixed pixel offset', () => {
	// A bare pixel offset is how content ends up in the overscan region, and it always looks fine on the
	// developer's monitor, which does not overscan.
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/(?:^|[;{\s])(top|right|bottom|left):\s*(-?[0-9.]+)px/g)) {
			// 0 is full-bleed, which is intentional (scrims, the fixed .tv shell, mask layers)
			if (Number(m[2]) === 0) continue;
			offenders.push(`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${m[1]}: ${m[2]}px — use var(--tv-safe-x|y)`);
		}
	}
	expect(offenders).toEqual([]);
});

test('a full-bleed edge container insets its content with the safe-area tokens', () => {
	// The shape the offset check cannot see: a container may legitimately be `bottom: 0` so its backdrop
	// reaches the panel edge while the CONTENT inside it must not be. If a rule docks at 0 AND paints a
	// background AND has padding, that padding is what keeps its content out of the overscan region.
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const body = m[2]!;
			const docked = /(?:top|bottom|left|right):\s*0(?:px)?\s*;/.test(body);
			const paints = /background:/.test(body);
			const pads = /padding:\s*([^;]+);/.exec(body);
			if (!docked || !paints || !pads) continue;
			if (!pads[1]!.includes('--tv-safe')) {
				offenders.push(
					`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${m[1]!.trim()} pads with "${pads[1]!.trim()}" — use var(--tv-safe-x|y)`
				);
			}
		}
	}
	expect(offenders).toEqual([]);
});

test('the three transient TV states are visually distinct', () => {
	// next-up, a skip failure and "still processing" shared one block and one pink colour, so a viewer could
	// not tell a failure from a normal song change.
	const src = readFileSync(join(SRC, 'routes', 'tv', '+page.svelte'), 'utf8');
	for (const cls of ['state-next', 'state-error', 'state-waiting']) {
		expect(src).toContain(cls);
	}
	const errorBlock = /\.state-error[^{]*\{([^}]*)\}/.exec(src)?.[1] ?? '';
	// The `?? ''` fallback makes the negative assertion pass VACUOUSLY if the rule is renamed, hence the
	// non-empty floor beside it, as every other slice in this file carries.
	expect(errorBlock).not.toBe('');
	expect(errorBlock).not.toContain('--accent2');
});

/*
 * The reel must clear the bottom chrome. The join/QR corner and the lower-third are pinned to the bottom edge
 * and win the paint order over the reel, and nothing reserved space between them — so a large lyric setting,
 * or even the defaults on 16:9, drove the flex-centred reel down UNDER the cards and hid the words. Geometry
 * the DOM-less runner cannot SEE, so these pin the precondition.
 */
test('app.css defines the --tv-chrome-h band from responsive tokens, not a bare px edge', () => {
	const css = stripComments(readFileSync(join(SRC, 'app.css'), 'utf8'));
	const decl = /--tv-chrome-h:\s*([^;]+);/.exec(css);
	expect(decl).not.toBeNull();
	const value = decl![1]!;
	// Built from the same --tv-* tokens the cards use, so the band tracks them across resolutions.
	expect(value).toContain('--tv-safe-y');
	expect(value).toContain('var(--tv-');
});

test('the lyrics reel reserves the bottom chrome band instead of filling the whole screen', () => {
	const src = stripComments(readFileSync(join(SRC, 'lib', 'tv', 'LyricsOverlay.svelte'), 'utf8'));
	const block = /\.lyrics\s*\{([^}]*)\}/.exec(src)?.[1] ?? '';
	expect(block).not.toBe('');
	// `inset: 0` is exactly the state that let the cards cover the words.
	expect(/inset:\s*0/.test(block)).toBe(false);
	expect(/bottom:\s*var\(--tv-chrome-h\)/.test(block)).toBe(true);
});

const TV_ROUTE = readFileSync(join(SRC, 'routes', 'tv', '+page.svelte'), 'utf8');
const TV_LOBBY = readFileSync(join(SRC, 'lib', 'tv', 'TvLobby.svelte'), 'utf8');
const APP_CSS = readFileSync(join(SRC, 'app.css'), 'utf8');

test('the --tv-qr token exists and scales the QR in vmin, not a fixed px', () => {
	const css = stripComments(APP_CSS);
	const decl = /--tv-qr:\s*([^;]+);/.exec(css);
	expect(decl).not.toBeNull();
	// vmin (the shorter viewport side) is what makes the QR grow with the panel instead of capping.
	expect(decl![1]!).toContain('vmin');
});

test('the TV fullscreen button floors its clamp on var(--tap)', () => {
	// touch-targets.test.ts walks the PHONE surfaces only, so `.fs-btn` sat outside every touch guard while
	// its own comment claimed the 44px clamp floor was `--tap` — it was a bare `44px`, a comment asserting a
	// binding the code did not have. `clamp(var(--tap), 5.2vmin, 88px)` keeps the scaling AND the floor.
	const css = stripComments(TV_ROUTE);
	const rule = /\.fs-btn\s*\{([^}]*)\}/s.exec(css);
	expect(rule).not.toBeNull();
	const body = rule![1]!;
	// both axes, so a half-converted rule (one axis tokened, one literal) is still a failure
	const axes = [...body.matchAll(/(width|height):\s*clamp\(([^,]+),/g)];
	expect(axes.length).toBe(2);
	for (const [, axis, floor] of axes) {
		expect(floor!.trim(), `.fs-btn ${axis} clamp floor`).toBe('var(--tap)');
	}
	expect(TAP).toBeGreaterThanOrEqual(TAP_FLOOR);
});

test('every HERO join badge sizes from a vmin TV-QR token, never a bare pixel number', () => {
	// `<JoinBadge size={320}>` rendered a fixed-pixel QR inside a canvas that keeps growing on a 4K wall, so
	// the code stayed phone-sized and became the hardest thing on screen to scan — and nothing constrained
	// it: `size={320}` -> `size={9999}` survived the ENTIRE suite. The attract panel's QR is the smaller
	// in-panel `--tv-attract-qr` and the lobby hero keeps `--tv-qr`; both are vmin clamps that GROW with the
	// panel, so either is accepted. The corner badge keeps its numeric default (fixed-geometry card).
	const TV_QR_TOKENS = ['var(--tv-qr)', 'var(--tv-attract-qr)'];
	const offenders: string[] = [];
	let heroBadgesSeen = 0;
	for (const [name, src] of [
		['routes/tv/+page.svelte', TV_ROUTE],
		['lib/tv/TvLobby.svelte', TV_LOBBY]
	] as const) {
		const clean = stripComments(src);
		let seenInFile = 0;
		for (const m of clean.matchAll(/<JoinBadge\b[^>]*?placement="hero"[^>]*?>/gs)) {
			seenInFile++;
			heroBadgesSeen++;
			const tag = m[0];
			if (/size=\{\s*\d+(?:\.\d+)?\s*\}/.test(tag)) {
				offenders.push(`${name}: hero JoinBadge uses a fixed numeric size — use a vmin --tv-*qr token`);
			}
			if (!TV_QR_TOKENS.some((tok) => tag.includes(`size="${tok}"`))) {
				offenders.push(`${name}: hero JoinBadge does not size from var(--tv-qr) or var(--tv-attract-qr)`);
			}
		}
		// A zero-match scan iterates zero times and passes with `offenders` empty, so a hero badge hidden in a
		// spread would ship the size={9999} defect green.
		expect(
			seenInFile,
			`${name}: no <JoinBadge placement="hero"> matched — the size guard would pass vacuously; the hero badge moved or the attribute form changed`
		).toBeGreaterThan(0);
	}
	expect(offenders).toEqual([]);
	expect(heroBadgesSeen).toBeGreaterThanOrEqual(2); // @nvf-floor heroBadgesSeen
});

test('both TV-QR hero tokens are defined in vmin, not a fixed px', () => {
	const css = stripComments(APP_CSS);
	for (const tok of ['--tv-qr', '--tv-attract-qr']) {
		const decl = new RegExp(`${tok}:\\s*([^;]+);`).exec(css);
		expect(decl, `${tok} declaration`).not.toBeNull();
		expect(decl![1]!, `${tok} must scale in vmin`).toContain('vmin');
	}
});

/*
 * The chrome band is MEASURED, not predicted: a static app.css sum assumed a fixed row set and under-counted
 * the card's real height, so the sung lyric line could still be covered and any added row re-broke it.
 */
test('the TV route measures the lower-third with a ResizeObserver', () => {
	const clean = stripComments(TV_ROUTE);
	expect(clean).toContain('ResizeObserver');
	expect(/bind:this=\{lowerThirdEl\}/.test(clean)).toBe(true);
	expect(/lower-third/.test(clean)).toBe(true);
});

test('the measured card height overrides --tv-chrome-h on the stage', () => {
	const clean = stripComments(TV_ROUTE);
	// `tvStyle` COMPOSES `chromeBandStyle` (the measured --tv-chrome-h) with the measured --tv-upnext-h, so
	// both the composition and `.tv` reading the composed value are asserted.
	expect(/--tv-chrome-h:\s*calc\(/.test(clean)).toBe(true);
	expect(/const\s+tvStyle\s*=\s*\$derived\(/.test(clean)).toBe(true);
	expect(/tvStyle[\s\S]*chromeBandStyle/.test(clean)).toBe(true);
	expect(/style=\{tvStyle\}/.test(clean)).toBe(true);
});

test('the TV process wording comes from process-phrasing, not a hand-written string', () => {
	// The waiting state and the lobby hand-wrote "Making the karaoke" / "Separating" / "Stripping the vocals".
	// Both call processStageLabel now, the one guest-facing vocabulary the phone uses, so phone and TV
	// describe the same pipeline state identically.
	for (const [, src] of [
		['routes/tv/+page.svelte', TV_ROUTE],
		['lib/tv/TvLobby.svelte', TV_LOBBY]
	] as const) {
		expect(src).toContain("from '$lib/phrasing/process-phrasing'");
		expect(src.includes('processStageLabel')).toBe(true);
	}
	const clean = stripComments(TV_ROUTE) + stripComments(TV_LOBBY);
	expect(/Stripping the vocals/i.test(clean)).toBe(false);
});

/*
 * A slot may report VISIBLE readiness only while it is visible. Both slots wired onready to
 * `onVisibleReady()`, so the hidden PRE-WARMING slot — which buffers a whole song ahead — could flip the room
 * to `playing` over the visible slot's black frame. The pre-warm signal has its own callback.
 */
test('TvPlayer gates its visible-ready report on visibility and separates the pre-warm signal', () => {
	const player = stripComments(readFileSync(join(SRC, 'lib', 'tv', 'TvPlayer.svelte'), 'utf8'));
	const onreadyEffect = /if\s*\(\s*visible\s*&&[\s\S]*?onready\?\.\(\)/.test(player);
	expect(onreadyEffect).toBe(true);
	expect(player).toContain('onprewarmed');
});

test('the route drives onVisibleReady from onready and onHiddenReady from onprewarmed — never mixed', () => {
	const clean = stripComments(TV_ROUTE);
	for (const m of clean.matchAll(/onready=\{[^}]*\}/g)) {
		expect(m[0]).not.toContain('onHiddenReady');
	}
	const prewarms = [...clean.matchAll(/onprewarmed=\{[^}]*\}/g)];
	expect(prewarms.length).toBe(2);
	for (const m of prewarms) expect(m[0]).toContain('onHiddenReady');
});

test('the pitch-shift graph teardown runs per song change — and not on media identity churn', () => {
	// A graph binds a PERMANENT MediaElementAudioSourceNode to the element that plays one media, so a graph left in place
	// after a media change posts setShift() to a dead node — silent on the transposed song. But `media` is a prop whose
	// object identity churns on every queue mutation in the room, so keying the teardown on the media SIGNAL tore down a
	// live graph mid-song and cleared the readiness latches with it: the effect must read the id and gate on its VALUE.
	// Line comments stripped too, so a `// media?.id` in prose cannot satisfy this.
	const raw = readFileSync(join(SRC, 'lib', 'tv', 'TvPlayer.svelte'), 'utf8');
	const player = stripComments(raw).replace(/\/\/[^\n]*/g, '');
	// Picked by the id read, NOT by a detach() call — the master detach was removed from this effect.
	const bodies = [...player.matchAll(/\$effect\(\(\)\s*=>\s*\{([\s\S]*?)\n\t\}\);/g)].map((m) => m[1]);
	const teardown = bodies.find((b) => /media\?\.id/.test(b) && /resetForId/.test(b)) ?? '';
	expect(teardown).not.toBe('');
	// It must READ the id as an executable statement, so the effect re-runs per song…
	expect(/media\?\.id/.test(teardown)).toBe(true);
	// …and EARLY-RETURN on an unchanged id, so a new object for the same song is a no-op.
	expect(/if\s*\(\s*id\s*===\s*resetForId\s*\)\s*return;/.test(teardown)).toBe(true);
	// NEITHER graph is detached on a song change: both <audio> elements survive a song-to-song transition, and
	// detach() cannot restore the native path (the element is a permanent capture), so detaching a
	// still-mounted element leaves it feeding a disconnected node — silence. The reset sets ratio 1 in place;
	// detach() belongs only where an element genuinely unmounts.
	expect(/masterGraph\?\.setShift\(\s*0\s*\)/.test(teardown)).toBe(true);
	expect(/masterGraph\?\.detach\(/.test(teardown)).toBe(false);
	// ONE graph to reset: a reappearing `guideGraph` means the two-decoder path came back, and the guide
	// PAIR's gain lives on this same graph now.
	expect(/guideGraph/.test(teardown)).toBe(false);
	expect(/masterGraph\?\.setGuideGain\(\s*effectiveGuide\s*\)/.test(teardown)).toBe(true);
	expect(/guideGraph\?\.detach\(/.test(teardown)).toBe(false);
});

/*
 * The reel's colour states stay ONE VARIABLE EACH, so provenance and highlight cannot cancel out. Both
 * directions shipped from one commit: the amber provenance tint was written as
 * `.lyrics.unverified .row.current .word`, chosen to out-specify the word ladder — and it did, so a sung and
 * an unsung word on an ASR line measured the same rgb() and word-by-word highlighting had stopped existing;
 * while the same tint LOST to `.hl-line` on source order, so a room on that treatment got no tint at all.
 * Neither is visible to a unit test and both look fine in a still frame of a verified song.
 */
const LYRICS_OVERLAY = stripComments(readFileSync(join(SRC, 'lib', 'tv', 'LyricsOverlay.svelte'), 'utf8'));
const REEL_STATE_VARS = ['--reel-current', '--reel-ahead', '--reel-done', '--reel-line', '--reel-now'] as const;

test('every reel colour state is declared once as a variable and consumed through it', () => {
	const root = /\.lyrics\s*\{([^}]*)\}/.exec(LYRICS_OVERLAY)?.[1] ?? '';
	expect(root).not.toBe('');
	// The root defines all of them, so an override only has to name the ones provenance changes.
	for (const v of REEL_STATE_VARS) expect(root).toContain(`${v}:`);
	for (const [selector, v] of [
		['.row.current', '--reel-current'],
		['.lyrics.hl-line .row.current', '--reel-line'],
		['.word', '--reel-ahead'],
		['.word.done', '--reel-done'],
		['.word.active', '--reel-now']
	] as const) {
		const pattern = selector.replace(/\./g, '\\.').replace(/ /g, '\\s+');
		const block = new RegExp(`${pattern}\\s*\\{([^}]*)\\}`).exec(LYRICS_OVERLAY)?.[1] ?? '';
		expect(block).toContain(`color: var(${v})`);
	}
});

test('the unverified tint overrides variables only — it never re-selects a word state', () => {
	const block = /\.lyrics\.unverified\s*\{([^}]*)\}/.exec(LYRICS_OVERLAY)?.[1] ?? '';
	expect(block).not.toBe('');
	// Including the whole-line state, or the `line` treatment keeps painting an ASR lyric in the confident
	// accent and shows no provenance.
	for (const v of ['--reel-current', '--reel-ahead', '--reel-done', '--reel-line'] as const) {
		expect(block).toContain(`${v}:`);
	}
	// …but NOT the now-cue: the marker above the word is --accent2 regardless of provenance, so overriding it
	// is what made the word and its dot disagree.
	expect(block).not.toContain('--reel-now:');
	// No descendant selector may carry the tint — that is the shape that out-specified the word ladder.
	const descendants = [...LYRICS_OVERLAY.matchAll(/\.lyrics\.unverified\s+[^{]+\{/g)].map((m) => m[0].trim());
	expect(descendants).toEqual([]);
});

/*
 * The typed join address must not be buried under the roster strip on a short panel. `.lobby` centred its `.stack` —
 * whose last child IS that address — across its full `inset: 0` box while `.strip` was absolutely docked to `bottom: 0`
 * and grew UPWARD as names wrapped, so on panels ≤768px the two intersected and, with no z-index to reorder the paint,
 * the strip's gradient and name chips painted ON TOP of the only way into the room when a camera won't read the QR. At
 * the 8-member cap it was fully covered under a 0.90 wash; at 1920/3840 there was no overlap at any roster size, so a
 * reserve keyed to a fixed pixel band would have been wrong.
 *
 * The fix: `.lobby` is a flow COLUMN, the stack lives in a `.stack-region` taking `flex: 1`, and `.strip` is
 * IN FLOW. Property-level proof across roster × viewport is the runnable tests/e2e/lobby-overlap.mjs
 * (`bun run e2e:lobby`); these arms pin the preconditions and the REVERSIONS.
 */
test('the lobby roster strip wraps the full roster in flow — not absolutely docked, not clipped', () => {
	// The lobby shows EVERY guest with no truncation — the roster must not degrade as the party grows — so the
	// strip WRAPS and the step-down rule keeps a large party inside the title-safe band instead of folding.
	// What is preserved is that the strip is IN FLOW, which is what keeps it off the typed join address.
	const lobby = stripComments(TV_LOBBY);
	const stripBlock = /\.strip\s*\{([^}]*)\}/.exec(lobby)?.[1] ?? '';
	expect(stripBlock).not.toBe('');
	expect(/position:\s*absolute/.test(stripBlock)).toBe(false);
	expect(/bottom:\s*0/.test(stripBlock)).toBe(false);
	expect(/flex-wrap:\s*wrap/.test(stripBlock)).toBe(true);
	// And it never hard-clips: a raw overflow:hidden made the surplus guests the first casualty.
	expect(/overflow:\s*hidden/.test(stripBlock)).toBe(false);
});

test('the lobby shows the whole roster with a chip step-down rule, never a "+N more" fold', () => {
	const src = TV_LOBBY;
	const lobby = stripComments(src);
	// The step-down is a RULE with a named threshold, applied by a `dense` class the script derives.
	expect(/const\s+CHIP_STEPDOWN\s*=\s*\d+/.test(lobby)).toBe(true);
	// It keys on COUNT **and** TOTAL WIDTH. A count alone clipped the roster: `displayName` is user-typed and
	// admits 32 characters, so nine long names already overflow the two rows `max-height: 26vh` allows while a
	// count rule sits quiet until 13. Dropping either half restores the bug — count for an ordinary party,
	// characters for a party of long names.
	expect(/const\s+CHAR_BUDGET\s*=\s*\d+/.test(lobby)).toBe(true);
	expect(/roster\.reduce\(\s*\(\s*n\s*,\s*m\s*\)\s*=>\s*n\s*\+\s*m\.displayName\.length/.test(lobby)).toBe(true);
	expect(
		/const\s+dense\s*=\s*\$derived\(\s*roster\.length\s*>\s*CHIP_STEPDOWN\s*\|\|\s*rosterChars\s*>\s*CHAR_BUDGET\s*\)/.test(
			lobby
		)
	).toBe(true);
	// …and it stays a RULE derived from the DATA: a geometry read would not work under the mount rung.
	const denseDecl = lobby.slice(lobby.indexOf('const dense'), lobby.indexOf('const dense') + 200);
	expect(/getBoundingClientRect|offsetHeight|clientHeight|scrollHeight/.test(denseDecl)).toBe(false);
	expect(/\{#each\s+roster\s+as/.test(src)).toBe(true);
	expect(/MAX_CHIPS/.test(lobby)).toBe(false);
	expect(/\+\{hiddenCount\}\s*more/.test(src)).toBe(false);
	// The dense tier must actually step the chip type down (a rule, not a comment).
	const denseBlock = /\.strip\.dense\s+\.name\s*\{([^}]*)\}/.exec(lobby)?.[1] ?? '';
	expect(denseBlock).not.toBe('');
	expect(/font-size:/.test(denseBlock)).toBe(true);
	// A single long name must not blow a row out: the chip name is width-bounded and ellipsised.
	const nameBlock = /\.person\s+\.name\s*\{([^}]*)\}/.exec(lobby)?.[1] ?? '';
	expect(/text-overflow:\s*ellipsis/.test(nameBlock)).toBe(true);
	const personBlock = /\.person\s*\{([^}]*)\}/.exec(lobby)?.[1] ?? '';
	expect(/max-width:\s*[0-9.]+ch/.test(personBlock)).toBe(true);
});

test('the lobby centres its stack in the space ABOVE the strip, not across the whole box', () => {
	const lobby = stripComments(TV_LOBBY);
	// A column, so the strip's height is subtracted from the region the stack centres in.
	const lobbyBlock = /\.lobby\s*\{([^}]*)\}/.exec(lobby)?.[1] ?? '';
	expect(/flex-direction:\s*column/.test(lobbyBlock)).toBe(true);
	// Without `flex: 1` the region collapses to content height and the strip no longer pushes the stack up.
	const regionBlock = /\.stack-region\s*\{([^}]*)\}/.exec(lobby)?.[1] ?? '';
	expect(regionBlock).not.toBe('');
	expect(/flex:\s*1/.test(regionBlock)).toBe(true);
	expect(/justify-content:\s*center/.test(regionBlock)).toBe(true);
	// And the markup must actually WRAP the stack in that region, or the CSS rule guards nothing.
	expect(/<div class="stack-region">\s*<div class="stack">/.test(TV_LOBBY)).toBe(true);
});
