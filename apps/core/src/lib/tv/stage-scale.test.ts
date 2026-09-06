// guard: the TV surface is read from three metres, not held at 40cm.
//
// THE BUG THIS EXISTS FOR. The TV route and its components were using the phone's type tokens
// verbatim, so the room-state labels, the song title, the score's explanatory sub-line and the join
// URL all rendered at 12–19px — on a wall. Nothing failed; it just could not be read from a sofa.
// Every edge element also used a fixed 34–48px offset, which sits INSIDE the overscan region many
// television sets still apply (~5%, ≈54px vertically at 1080p), so the lower-third naming the singer
// and the join QR could be clipped off the screen entirely.
//
// Both classes of defect are decidable from the stylesheet, so this is a source scan.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', '..');
const TV_DIRS = [join(SRC, 'lib', 'tv'), join(SRC, 'routes', 'tv')];

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...svelteFiles(p));
		else if (ent.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

function lineOf(src: string, i: number): number {
	return src.slice(0, i).split('\n').length;
}

const FILES = TV_DIRS.flatMap(svelteFiles);

/**
 * 1.5rem = 24px, just under the ten-foot floor. A literal rem value below that on the stage is the
 * phone scale leaking back in; the --tv-* tokens exist so it does not have to.
 */
const MIN_TV_REM = 1.5;
const MIN_TV_PX = MIN_TV_REM * 16;

test('no TV type is sized below the ten-foot floor with a literal size', () => {
	// px is checked alongside rem because the two are interchangeable to whoever writes them but were
	// not to this guard: it only ever matched `rem`, so `font-size: 14px` on the stage -- the exact
	// defect the ten-foot floor exists to stop -- would have sailed through.
	//
	// `em` is deliberately NOT checked. It is relative to its PARENT, so a factor below 1 is the normal
	// way to size a decorative child rather than a leak of the phone scale: the bouncing-ball dot is
	// `font-size: 0.5em` of the lyric it tracks, which is correct and must stay. Flagging it would have
	// made this guard punish the right answer, so it is out of scope rather than annotated around.
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
 * Anything docked to an edge must use the safe-area tokens. A bare pixel offset is how content ends up
 * in the overscan region — and it always looks fine on the developer's monitor, which does not overscan.
 */
test('nothing on the stage is docked to an edge with a fixed pixel offset', () => {
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/(?:^|[;{\s])(top|right|bottom|left):\s*(-?[0-9.]+)px/g)) {
			// 0 is full-bleed, which is intentional (scrims, the fixed .tv shell, mask layers)
			if (Number(m[2]) === 0) continue;
			offenders.push(
				`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${m[1]}: ${m[2]}px — use var(--tv-safe-x|y)`
			);
		}
	}
	expect(offenders).toEqual([]);
});

/**
 * The three transient states — next-up, a skip failure, and "still cooking" — shared one CSS block and
 * one pink colour, so a viewer could not tell a failure from a normal song change. Each must keep its
 * own treatment.
 */
/**
 * The shape the offset check above cannot see.
 *
 * A container may legitimately be full-bleed (`bottom: 0`) so its backdrop reaches the panel edge,
 * while the CONTENT inside it still must not be — TvLobby's roster strip is exactly that, and it
 * survived the first pass of the stage scale because the guard only inspected edge offsets. If a rule
 * docks to an edge at 0 AND paints a background AND has padding, that padding is what keeps its content
 * out of the overscan region, so it has to come from the safe-area tokens.
 */
test('a full-bleed edge container insets its content with the safe-area tokens', () => {
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
	const src = readFileSync(join(SRC, 'routes', 'tv', '+page.svelte'), 'utf8');
	for (const cls of ['state-next', 'state-error', 'state-waiting']) {
		expect(src).toContain(cls);
	}
	// the error state must not be drawn in the affirmative accent
	const errorBlock = /\.state-error[^{]*\{([^}]*)\}/.exec(src)?.[1] ?? '';
	expect(errorBlock).not.toContain('--accent2');
});

/*
 * The overlap this bug lived in. The join/QR corner and the now-playing lower-third are pinned to the
 * bottom edge and win the paint order (z-index 6/7) over the lyrics reel; nothing reserved space
 * between them, so a large lyric setting — or even the defaults on 16:9 — drove the flex-centred reel
 * down UNDER the cards and hid the words. The fix reserves a bottom chrome band the reel cannot enter.
 * No test asserted the reel stays clear of the cards; these two lock the reservation in so a future
 * edit cannot silently reintroduce it. Pure geometry the tests cannot SEE, so they guard the
 * structural precondition: the band token exists and the reel yields to it.
 */
test('app.css defines the --tv-chrome-h band from responsive tokens, not a bare px edge', () => {
	const css = stripComments(readFileSync(join(SRC, 'app.css'), 'utf8'));
	const decl = /--tv-chrome-h:\s*([^;]+);/.exec(css);
	expect(decl).not.toBeNull();
	const value = decl![1]!;
	// Built from the same --tv-* tokens the cards use, so the band tracks them across resolutions
	// instead of freezing a magic pixel height.
	expect(value).toContain('--tv-safe-y');
	expect(value).toContain('var(--tv-');
});

test('the lyrics reel reserves the bottom chrome band instead of filling the whole screen', () => {
	const src = stripComments(readFileSync(join(SRC, 'lib', 'tv', 'LyricsOverlay.svelte'), 'utf8'));
	const block = /\.lyrics\s*\{([^}]*)\}/.exec(src)?.[1] ?? '';
	expect(block).not.toBe('');
	// It must NOT be `inset: 0` again — that is exactly the state that let the cards cover the words.
	expect(/inset:\s*0/.test(block)).toBe(false);
	// It must yield its bottom to the reserved band, so its centreline rises clear of the cards.
	expect(/bottom:\s*var\(--tv-chrome-h\)/.test(block)).toBe(true);
});

