import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Media } from '$lib/contract';
import { processIsTerminal, mergeCatalog, snapshot } from '$lib/tv/catalog';
import { at } from '@encore/test-support';

/*
 * "when a song finishes PROCESSING, the currently playing song's playhead jumps back to an
 * earlier part". Reported, "fixed", and reported again four times.
 *
 * THE CALL CHAIN, from the processing-finish event to the perturbation this PR removes:
 *
 *   worker completes a process
 *     -> core `onMediaReady` (server/app.ts) publishes BOTH `queue:sync` and, via `reconcileOnReady`,
 *        `nowplaying:changed`; the process's progress ticks arrive separately as `media:status`
 *     -> TV route `media:status` handler did `new Map(mediaCatalog).set(id, {...m, stemStatus})`,
 *        minting a fresh Media identity on EVERY tick (and inventing a `stemStatus` the server never
 *        sent, so a tick on the playing song made it momentarily unplayable)
 *     -> `applyNowPlaying` -> `syncSlots()` rebuilt `slotMedia` from the catalog
 *     -> TvPlayer's `media` prop received a new object identity
 *     -> the seek `$effect` read `media` / `isPlayable(media)` as TRACKED dependencies, so it re-ran
 *     -> it re-applied `seekSec` — the position from the last playback COMMAND, stale by design,
 *        because position telemetry deliberately does not broadcast
 *     -> `master.currentTime = seekSec`: the playhead jumps BACK to wherever the last
 *        pause/seek/restart left it. Not to 0 — to an earlier part.
 *
 * That last detail is why four prior fixes missed: every one of them hardened the SRC-ASSIGNMENT path,
 * whose signature is "the song restarts from 0". The seek path was never in scope.
 *
 * These guards pin the boundary rather than the spelling of any one fix, so the class cannot return
 * through a different churn source or a newly-added consumer.
 */

const tvDir = at('src/lib/tv');
const player = readFileSync(join(tvDir, 'TvPlayer.svelte'), 'utf8');
const route = readFileSync(join(tvDir, '..', '..', 'routes', 'tv', '+page.svelte'), 'utf8');

/** Blank comments, preserving newlines: a dependency mentioned in prose is not a reactive read. */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Every way the live catalog record type `Media` could get a binding inside a component that is only
 * allowed the `PlaybackSnapshot` seam.
 *
 * This replaces `expect(code).not.toContain('type Media')`, which had a PROVEN hole: the braces in
 * `import type { Media } from '$lib/contract';` sit between the two words, so the substring never
 * matches and the most likely reopening of the boundary walked straight through the guard. Each
 * alternative below is a spelling the substring could not see:
 *
 *  1. `import … { … Media … } from` — the BRACE-LIST form, and the reason this regex exists. The
 *     optional `type` covers both `import type { Media }` and `import { type Media }` (the modifier may
 *     sit on the statement or on the specifier), and it also catches an ALIAS (`Media as CatalogRecord`)
 *     and any POSITION in the list, because it looks for `Media` anywhere inside the braces rather than
 *     adjacent to a keyword. The body is `[^{}]*` rather than `[\s\S]*?` for two reasons: it still spans
 *     NEWLINES, so a multi-line specifier list is covered, but it cannot cross a `}` — so the match is
 *     confined to one import statement instead of stitching an innocent `import {` to a `Media` further
 *     down the file.
 *  2. `import Media` / `import type Media` — a DEFAULT import needs no braces at all, so alternative 1
 *     cannot see it.
 *  3. `import * as Media` — the NAMESPACE form, which neither of the above matches.
 *  4. `type Media` / `interface Media` — a LOCAL re-declaration. There is no import to catch here, and
 *     the effect is identical: a name meaning "live catalog record" back inside this component.
 *  5. `import('…').Media` — the INLINE import type, which needs no import statement anywhere.
 *
 * Deliberately no `g` flag: a global regex carries `lastIndex` across `.test()` calls, which would make
 * the mutation arm below pass or fail depending on the order its cases run in.
 */
const MEDIA_LEAKS = new RegExp(
	[
		String.raw`import\s+(?:type\s+)?\{[^{}]*\bMedia\b[^{}]*\}\s*from`,
		String.raw`import\s+(?:type\s+)?Media\b`,
		String.raw`import\s+\*\s+as\s+Media\b`,
		String.raw`\b(?:type|interface)\s+Media\b`,
		String.raw`import\([^()]*\)\s*\.\s*Media\b`
	].join('|')
);

