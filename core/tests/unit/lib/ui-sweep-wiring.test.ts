import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';
import type { Media } from '$lib/contract';
import { RoomLink } from '$lib/stores/room';

/*
 * The UI sweep's quick wins (encore sweeps, ui.md UI-05/06/07/11/13). A source scan where there is no seam to
 * drive, as in failure-notice-scope.test.ts: the component-mount harness is gone, and these are wirings a later
 * edit can quietly undo.
 */

const read = (p: string) => readFileSync(at(p), 'utf8');
const tv = read('src/routes/tv/+page.svelte');
const strip = read('src/lib/ui/NowPlayingStrip.svelte');
const layout = read('src/routes/+layout.svelte');

test('UI-05: a long singer name ellipsises instead of running under the transport', () => {
	const who = strip.match(/\n\t\.who \{[^}]*\}/)?.[0] ?? '';
	expect(who).toContain('min-width: 0;');
	expect(who).toContain('overflow: hidden;');
	expect(who).toContain('text-overflow: ellipsis;');
	expect(who).toMatch(/max-width: \d+%;/);
});

test('UI-06: the won’t-play overlay is off the lobby, and cleared when its song ends or the room drains', () => {
	expect(tv).toContain('{#if playbackFailedReason && !isAttract}');
	expect(tv).toMatch(/function onVisibleEnded\(\) \{[^}]*playbackFailedReason = null;/);
	// A skip never reaches `onVisibleEnded`, so without this the next singer's song opened under the old failure.
	expect(tv).toMatch(/\$effect\(\(\) => \{\s*if \(isAttract\) playbackFailedReason = null;\s*\}\);/);
});

test('UI-07: the TV never prints the browser’s error name to the room', () => {
	const overlay = tv.slice(tv.indexOf('class="silent-room"'), tv.indexOf('</div>', tv.indexOf('class="silent-room"')));
	expect(overlay).toContain('won’t play');
	expect(overlay).not.toContain('{playbackFailedReason}');
});

test('UI-11: a message about a song names it as the TV does, not by its raw upload title', () => {
	const link = new RoomLink();
	link.mediaCatalog = new Map([
		[
			'm1',
			{
				id: 'm1',
				title: 'Mr. Brightside (Official Video)',
				artist: 'TheKillersVEVO',
				titleCanonical: 'Mr. Brightside',
				artistCanonical: 'The Killers'
			} as Media
		],
		[
			'm2',
			{
				id: 'm2',
				title: 'raw upload',
				artist: 'SomeChannel',
				titleCanonical: null,
				artistCanonical: null
			} as unknown as Media
		]
	]);
	expect(link.titleOf('m1')).toBe('Mr. Brightside — The Killers');
	// No canonical artist means no artist, never the uploader.
	expect(link.titleOf('m2')).toBe('raw upload');
	expect(read('src/routes/+page.svelte')).not.toMatch(/\$\{m\.title\}/);
	expect(read('src/routes/library/+page.svelte')).not.toMatch(/\$\{m\.title\}/);
});

test('UI-13: one error sink, in the root layout, and no route registers its own', () => {
	expect(layout).toContain('onMount(() => room.onError((message) => toast.error(message, { duration: 4000 })));');
	for (const route of [
		'src/routes/+page.svelte',
		'src/routes/queue/+page.svelte',
		'src/routes/library/+page.svelte',
		'src/routes/song/[mediaId]/+page.svelte'
	]) {
		expect(read(route)).not.toContain('room.onError(');
	}
});