/*
 * FIX 3b — the hero join QR must scale with the panel, not freeze at a pixel size.
 *
 * The bug: `<JoinBadge ... size={320}>` (attract) and `size={238}` (lobby) rendered a fixed-pixel QR
 * inside a canvas that keeps growing on a 4K wall, so the code stayed phone-sized and became the
 * hardest thing on the screen to scan. A mutation test proved the point — flipping `size={320}` to
 * `size={9999}` survived the ENTIRE suite, because nothing constrained the hero QR's size at all.
 *
 * These guards close that hole two ways: the token must be defined in vmin (grows with the panel), and
 * no HERO JoinBadge may pass a bare numeric `size` (which is exactly what the mutation did — and what
 * dead-ends at a pixel cap). The corner badge keeps its numeric default (fixed-geometry card), so this
 * is scoped to the hero callers.
 */
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

test('every HERO join badge sizes from the --tv-qr token, never a bare pixel number', () => {
	// This is the assertion the size={320}->size={9999} mutation must not survive: a hero badge with a
	// numeric size is the fixed-pixel bug, whatever the number is.
	const offenders: string[] = [];
	for (const [name, src] of [
		['routes/tv/+page.svelte', TV_ROUTE],
		['lib/tv/TvLobby.svelte', TV_LOBBY]
	] as const) {
		const clean = stripComments(src);
		for (const m of clean.matchAll(/<JoinBadge\b[^>]*?placement="hero"[^>]*?>/gs)) {
			const tag = m[0];
			// A hero badge must NOT carry a numeric size ({320}, {238}, {9999}, …).
			if (/size=\{\s*\d+(?:\.\d+)?\s*\}/.test(tag)) {
				offenders.push(`${name}: hero JoinBadge uses a fixed numeric size — use size="var(--tv-qr)"`);
			}
			// …and it MUST carry the token.
			if (!/size="var\(--tv-qr\)"/.test(tag)) {
				offenders.push(`${name}: hero JoinBadge does not size from var(--tv-qr)`);
			}
		}
	}
	expect(offenders).toEqual([]);
});

/*
 * FIX 3a — the reserved chrome band must be MEASURED, not predicted.
 *
 * The static app.css sum under-counted the card's real height (it hard-assumed a fixed row set), so
 * the sung lyric line could still be covered, and any row added to the card re-broke it. The route now
 * observes the rendered lower-third and overrides --tv-chrome-h with its true height. Pure geometry the
 * tests cannot SEE, so these guard the structural precondition: a ResizeObserver is wired to the card
 * and the measured value overrides the token.
 */
test('the TV route measures the lower-third with a ResizeObserver', () => {
	const clean = stripComments(TV_ROUTE);
	expect(clean).toContain('ResizeObserver');
	// the observer must actually be bound to the lower-third element, not merely imported
	expect(/bind:this=\{lowerThirdEl\}/.test(clean)).toBe(true);
	expect(/lower-third/.test(clean)).toBe(true);
});

