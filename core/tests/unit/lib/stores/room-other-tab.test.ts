import { afterEach, expect, test } from 'bun:test';
import { RoomLink } from '$lib/stores/room';

/*
 * ONE PHONE, ONE SINGER, IN EVERY TAB (proposal 20). The tabs of one browser share one session cookie, so a join or a
 * leave in one changes who all of them are. The tab that did it says so on a BroadcastChannel; every other tab asks
 * /api/me again, as it does after a reconnect and when it comes back to the front. A 401 is the join screen, as before;
 * a DIFFERENT singer is `replacedBy`, which the layout turns into a reload as that singer.
 *
 * Real connect path against a real Bun WebSocket server and a real BroadcastChannel; only `fetch` is stood in.
 */

const restore: (() => void)[] = [];
afterEach(() => {
	for (const fn of restore.splice(0).reverse()) fn();
});

function stub<K extends string>(key: K, value: unknown): void {
	const g = globalThis as Record<string, unknown>;
	const had = key in g;
	const old = g[key];
	g[key] = value;
	restore.push(() => (had ? (g[key] = old) : delete g[key]));
}

const MAYA = { id: 's1', displayName: 'Maya', color: '#a78bfa' };
const THEO = { id: 's2', displayName: 'Theo', color: '#ff5cae' };
type Answer = typeof MAYA | 401;

/** A phone tab joined as Maya. `answer` is what every /api/me AFTER the first says. */
async function tab(first: Answer = MAYA) {
	let answer: Answer = MAYA;
	const server = Bun.serve({
		port: 0,
		fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 404 })),
		websocket: { message() {} }
	});
	restore.push(() => server.stop(true));
	const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
	stub('window', new EventTarget());
	stub('document', doc);
	stub('location', { protocol: 'http:', host: `127.0.0.1:${server.port}` });
	let asked = 0;
	stub('fetch', (url: string | URL) => {
		if (!String(url).startsWith('/api/me')) return Promise.resolve(Response.json({ library: [] }));
		const a = asked++ === 0 ? first : answer;
		return Bun.sleep(20).then(() => (a === 401 ? new Response('', { status: 401 }) : Response.json({ singer: a })));
	});
	const link = new RoomLink();
	restore.push(() => link.close());
	let replacements = 0;
	link.subscribe(() => void (link.replacedBy && replacements++));
	await link.connect();
	// Another tab of the same browser.
	const other = new BroadcastChannel('encore-session');
	restore.push(() => other.close());
	return {
		link,
		asked: () => asked,
		answer: (a: Answer) => void (answer = a),
		post: () => other.postMessage('changed'),
		show: (state: 'visible' | 'hidden') => {
			doc.visibilityState = state;
			doc.dispatchEvent(new Event('visibilitychange'));
		},
		replacements: () => replacements
	};
}

test('another tab joined as the same singer: nothing changes', async () => {
	const t = await tab();
	t.post();
	await Bun.sleep(100);
	expect(t.asked()).toBe(2);
	expect(t.link.status).toBe('joined');
	expect(t.link.replacedBy).toBeNull();
});

test('another tab joined as someone new: this tab is them now, said once', async () => {
	const t = await tab();
	t.answer(THEO);
	t.post();
	await Bun.sleep(100);
	expect(t.link.replacedBy?.displayName).toBe('Theo');
	t.post();
	t.show('visible');
	await Bun.sleep(150);
	expect(t.replacements(), 'the layout would reload more than once').toBe(1);
});

test('another tab left: the join screen with the name filled in, as after a reconnect', async () => {
	const t = await tab();
	t.answer(401);
	t.post();
	await Bun.sleep(100);
	expect(t.link.status).toBe('not-joined');
	expect(t.link.me).toBeNull();
	expect(t.link.lostName).toBe('Maya');
	expect(t.link.replacedBy).toBeNull();
});

test('a burst of messages asks once, then once more for what came in meanwhile, never alongside', async () => {
	const t = await tab();
	t.answer(THEO);
	t.post();
	t.post();
	t.post();
	await Bun.sleep(150);
	expect(t.asked() - 1).toBe(2);
	expect(t.link.replacedBy?.displayName).toBe('Theo');
});

test('a message sent while the first ask is out still gets its answer', async () => {
	const t = await tab();
	t.answer(401);
	t.post();
	await Bun.sleep(5); // the 401 ask is out
	t.answer(THEO);
	t.post();
	await Bun.sleep(150);
	expect(t.link.replacedBy?.displayName, 'the join that followed the leave was missed').toBe('Theo');
});

test('coming back to the front asks; going to the back does not', async () => {
	const t = await tab();
	t.show('hidden');
	await Bun.sleep(60);
	expect(t.asked()).toBe(1);
	t.answer(THEO);
	t.show('visible');
	await Bun.sleep(100);
	expect(t.asked()).toBe(2);
	expect(t.link.replacedBy?.displayName).toBe('Theo');
});

test('a tab on the join screen follows when another tab joins', async () => {
	const t = await tab(401);
	expect(t.link.status).toBe('not-joined');
	t.answer(THEO);
	t.post();
	await Bun.sleep(100);
	expect(t.link.replacedBy?.displayName).toBe('Theo');
});

test('a tab left on the join screen by a leave follows the next join', async () => {
	const t = await tab();
	t.answer(401);
	t.post();
	await Bun.sleep(100);
	t.answer(THEO);
	t.show('visible');
	await Bun.sleep(100);
	expect(t.link.replacedBy?.displayName).toBe('Theo');
});

test('a closed link stops listening', async () => {
	const t = await tab();
	t.link.close();
	t.answer(THEO);
	t.post();
	t.show('visible');
	await Bun.sleep(100);
	expect(t.asked()).toBe(1);
	expect(t.link.replacedBy).toBeNull();
});

test('the tab that joined or left tells the others', async () => {
	const t = await tab();
	const heard: unknown[] = [];
	const other = new BroadcastChannel('encore-session');
	restore.push(() => other.close());
	other.onmessage = (e) => heard.push(e.data);
	t.link.sessionChanged();
	await Bun.sleep(50);
	expect(heard).toHaveLength(1);
});
