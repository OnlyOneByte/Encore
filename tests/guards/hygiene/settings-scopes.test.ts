// Guards the settings page's three SCOPES (You / Party / Server) and the decision that came with them: identity
// has exactly ONE editor. Two editors means two save paths and two drafts re-seeding at different moments, so a
// rename typed in one could be silently reverted by a stale echo from the other. `Tabs.Content` owns the panel
// role and its labelling, so re-declaring either on an inner wrapper nests a SECOND tabpanel and every tab
// exposes two panels to a screen reader — invisible to svelte-check and to every unit test.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';
import { stripComments, svelteFiles } from '@encore/test-support/scan';

const SRC = srcDir;
const SETTINGS = join(SRC, 'routes/settings/+page.svelte');

test('the name field exists in exactly one place', () => {
	// Comments naming the retired sheet are documentation, not a second editor.
	const owners = svelteFiles(SRC).filter((f) =>
		stripComments(readFileSync(f, 'utf8'), { markup: true, keepLine: true, drop: true }).includes('id="profile-name"')
	);

	expect(owners.map((f) => f.replace(SRC, 'src'))).toEqual(['src/routes/settings/+page.svelte']);
});

test('the leave-the-room action exists in exactly one place', () => {
	// Same reasoning as the name field, and the stakes are higher: a leave clears the cookie and forgets the singer,
	// so the confirm is the only thing between a tap and a lost queue. Two paths is two confirms.
	const owners = svelteFiles(SRC).filter((f) =>
		stripComments(readFileSync(f, 'utf8'), { markup: true, keepLine: true, drop: true }).includes('Leave the room')
	);

	expect(owners.map((f) => f.replace(SRC, 'src'))).toEqual(['src/routes/settings/+page.svelte']);
});

test('nothing imports the retired profile sheet or its modal helper', () => {
	// A dangling import fails the build, so this catches a REVIVAL: `modal.ts` was focus-trap infrastructure whose
	// only consumer was that sheet.
	const offenders: string[] = [];
	for (const f of svelteFiles(SRC)) {
		const src = stripComments(readFileSync(f, 'utf8'), { markup: true, keepLine: true, drop: true });
		if (/ProfileSheet\.svelte|\$lib\/ui\/modal/.test(src)) offenders.push(f.replace(SRC, 'src'));
	}

	expect(offenders).toEqual([]);
});

test('every scope tab controls a panel that exists, and vice versa', () => {
	const src = readFileSync(SETTINGS, 'utf8');

	// The ids are template-interpolated (`id="tab-{t.id}"`), so read the TABS registry, not a hand-kept list.
	const registry = /const TABS = \[([\s\S]*?)\] as const;/.exec(src)?.[1];
	expect(registry).toBeDefined();
	const ids = [...registry!.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]!);
	expect(ids.length).toBeGreaterThan(1);

	for (const id of ids) {
		// One panel per tab. `Tabs.Content` OWNS the panel: it renders `role="tabpanel"` and labels it from its own
		// trigger, so asserting a hand-rolled `id="panel-<id>"` here would be asserting the defect.
		expect(src, `no Tabs.Content renders the ${id} scope`).toContain(`<Tabs.Content value="${id}">`);
	}

	// This page must not re-declare the tabpanel contract Tabs.Content already provides. Comments stripped first, so
	// the note explaining WHY does not trip the rule.
	const markup = stripComments(src, { markup: true, keepLine: true, drop: true });
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
	expect(src.match(/<Tabs\.Content/g)?.length).toBe(3);
	expect(src).toContain('id="tab-{t.id}"');
	// The URL sync is Encore's half and no primitive can supply it: a scope must survive a reload.
	expect(src).toMatch(/onValueChange=\{\(v\) => showTab\(/);
});

test('the room scope is what a bare /settings opens', () => {
	// The complaint that started the redesign: server-wide settings (set once, then left alone) were the first thing
	// on the page, above the rotation you change mid-song.
	const server = readFileSync(join(SRC, 'routes/settings/+page.server.ts'), 'utf8');

	expect(server).toMatch(/const DEFAULT_TAB: TabId = 'party';/);
});

test('the header name button links to the identity tab', () => {
	// The one entry point that must NOT land on the default: tapping your own name goes to your own settings.
	const phone = readFileSync(join(SRC, 'routes/+page.svelte'), 'utf8');

	expect(phone).toContain('href="/settings?tab=you"');
	expect(phone).toContain('aria-label="Your profile"');
});