test('the measured card height overrides --tv-chrome-h on the stage', () => {
	const clean = stripComments(TV_ROUTE);
	// the override must be written from the measured value and applied to the .tv container
	expect(/--tv-chrome-h:\s*calc\(/.test(clean)).toBe(true);
	expect(/style=\{chromeBandStyle\}/.test(clean)).toBe(true);
});

/*
 * FIX 4 — the TV speaks the shared cook vocabulary, not its own.
 *
 * The waiting state and the lobby hand-wrote "Making the karaoke" / "Separating" / "Stripping the
 * vocals". Both now call cookStageLabel (cook-phrasing.ts), the ONE guest-facing cook vocabulary the
 * phone already uses, so phone and TV describe the same pipeline state identically.
 */
test('the TV cook wording comes from cook-phrasing, not a hand-written string', () => {
	for (const [name, src] of [
		['routes/tv/+page.svelte', TV_ROUTE],
		['lib/tv/TvLobby.svelte', TV_LOBBY]
	] as const) {
		expect(src).toContain("from '$lib/cook-phrasing'");
		expect(src.includes('cookStageLabel')).toBe(true);
	}
	// and the retired musician's-word phrasings must be gone from the TV surfaces
	const clean = stripComments(TV_ROUTE) + stripComments(TV_LOBBY);
	expect(/Stripping the vocals/i.test(clean)).toBe(false);
});

/*
 * FIX 1 — a slot may report VISIBLE readiness only while it is visible.
 *
 * Both player slots wired onready to ctl.onVisibleReady(), so the hidden PRE-WARMING slot (which
 * buffers a whole song ahead) could flip the room to `playing` over the visible slot's black frame.
 * onready now fires only while visible; the hidden pre-warm signal has its own callback, onprewarmed.
 * These guards lock in the split so a future edit cannot re-conflate them.
 */
test('TvPlayer gates its visible-ready report on visibility and separates the pre-warm signal', () => {
	const player = stripComments(readFileSync(join(SRC, 'lib', 'tv', 'TvPlayer.svelte'), 'utf8'));
	// the effect that calls onready() must be guarded by `visible` (the condition starts with it)
	const onreadyEffect = /if\s*\(\s*visible\s*&&[\s\S]*?onready\?\.\(\)/.test(player);
	expect(onreadyEffect).toBe(true);
	// and a distinct pre-warm callback must exist for the hidden slot's buffered signal
	expect(player).toContain('onprewarmed');
});

test('the route drives onVisibleReady from onready and onHiddenReady from onprewarmed — never mixed', () => {
	const clean = stripComments(TV_ROUTE);
	// onHiddenReady must be reached from onprewarmed, not from onready
	for (const m of clean.matchAll(/onready=\{[^}]*\}/g)) {
		expect(m[0]).not.toContain('onHiddenReady');
	}
	// and each slot must wire the pre-warm callback to onHiddenReady
	const prewarms = [...clean.matchAll(/onprewarmed=\{[^}]*\}/g)];
	expect(prewarms.length).toBe(2);
	for (const m of prewarms) expect(m[0]).toContain('onHiddenReady');
});

/*
 * FIX 2 — the pitch-shift graphs are torn down per SONG, and specifically NOT on mere identity churn.
 *
 * A graph binds a PERMANENT MediaElementAudioSourceNode to the element that plays one media. If media
 * changes and a graph is left in place it still points at the old element, and the shift-wiring effect
 * then posts setShift() to a dead node — silent on the transposed song. So the teardown must run on a
 * song change.
 *
 * But it must ALSO not run on anything less than one. `media` is a prop whose object identity churns on
 * every queue mutation in the room — the TV route rebuilds its catalog and hands the slot a new object
 * with identical fields for the song already playing. Keying the teardown on the `media` SIGNAL (which
 * `void media?.id;` did, and which an effect cleanup made worse by firing before every re-run) tore down
 * a live graph mid-song and cleared the readiness latches with it. The guard therefore requires the
 * effect to read the id and to gate on its VALUE.
 */