function media(over: Partial<Media> = {}): Media {
	return {
		id: 'm1',
		source: 'youtube',
		sourceRef: 'abc',
		title: 'Sweet Caroline',
		stemStatus: 'ready',
		instrumentalRef: 'inst/m1.flac',
		addedAt: 1,
		...over
	} as Media;
}

describe('the catalog boundary — process churn cannot reach a playing song', () => {
	it('preserves object identity for a song whose fields did not change', () => {
		const playing = media({ id: 'playing' });
		const prev = new Map([['playing', playing]]);
		// A process finishing for ANOTHER song re-sends the whole list, with the playing song unchanged.
		const next = mergeCatalog(prev, [
			{ ...playing },
			media({ id: 'justProcessed', stemStatus: 'ready', instrumentalRef: 'inst/j.flac' })
		]);
		// The playing record must be the SAME OBJECT, not a structurally-equal copy: identity is what a
		// reactive consumer wakes on, and waking is what moved the playhead.
		expect(next.get('playing')).toBe(playing);
	});

	it('returns the SAME Map when a sync changed nothing, so an idle re-sync is not a render reason', () => {
		const playing = media({ id: 'playing' });
		const prev = new Map([['playing', playing]]);
		expect(mergeCatalog(prev, [{ ...playing }])).toBe(prev);
	});

	it('a snapshot is frozen and cannot be rewritten under a playing song', () => {
		const snap = snapshot(media({ id: 'playing' }))!;
		expect(Object.isFrozen(snap)).toBe(true);
		// A stray write must not silently take effect. (Non-strict mode swallows it; strict throws. Either
		// is acceptable — what matters is that the value does not change.)
		try {
			(snap as unknown as { stemStatus: string }).stemStatus = 'queued';
		} catch {
			/* strict mode */
		}
		expect(snap.stemStatus).toBe('ready');
	});

	it('a later catalog replacement is unobservable through a snapshot already handed to a slot', () => {
		let catalog = new Map([['playing', media({ id: 'playing' })]]);
		const heldByTheSlot = snapshot(catalog.get('playing'))!;
		// The process pipeline replaces the record — the old handler's exact move, and any future writer's.
		catalog = mergeCatalog(catalog, [media({ id: 'playing', stemStatus: 'queued' })]);
		expect(catalog.get('playing')!.stemStatus).toBe('queued');
		// The playing slot still sees the song as it was when the slot was assigned.
		expect(heldByTheSlot.stemStatus).toBe('ready');
	});

	it('processIsTerminal admits only the two states that can never become playable', () => {
		expect(processIsTerminal({ type: 'media:status', mediaId: 'm', status: 'failed', pct: 0 })).toBe(true);
		expect(processIsTerminal({ type: 'media:status', mediaId: 'm', status: 'queued', pct: 0, unservable: true })).toBe(
			true
		);
		for (const status of ['queued', 'downloading', 'separating', 'aligning', 'ready'] as const) {
			expect(processIsTerminal({ type: 'media:status', mediaId: 'm', status, pct: 50 })).toBe(false);
		}
	});
});

