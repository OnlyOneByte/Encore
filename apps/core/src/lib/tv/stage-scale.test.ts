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

test('no TV type is sized below the ten-foot floor with a literal rem', () => {
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/font-size:\s*([0-9.]+)rem/g)) {
			const rem = Number(m[1]);
			if (rem < MIN_TV_REM) {
				offenders.push(
					`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${rem}rem (${rem * 16}px) — use var(--tv-label|body|name|hero)`
				);
			}
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