test('the pitch-shift graph teardown runs per song change — and not on media identity churn', () => {
	// Strip BOTH block and line comments — a `// media?.id` in prose must not satisfy this guard, which
	// is exactly the vacuous pass the codebase's comment-lies defect produces.
	const raw = readFileSync(join(SRC, 'lib', 'tv', 'TvPlayer.svelte'), 'utf8');
	const player = stripComments(raw).replace(/\/\/[^\n]*/g, '');
	// The teardown effect is the one that detaches both graphs AND reads the media id; the destroy-only
	// effect also detaches, so pick by the id read rather than by position.
	const bodies = [...player.matchAll(/\$effect\(\(\)\s*=>\s*\{([\s\S]*?)\n\t\}\);/g)].map((m) => m[1]);
	const teardown = bodies.find((b) => b.includes('masterGraph?.detach()') && /media\?\.id/.test(b)) ?? '';
	expect(teardown).not.toBe('');
	// It must READ the id as an executable statement, so the effect re-runs per song.
	expect(/media\?\.id/.test(teardown)).toBe(true);
	// And it must EARLY-RETURN when the id is unchanged, so a new object for the same song is a no-op.
	expect(/if\s*\(\s*id\s*===\s*resetForId\s*\)\s*return;/.test(teardown)).toBe(true);
});

/*
 * FIX — the reel's four colour states stay one variable each, so provenance and highlight cannot
 * silently cancel each other out.
 *
 * THE BUG THIS EXISTS FOR (both directions, from one commit):
 *
 *   1. The amber provenance tint was written as `.lyrics.unverified .row.current .word`, `.word.done`
 *      and `.word.active` — selectors chosen specifically to out-specify the word ladder. They did:
 *      measured in a real browser, a sung word and an unsung word on an auto-transcribed line were
 *      BOTH rgb(255,230,184). Word-by-word highlighting had stopped existing on every ASR song, and
 *      `.word.active` was recoloured white while the marker directly above it stayed pink, so the two
 *      cues for "sing this now" disagreed.
 *   2. The same tint LOST to `.hl-line`/`.hl-off .row.current` purely on source order (equal
 *      specificity), so a room on either of those treatments got no provenance tint at all.
 *
 * Neither is visible to a unit test and both look fine in a still frame of a verified song, which is
 * why the guard is structural: one variable per state, set on the root, read by the rules. A future
 * edit that reaches for a deeper selector instead of an override trips this.
 */
const LYRICS_OVERLAY = stripComments(
	readFileSync(join(SRC, 'lib', 'tv', 'LyricsOverlay.svelte'), 'utf8')
);
const REEL_STATE_VARS = [
	'--reel-current',
	'--reel-ahead',
	'--reel-done',
	'--reel-line',
	'--reel-now'
] as const;

