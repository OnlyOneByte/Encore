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
import { mount, unmount, flushSync } from '$setup/svelte-client';
import JoinLanding from '$lib/components/JoinLanding.svelte';

type StateStub = typeof import('$setup/kit/app-state');
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

/*
 * RETIRED, WITH THE RULING RECORDED: 'with no code, BOTH a scan affordance and the six code inputs
 * are present'.
 *
 * That test paired `expect(target.querySelector('.scan-row')).not.toBeNull()` with the six segments
 * and called the pair the SC 3.3.8 requirement — never one path instead of the other. The scan row is
 * now deliberately GONE from this pane, so the paired assertion cannot be re-pointed: there is no
 * successor element, by decision rather than by refactor.
 *
 * Why the decision: a scanned QR carries `?room=CODE`, resolves, and opens the IDENTITY pane, so this
 * pane is only ever reached by a guest who did NOT scan. The row explained the one path that
 * guarantees you never see it. It also could not have worked as a control — `navigator.mediaDevices`
 * is secure-context gated and Encore's phones arrive over plain `http://<LAN-IP>`.
 *
 * What is NOT claimed any more: that this screen narrates the scan alternative. The alternative still
 * exists in the world (the TV shows the QR and scanning is the primary path); it is no longer
 * advertised here. If that conformance claim has to be re-made, it comes back as one line of copy in
 * the lede, and this test comes back with it.
 *
 * The half that survives is below: the six segments must still be present and must still be the way
 * in. Asserting only that would have left this file quietly weaker, so the ban is explicit — nothing
 * may reintroduce a `.scan-row` here without also restoring the paired claim.
 */
test('with no code the six code inputs are the way in, and the retired scan row stays retired', async () => {
	const { setPage } = await stateStub();
	setPage({ url: '/' });
	stubFetch(() => jsonRes({}));
	const { target, instance } = await mountLanding();
	try {
		expect(target.querySelectorAll('input.segment').length).toBe(6);
		expect(
			target.querySelector('.scan-row'),
			'the scan row was retired by decision — reinstating it means restoring the SC 3.3.8 pair above'
		).toBeNull();
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
		u.includes('/api/room-preview') ? jsonRes({ error: 'No room is using the code ZZZZZZ.' }, 404) : jsonRes({})
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
