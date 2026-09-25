import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Media } from '$lib/contract';
import { processIsTerminal, mergeCatalog, snapshot } from '$lib/tv/catalog';
import { at } from '$test';

// Caught: a song finishing PROCESSING yanked the playing song's playhead back. The route minted a fresh
// `Media` identity on every `media:status` tick, `syncSlots()` handed TvPlayer a new object, and the seek
// $effect — which read `media` / `isPlayable(media)` as TRACKED dependencies — re-applied `seekSec`, stale
// by design because position telemetry does not broadcast. These pin the BOUNDARY, not one fix's spelling.

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
 * Every way the live `Media` type could get a binding inside a component allowed only the
 * `PlaybackSnapshot` seam. `not.toContain('type Media')` had a PROVEN hole: the braces in
 * `import type { Media } from '…'` sit between the two words, so alternative 1 looks for `Media` anywhere
 * INSIDE the braces and 2–5 are the spellings braces cannot see. No `g` flag: `lastIndex` would carry
 * across `.test()` calls and make the mutation arm below order-dependent.
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
		const next = mergeCatalog(prev, [
			{ ...playing },
			media({ id: 'justProcessed', stemStatus: 'ready', instrumentalRef: 'inst/j.flac' })
		]);
		// The SAME OBJECT, not a copy: identity is what a reactive consumer wakes on, and waking moved the playhead.
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
		// Non-strict mode swallows a stray write and strict throws; what matters is the value does not change.
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
		catalog = mergeCatalog(catalog, [media({ id: 'playing', stemStatus: 'queued' })]);
		expect(catalog.get('playing')!.stemStatus).toBe('queued');
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

	// The elements and the slot flag are banned too: an INPUT to the decision must never be a TRIGGER for it.
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
		// `untrack(() => vocals)` was the original case: the guide element MOUNTING re-ran the seek effect and
		// yanked the master to a stale position. That element is gone; the rule governs the three reads left.
		for (const read of ['untrack(() => master)', 'untrack(() => media)', 'untrack(() => active)']) {
			expect(body).toContain(read);
		}
	});

	it('takes the playing song as a snapshot type, so the page cannot hand it a live catalog record', () => {
		const code = stripComments(player);
		expect(code).toContain('media: PlaybackSnapshot | null;');
		// The seam is imported CO-LOCATED (`./catalog`), the sibling form every other seam here takes;
		// `$lib/tv/catalog` is the non-co-located spelling, pinned on the route below.
		expect(code).toContain("import type { PlaybackSnapshot } from './catalog';");
		// Reported as the matched text rather than a bare boolean, so a future failure names the leak.
		expect(code.match(MEDIA_LEAKS)?.[0] ?? null).toBe(null);
		// The src resolver takes the snapshot too, so no path through this component re-widens to Media.
		expect(code).toContain('function fileSrc(m: PlaybackSnapshot): string {');
	});

	// A negative assertion that CANNOT fail is worse than none, so the ban is exercised in both directions here.
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
			['the contract helpers this component does take', "import { playbackRef, isPlayable } from '$lib/contract';"],
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

		// The ban is quiet on the real component, so the assertion above passes because the boundary HOLDS.
		expect(MEDIA_LEAKS.test(stripComments(player))).toBe(false);
	});

	// A plain function, not a second `$effect`: as an effect every read it makes would be tracked again and
	// `untrack` would be the only thing between a catalog churn and the playhead.
	it('applySeek is a plain function, so the dependency set belongs to the one calling effect', () => {
		const after = player.split('function applySeek(seekTarget: number): void {')[1] ?? '';
		expect(after).not.toBe('');
		const close = after.indexOf('\n\t}');
		expect(close).toBeGreaterThan(0);
		// Read the closing token itself: a body sliced at `\n\t}` can never contain its own `});`, which is how
		// this assertion was blind on its first draft.
		expect(after.slice(close + 3, close + 4)).not.toBe(')');
		expect(after.slice(0, close)).not.toContain('$effect');
	});
});

describe('the TV route has exactly one catalog writer, and the process path is not it', () => {
	const code = stripComments(route);

	it('assigns mediaCatalog in exactly one place, through mergeCatalog', () => {
		// A second writer is how this bug existed, so the COUNT is the guard, not the spelling.
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
		// A local copy is how there came to be two writers, so the rule above would otherwise hold by coincidence.
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