test('every reel colour state is declared once as a variable and consumed through it', () => {
	const root = /\.lyrics\s*\{([^}]*)\}/.exec(LYRICS_OVERLAY)?.[1] ?? '';
	expect(root).not.toBe('');
	// The root defines all of them, so an override only has to name the ones provenance changes.
	for (const v of REEL_STATE_VARS) expect(root).toContain(`${v}:`);
	// And the rules that paint text read them rather than repeating a literal.
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
	// It recolours every state that describes the WORDS — including the whole-line one, or the `line`
	// treatment would keep painting an ASR lyric in the confident accent and show no provenance.
	for (const v of ['--reel-current', '--reel-ahead', '--reel-done', '--reel-line'] as const) {
		expect(block).toContain(`${v}:`);
	}
	// ...but NOT the now-cue: pink means "sing this word" on every song, and the marker above the word
	// is --accent2 regardless of provenance. Overriding it is what made the word and its dot disagree.
	expect(block).not.toContain('--reel-now:');
	// No descendant selector may carry the tint. That is the shape that out-specified the word ladder
	// and flattened sung/unsung to one colour.
	const descendants = [...LYRICS_OVERLAY.matchAll(/\.lyrics\.unverified\s+[^{]+\{/g)].map((m) =>
		m[0].trim()
	);
	expect(descendants).toEqual([]);
});

/*
 * #98 — the typed join address must not be buried under the roster strip on a short panel.
 *
 * THE BUG THIS EXISTS FOR. `.lobby` was `display: flex; align-items/justify-content: center` across
 * its FULL `inset: 0` box, centring the `.stack` — whose last child is the typed join address — over
 * the whole screen. `.strip` was `position: absolute; bottom: 0`, out of flow, growing UPWARD as names
 * wrapped. On panels ≤768px (1280×720, 1366×768) the centred stack's bottom and the bottom-anchored
 * strip intersected, and because the strip comes after the stack in DOM order with no z-index on either
 * to reorder the paint, the strip's gradient backdrop and its name chips painted ON TOP of the address
 * — the ONLY way into the room when a camera won't read the QR. Measured: at the 8-member cap the
 * address was fully covered under a 0.90 wash. At 1920/3840 there was no overlap at any roster size, so
 * a reserve keyed to a fixed pixel band would have been wrong at the tall end.
 *
 * THE FIX, and what these lock in. `.lobby` is a flow COLUMN; the stack lives in a `.stack-region` that
 * takes `flex: 1` and centres within it; `.strip` is IN FLOW (not absolutely docked). BUT the strip in
 * flow is only half of it: the stack is a FIXED height (~614px at 720p, vh-based) and the region shrinks
 * as the strip grows, so 8 long names wrapping to three rows (~208px, 29% of a 720p panel) drop the
 * region below the stack's height and `align-items: center` spills the stack — bottom child = the
 * address — back down into the strip. So the strip is ALSO CAPPED (`max-height` in vh) and its surplus
 * rows fold behind the same fade the lyrics reel uses, which keeps the region tall enough for the stack
 * at every roster size up to the max=8 cap plus its overflow chip. Pure geometry the DOM-less runner
 * cannot SEE, so these pin the structural preconditions and the REVERSIONS: re-adding
 * `position: absolute; bottom: 0` to `.strip`, or dropping its `max-height`, each restores an overlap
 * with the whole suite green. Property-level proof (zero `.url`/`.strip` intersection, with the address the element painted at
 * its own centre, across roster {3, 8, 8+overflow} \u00d7 viewport {1280\u00d7720, 1366\u00d7768, 1920\u00d71080})
 * is the runnable e2e at e2e/lobby-overlap.mjs (`bun run e2e:lobby`) \u2014 it FAILS 6/9 against base and
 * 2/9 with the cap removed, so it pins both halves of the fix; before/after frames are in docs/shots/98/.
 */
test('#98 the lobby roster strip reserves its band in flow — it is not absolutely docked to the edge', () => {
	const lobby = stripComments(TV_LOBBY);
	const stripBlock = /\.strip\s*\{([^}]*)\}/.exec(lobby)?.[1] ?? '';
	expect(stripBlock).not.toBe('');
	// The reversion: an absolutely-positioned, bottom-docked strip is exactly what painted over the
	// address. In flow it cannot overlap the stack, so it must be neither.
	expect(/position:\s*absolute/.test(stripBlock)).toBe(false);
	expect(/bottom:\s*0/.test(stripBlock)).toBe(false);
	// AND it must be CAPPED: in flow but unbounded, the strip grows tall enough (8 long names -> three
	// rows) to shrink the region below the fixed-height stack, which then overflows the address back into
	// the band. A vh-keyed max-height bounds it so the region always clears the stack; dropping the cap
	// reintroduces the overlap at 720p.
	expect(/max-height:\s*[0-9.]+vh/.test(stripBlock)).toBe(true);
	expect(/overflow:\s*hidden/.test(stripBlock)).toBe(true);
});

test('#98 the lobby centres its stack in the space ABOVE the strip, not across the whole box', () => {
	const lobby = stripComments(TV_LOBBY);
	// The lobby is a column: the stack region and the strip stack vertically, so the strip's height is
	// subtracted from the region the stack centres in. A row/absolute lobby would let them overlap.
	const lobbyBlock = /\.lobby\s*\{([^}]*)\}/.exec(lobby)?.[1] ?? '';
	expect(/flex-direction:\s*column/.test(lobbyBlock)).toBe(true);
	// The centring moved off `.lobby` (which now only stacks) onto a region that takes the leftover
	// space with `flex: 1`. Without `flex: 1` the region collapses to content height and the strip no
	// longer pushes the stack up — so this is the line that does the reserving.
	const regionBlock = /\.stack-region\s*\{([^}]*)\}/.exec(lobby)?.[1] ?? '';
	expect(regionBlock).not.toBe('');
	expect(/flex:\s*1/.test(regionBlock)).toBe(true);
	expect(/justify-content:\s*center/.test(regionBlock)).toBe(true);
	// And the markup must actually WRAP the stack in that region, or the CSS rule guards nothing.
	expect(/<div class="stack-region">\s*<div class="stack">/.test(TV_LOBBY)).toBe(true);
});