describe('the seek effect depends on playback intent, never on the catalog', () => {
	/** The TRIGGERING effect: from its opening to the `applySeek` call it exists to make. */
	const trigger = (() => {
		const upto = player.split('applySeek(target);')[0];
		const i = upto.lastIndexOf('$effect(() => {');
		return i < 0 ? '' : stripComments(upto.slice(i));
	})();

	it('is not vacuous — the effect and its extracted body both exist', () => {
		expect(trigger).not.toBe('');
		expect(player).toContain('function applySeek(seekTarget: number): void {');
	});

	it('tracks the two playback-state values', () => {
		expect(trigger).toContain('seekSec');
		expect(trigger).toContain('seekRev');
	});

	/*
	 * THE GUARD. On base this fails on `media` and `isPlayable`, which is the defect. It also bans
	 * the elements and the slot flag, because the same argument applies to all of them: an input to the
	 * decision must never be a trigger for it, and a re-run on ANY of them re-applies a stale position.
	 */
	it('tracks NOTHING else — no catalog read, no element, no slot flag, in the effect body', () => {
		for (const banned of ['media', 'isPlayable', 'master', 'vocals', 'active']) {
			expect(trigger).not.toContain(banned);
		}
	});

	it('reads every input through untrack inside applySeek instead', () => {
		const body = stripComments(
			player.split('function applySeek(seekTarget: number): void {')[1]?.split('\n\t}')[0] ?? ''
		);
		expect(body).not.toBe('');
		for (const read of [
			'untrack(() => master)',
			'untrack(() => media)',
			'untrack(() => active)',
			'untrack(() => vocals)'
		]) {
			expect(body).toContain(read);
		}
	});

	it('takes the playing song as a snapshot type, so the page cannot hand it a live catalog record', () => {
		const code = stripComments(player);
		expect(code).toContain('media: PlaybackSnapshot | null;');
		// The type must come from the seam, and the live record type must be GONE from this component —
		// re-importing `Media` here is how the boundary would be quietly reopened.
		// The seam is imported CO-LOCATED (`./catalog`), because TvPlayer.svelte sits in `src/lib/tv/`
		// beside catalog.ts — the same directory, so it takes the sibling form every other seam in this
		// component takes (`./guide-sync`, `./video-src`, `./transport`, `./pitch-shift`). The `$lib/tv/catalog`
		// alias is what a NON-co-located consumer uses, and the route's assertion below pins that form for
		// `routes/tv/+page.svelte`. Asserting the alias here measured a spelling this component has never
		// used, so it failed on the import path rather than on the boundary it exists to defend.
		expect(code).toContain("import type { PlaybackSnapshot } from './catalog';");
		// The negative half. `not.toContain('type Media')` used to stand here and could not see
		// `import type { Media } from '$lib/contract';` — the braces break the substring. Matching on the
		// whole import shape closes that and every sibling spelling; see MEDIA_LEAKS above for why each
		// alternative is there, and the load-bearing arm below for the proof that it can still fail.
		// Reported as the matched text rather than a bare boolean, so a future failure names the leak.
		expect(code.match(MEDIA_LEAKS)?.[0] ?? null).toBe(null);
		// The src resolver takes the snapshot too, so no path through this component re-widens to Media.
		expect(code).toContain('function fileSrc(m: PlaybackSnapshot): string {');
	});

	/*
	 * THE MUTATION ARM. A negative assertion that cannot fail is worse than no assertion, because it
	 * reports green while defending nothing — which is exactly the state the substring was in for every
	 * braced import. So the ban is exercised HERE against planted sources, in both directions: it must
	 * REJECT each spelling of the leak, and it must ACCEPT the imports this component legitimately makes.
	 *
	 * The `not.toContain('type Media')` this replaces passes the first two planted cases below, which is
	 * the hole, measured rather than assumed.
	 */
	it('the Media ban is load-bearing — it rejects every import spelling and accepts the seam', () => {
		const leaks: Array<[string, string]> = [
			['the proven hole: braces between the two words', "import type { Media } from '$lib/contract';"],
			['the modifier on the specifier instead', "import { type Media } from '$lib/contract';"],
			['a multi-line specifier list', "import type {\n\tPlaybackSnapshot,\n\tMedia\n} from '$lib/contract';"],
			['aliased, so the local name is not even Media', "import type { Media as CatalogRecord } from '$lib/contract';"],
			['last in a list, with no keyword adjacent', "import type { PlaybackSnapshot, Media } from '$lib/contract';"],
			['a default import, which needs no braces', "import type Media from '$lib/contract';"],
			['the namespace form', "import * as Media from '$lib/contract';"],
			['a local type re-declaration, with no import at all', 'type Media = { id: string };'],
			['a local interface re-declaration', 'interface Media {\n\tid: string;\n}'],
			['the inline import type', "let m: import('$lib/contract').Media | null = null;"]
		];
		for (const [why, planted] of leaks) {
			// The label is in the assertion so a failure says WHICH spelling slipped through.
			expect([why, MEDIA_LEAKS.test(planted)]).toEqual([why, true]);
		}

		const allowed: Array<[string, string]> = [
			['the seam itself — the whole point of the boundary', "import type { PlaybackSnapshot } from './catalog';"],
			[
				'the contract helpers this component does take',
				"import { playbackRef, isPlayable, guideOffsetSec } from '$lib/contract';"
			],
			[
				'a sibling seam whose list is multi-line',
				"import type {\n\tPlaybackSnapshot,\n\tSongToken\n} from './transport';"
			],
			['a DOM type that merely starts with the same six letters', 'const el = master as HTMLMediaElement;'],
			['a WebAudio name that contains it', 'const node = ctx.createMediaElementSource(master);'],
			['prose-free code that names the field, not the type', 'const snap: PlaybackSnapshot | null = media;']
		];
		for (const [why, legitimate] of allowed) {
			expect([why, MEDIA_LEAKS.test(legitimate)]).toEqual([why, false]);
		}

		// And the direction that matters most: the ban is quiet on the real component as it stands today,
		// so the assertion above is passing because the boundary HOLDS, not because the regex never fires.
		expect(MEDIA_LEAKS.test(stripComments(player))).toBe(false);
	});

	/*
	 * applySeek must be a PLAIN FUNCTION, not a second `$effect`. If it were an effect, every read it
	 * makes would be tracked again and `untrack` would be the only thing standing between a catalog
	 * churn and the playhead — which is exactly the fragile arrangement this PR replaces. As a function
	 * called from one effect, the dependency set is the CALLER's, and it is two lines long.
	 */
	it('applySeek is a plain function, so the dependency set belongs to the one calling effect', () => {
		const after = player.split('function applySeek(seekTarget: number): void {')[1] ?? '';
		expect(after).not.toBe('');
		const close = after.indexOf('\n\t}');
		expect(close).toBeGreaterThan(0);
		// It must close as a FUNCTION (`\n\t}`), not as an effect (`\n\t});`). Read the token itself rather
		// than searching the body: a body sliced at `\n\t}` can never contain its own closing `});`, which
		// is how this assertion was blind on its first draft.
		expect(after.slice(close + 3, close + 4)).not.toBe(')');
		expect(after.slice(0, close)).not.toContain('$effect');
	});
});

