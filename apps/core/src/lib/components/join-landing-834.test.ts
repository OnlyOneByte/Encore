// JoinLanding branching (XR-PH-14) at the mount rung. `/` is the landing page now; this
// component is its unjoined state. Three shapes are pinned here, each reds on a revert of the branch it
// targets:
//   • no code       → BOTH a scan affordance and the six-segment inputs are present.
//   • valid ?room=  → the room is confirmed in words, and NO code inputs are shown (scanned path).
//   • invalid ?room=→ the typed path renders WITH a stated reason, not a blank form.
//
// The join POST + safeNextPath navigation is covered by mount-rung.test.ts ("the landing join surface
// mounts…"); this file owns the scanned/typed shape.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mount, unmount, flushSync } from '../../../../../test-setup/svelte-client';
import JoinLanding from './JoinLanding.svelte';

type StateStub = typeof import('../../../../../test-setup/kit/app-state');
const stateStub = async (): Promise<StateStub> => (await import('$app/state')) as unknown as StateStub;

let realFetch: typeof fetch;
beforeEach(async () => {
	(await stateStub()).resetPage();
	realFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string) => Response) {
	globalThis.fetch = ((u: string) => Promise.resolve(handler(String(u)))) as typeof fetch;
}
function jsonRes(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function mountLanding() {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const instance = mount(JoinLanding, { target });
	flushSync();
	// The scanned path fetches /api/room-preview in onMount; let the fetch promise chain settle, then
	// flush Svelte's reactive updates. A macrotask covers the promise microtasks the fetch stub queues.
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	return { target, instance };
}

test('with no code, BOTH a scan affordance and the six code inputs are present', async () => {
	const { setPage } = await stateStub();
	setPage({ url: '/' });
	stubFetch(() => jsonRes({}));
	const { target, instance } = await mountLanding();
	try {
		// Scan affordance present…
		expect(target.querySelector('.scan-row')).not.toBeNull();
		// …AND six segment inputs (never one path instead of the other — the SC 3.3.8 requirement).
		expect(target.querySelectorAll('input.segment').length).toBe(6);
	} finally {
		void unmount(instance);
	}
});

test('a valid ?room= confirms the room in words and shows NO code input', async () => {
	const { setPage } = await stateStub();
	setPage({ url: '/?room=ABCD23' });
	stubFetch((u) =>
		u.includes('/api/room-preview')
			? jsonRes({ code: 'ABCD23', presentCount: 2, names: ['Maya', 'Dana'] })
			: jsonRes({})
	);
	const { target, instance } = await mountLanding();
	try {
		const confirm = target.querySelector('.confirm') as HTMLElement | null;
		expect(confirm, 'no confirmation sentence rendered').not.toBeNull();
		expect(confirm!.textContent).toContain('Maya and Dana are here.');
		// The code is confirmed in WORDS, never re-presented as an input.
		expect(target.querySelectorAll('input.segment').length).toBe(0);
		// And the code string itself is not shown.
		expect(confirm!.textContent).not.toContain('ABCD23');
	} finally {
		void unmount(instance);
	}
});

test('an unresolved ?room= drops to the typed path WITH a reason, not a blank form', async () => {
	const { setPage } = await stateStub();
	setPage({ url: '/?room=ZZZZZZ' });
	stubFetch((u) =>
		u.includes('/api/room-preview')
			? jsonRes({ error: 'No room is using the code ZZZZZZ.' }, 404)
			: jsonRes({})
	);
	const { target, instance } = await mountLanding();
	try {
		// The reason is shown…
		const err = target.querySelector('[role="alert"]') as HTMLElement | null;
		expect(err, 'no reason shown for the unresolved code').not.toBeNull();
		expect(err!.textContent).toContain('ZZZZZZ');
		// …and the typed path is offered so the guest can correct it (not a blank form).
		expect(target.querySelectorAll('input.segment').length).toBe(6);
	} finally {
		void unmount(instance);
	}
});
