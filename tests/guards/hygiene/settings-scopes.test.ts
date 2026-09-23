//
// Guards for the settings page's three SCOPES (You / Party / Server) and, more importantly, for the
// decision that came with them: identity has exactly ONE editor.
//
// THE BUG THESE BOUND. Before the split, your name and colour were editable in a profile sheet mounted
// on the phone route. The redesign moved them onto the You tab. Had the sheet been left in place
// "temporarily", the app would have had two editors with two save paths, two optimistic updates, and
// two drafts that re-seed at different moments -- so a rename typed in one could be silently reverted
// by a stale echo from the other. Nothing in the type system objects to that; a source scan does.
//
// The tab/panel assertions are the cheap half, and they now guard the OPPOSITE spelling from the one
// they were written for. Originally the page hand-rolled `id="panel-<id>"` + `aria-labelledby="tab-<id>"`
// and the risk was an `aria-controls` pointing at an id that does not exist. `Tabs.Content` owns the
// panel role and its labelling now, so the risk inverted: re-declaring either on an inner wrapper nests
// a second tabpanel inside the first and every tab exposes two panels. Both failure modes are invisible
// to svelte-check and to every unit test, and both degrade exactly one class of user -- a screen-reader
// user, who is also the least likely to be sitting next to the developer.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';
import { svelteFiles } from '@encore/test-support/scan';

const SRC = srcDir;
const SETTINGS = join(SRC, 'routes/settings/+page.svelte');

/** Comments naming the retired sheet are documentation, not a second editor. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
}

test('the name field exists in exactly one place', () => {
	const owners = svelteFiles(SRC).filter((f) => stripComments(readFileSync(f, 'utf8')).includes('id="profile-name"'));

	expect(owners.map((f) => f.replace(SRC, 'src'))).toEqual(['src/routes/settings/+page.svelte']);
});

test('the leave-the-room action exists in exactly one place', () => {
	// Same reasoning as the name field, and the stakes are higher: a leave clears the cookie and forgets
	// the singer, so there is nothing to undo with. Two paths to it is two places to get the confirm
	// wrong, and the confirm is the only thing standing between a tap and a lost queue.
	const owners = svelteFiles(SRC).filter((f) => stripComments(readFileSync(f, 'utf8')).includes('Leave the room'));

	expect(owners.map((f) => f.replace(SRC, 'src'))).toEqual(['src/routes/settings/+page.svelte']);
});

test('nothing imports the retired profile sheet or its modal helper', () => {
	// A dangling import fails the build, so this is not about catching a typo -- it is about catching a
	// REVIVAL. `modal.ts` was focus-trap infrastructure whose only consumer was that sheet; bringing
	// either back without a consumer is how this codebase accumulates mechanisms that are built, tested
	// and never wired to anything.
	const offenders: string[] = [];
	for (const f of svelteFiles(SRC)) {
		const src = stripComments(readFileSync(f, 'utf8'));
		if (/ProfileSheet\.svelte|\$lib\/ui\/modal/.test(src)) offenders.push(f.replace(SRC, 'src'));
	}

	expect(offenders).toEqual([]);
});

test('every scope tab controls a panel that exists, and vice versa', () => {
	const src = readFileSync(SETTINGS, 'utf8');

	// The ids are template-interpolated (`id="tab-{t.id}"`), so the ids that actually reach the DOM come
	// from the TABS registry. Read it rather than a hand-kept list here, or this guard drifts.
	const registry = /const TABS = \[([\s\S]*?)\] as const;/.exec(src)?.[1];
	expect(registry).toBeDefined();
	const ids = [...registry!.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]!);
	expect(ids.length).toBeGreaterThan(1);

	for (const id of ids) {
		// One panel per tab. `Tabs.Content` OWNS the panel: it renders `role="tabpanel"` and labels it
		// from its own trigger, so the page no longer spells either. This assertion moved from
		// `id="panel-<id>"` + `aria-labelledby="tab-<id>"` when those were deleted -- the page had been
		// re-declaring both on an inner `<div>`, which nested a SECOND tabpanel inside the primitive's
		// and made every tab expose two panels to a screen reader. Asserting the old hand-rolled ids
		// here would now be asserting the defect.
		expect(src, `no Tabs.Content renders the ${id} scope`).toContain(`<Tabs.Content value="${id}">`);
	}

	// The defect above, stated as an invariant rather than left to the reviewer's memory: this page must
	// not re-declare the tabpanel contract that `Tabs.Content` already provides. Comments are stripped
	// first so the note explaining WHY does not trip the rule it explains.
	const markup = stripComments(src);
	expect(markup, 'the page re-declares role="tabpanel" that Tabs.Content already renders').not.toContain(
		'role="tabpanel"'
	);
	expect(markup, 'the page re-declares aria-labelledby that Tabs.Content already renders').not.toMatch(
		/aria-labelledby="tab-/
	);

	// The server resolves the tab so first paint is already correct; its list must match the page's.
	const server = readFileSync(join(SRC, 'routes/settings/+page.server.ts'), 'utf8');
	const serverIds = /const TAB_IDS = \[([^\]]*)\]/.exec(server)?.[1];
	expect(serverIds).toBeDefined();
	for (const id of ids) {
		expect(serverIds!, `the server load does not accept ?tab=${id}`).toContain(`'${id}'`);
	}
});

test('the scope tabs are reachable and named for assistive tech', () => {
	const src = readFileSync(SETTINGS, 'utf8');

	// A tablist with no accessible name is announced as an unlabelled group of three unrelated buttons.
	expect(src).toContain('aria-label="Settings scope"');
	expect(src).toContain('<Tabs.List');
	expect(src).toContain('<Tabs.Trigger');
	// One panel per scope, and the trigger keeps the id SEL.settingsTab and capture.mjs resolve.
	expect(src.match(/<Tabs\.Content/g)?.length).toBe(3);
	expect(src).toContain('id="tab-{t.id}"');
	// The URL sync is Encore's half and no primitive can supply it: a scope must survive a reload.
	expect(src).toMatch(/onValueChange=\{\(v\) => showTab\(/);
});

test('the room scope is what a bare /settings opens', () => {
	// The complaint that started the redesign: server-wide settings (the stem splitter, the lyrics
	// reader -- set once, then left alone) were the first thing on the page, above the rotation you
	// change mid-song. The gear links to a bare /settings, so the default decides which scope that is.
	const server = readFileSync(join(SRC, 'routes/settings/+page.server.ts'), 'utf8');

	expect(server).toMatch(/const DEFAULT_TAB: TabId = 'party';/);
});

test('the header name button links to the identity tab', () => {
	// The one entry point that must NOT land on the default: tapping your own name goes to your own
	// settings. It is a link rather than a button now, so this also pins that it navigates at all.
	const phone = readFileSync(join(SRC, 'routes/+page.svelte'), 'utf8');

	expect(phone).toContain('href="/settings?tab=you"');
	expect(phone).toContain('aria-label="Your profile"');
});