describe('the TV route has exactly one catalog writer, and the process path is not it', () => {
	const code = stripComments(route);

	it('assigns mediaCatalog in exactly one place, through mergeCatalog', () => {
		// Every assignment to the catalog, minus its own `$state` declaration. Exactly one may remain:
		// a second writer is how this bug existed, so the COUNT is the guard, not the spelling.
		const writes = [...code.matchAll(/(let\s+)?\bmediaCatalog\s*=/g)].filter((m) => !m[1]);
		expect(writes.length).toBe(1);
		expect(code).toContain('mediaCatalog = mergeCatalog(mediaCatalog, e.media)');
	});

	it('never mints a catalog Map by hand — the shape the process handler used', () => {
		expect(code).not.toContain('new Map(mediaCatalog)');
	});

	it('takes the writer and the seam from the shared module rather than redefining them locally', () => {
		expect(code).toContain("from '$lib/tv/catalog'");
		for (const named of ['mergeCatalog', 'snapshot', 'processIsTerminal', 'type PlaybackSnapshot']) {
			expect(code).toContain(named);
		}
		// A local copy of the writer is how there came to be two writers in the first place. One
		// definition, in the seam, or the single-writer rule above is only true by coincidence.
		expect(code).not.toContain('function mergeCatalog(');
	});

	it('the media:status handler writes no catalog and invents no stemStatus', () => {
		const handler = code.split("if (e.type === 'media:status') {")[1]?.split('\n\t\t\t}')[0] ?? '';
		expect(handler).not.toBe('');
		expect(handler).not.toContain('mediaCatalog');
		expect(handler).not.toContain('stemStatus');
		// All it may still decide is the terminal-failure exit from `waiting`.
		expect(handler).toContain('processIsTerminal(e)');
	});

	it('hands the slots snapshots, taken in syncSlots and nowhere else', () => {
		expect(code).toContain('slotMedia = $state<{ A: PlaybackSnapshot | null; B: PlaybackSnapshot | null }>');
		expect(code).toContain('snapshot(mediaOf(current))');
		expect(code).toContain('snapshot(mediaOf(upNext))');
		expect(code.split(/\bsnapshot\(/).length - 1).toBe(2);
	});
});
