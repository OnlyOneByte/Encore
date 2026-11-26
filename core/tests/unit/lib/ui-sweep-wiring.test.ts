import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';
import type { Media } from '$lib/contract';
import { RoomLink } from '$lib/stores/room';

/*
 * The UI sweep's quick wins that have no cheap browser seam (encore sweeps, ui.md UI-11/13). UI-05/06/07 are
 * measured in tests/playwright/specs/probe/ui-sweep-quick-wins.spec.ts and UI-03 in the join tests. UI-13 stays
 * a source scan, as in failure-notice-scope.test.ts: which component registers a sink is wiring, not output.
 */

const read = (p: string) => readFileSync(at(p), 'utf8');

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
});

test('UI-11: the Sing tab and Library toast take their titles from the same place', () => {
	expect(read('src/routes/(phone)/+page.svelte')).toContain('room.titleOf(mediaId)');
	expect(read('src/routes/(phone)/library/+page.svelte')).toContain('songDisplay(m).title');
});

test('UI-13: one error sink, in the phone layout, and no route registers its own', () => {
	const layout = read('src/routes/(phone)/+layout.svelte');
	expect(layout).toContain('room.onError((message, kind, id) => {');
	expect(layout).toContain("if (kind === 'info') return void toast.info(message, { duration: 4000 });");
	// `id` rides along so a later action can take back ONE notice (Pick another dismisses the dead song's).
	expect(layout).toContain('toast.error(message, { duration: 4000, id });');
	for (const route of [
		'src/routes/(phone)/+page.svelte',
		'src/routes/(phone)/queue/+page.svelte',
		'src/routes/(phone)/library/+page.svelte',
		'src/routes/(phone)/song/[mediaId]/+page.svelte'
	]) {
		expect(read(route)).not.toContain('room.onError(');
	}
});
