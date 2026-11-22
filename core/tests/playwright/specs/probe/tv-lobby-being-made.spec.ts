// THE TV LOBBY SAYS A SONG IS BEING MADE FOR AS LONG AS THE PHONES DO — from the tap until the song is ready to sing.
// Two windows said "Waiting for someone to pick a song…" over a song every phone showed as "Making karaoke…":
//   - the first seconds of a FRESH room: its first add is patch rev 1, which WsClient's gap check (past rev 1) let
//     through, and the TV applies no patch, so the song reached the TV only with the next 15 s heartbeat;
//   - stems done → ready: the lobby counted "has no instrumental", so a song still being aligned read as picked-nothing.
// Sampled from the outside, the way a guest sees it: the TV's lobby line against the phone's processing card.
// `TIMELINE_SHOTS=<dir>` also writes TV 1920 and phone 390 stills of the queued → ready timeline.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SONG = 'caroline';
/** One round trip plus the process POST, with room for a loaded host — measured ~0.4 s. The first add of a fresh
 *  room used to wait for the TV's next 15 s heartbeat, or a later patch (~5.5 s here, stems landing). */
const FIRST_SIGN_MS = 2_500;
const SAMPLE_MS = 250;

interface Sample {
	t: number;
	lobby: string | null;
	phoneMaking: boolean;
	aligning: boolean;
}

test('the TV lobby calls a song "being made" from the tap until it is ready, aligning included', async ({ world }) => {
	test.setTimeout(180_000);
	const shots = process.env.TIMELINE_SHOTS;
	if (shots) mkdirSync(shots, { recursive: true });
	const worker = await startFakeWorker(world, { slowMs: 2_500 });
	try {
		await world.awaitDemoTrack(SONG);
		const phone = await world.openPhone('Maya');
		await openBrowseFromHome(phone);
		await phone.locator(SEL.search).fill(SONG);
		const sing = phone
			.locator(SEL.songRow)
			.filter({ hasText: new RegExp(SONG, 'i') })
			.locator(SEL.singAction);
		await sing.first().waitFor();
		// The TV opens LAST, so its next heartbeat is a whole beat away from the tap below.
		const tv = await world.openTv();
		await expect(tv.locator(SEL.lobby)).toContainText('Waiting for someone to pick a song');

		const t0 = Date.now();
		await sing.first().click();
		await phone.goto('/queue');
		// The stage rides `media:status` only, so a listener socket records it; the window under test is `aligning`.
		await phone.evaluate(async () => {
			const w = window as unknown as { __stage?: string };
			const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=phone`);
			ws.onmessage = (ev: MessageEvent<string>) => {
				const m = JSON.parse(ev.data) as { type?: string; status?: string };
				if (m.type === 'media:status' && m.status) w.__stage = m.status;
			};
			await new Promise((r) => (ws.onopen = r));
		});

		const samples: Sample[] = [];
		const shot = async (name: string) => {
			if (!shots) return;
			await tv.screenshot({ path: join(shots, `tv-1920-${name}.png`) });
			await phone.screenshot({ path: join(shots, `phone-390-${name}.png`) });
		};
		const taken = new Set<string>();
		const shootOnce = async (name: string) => {
			if (taken.has(name)) return;
			taken.add(name);
			await shot(name);
		};
		while (Date.now() - t0 < 120_000) {
			const lobby = tv.locator(SEL.lobby);
			const s: Sample = {
				t: Date.now() - t0,
				lobby: (await lobby.count()) ? (await lobby.innerText()).replace(/\s+/g, ' ') : null,
				phoneMaking: (await phone.locator(SEL.processing).count()) > 0,
				aligning: (await phone.evaluate(() => (window as unknown as { __stage?: string }).__stage)) === 'aligning'
			};
			samples.push(s);
			if (s.t > 500) await shootOnce('1-queued');
			if (s.t > 4_000 && !s.aligning && s.phoneMaking) await shootOnce('2-separating');
			if (s.aligning) await shootOnce('3-aligning');
			if (!s.phoneMaking && s.t > 2_000) break;
			await phone.waitForTimeout(SAMPLE_MS);
		}
		await phone.waitForTimeout(2_000);
		await shootOnce('4-ready');

		const timeline = samples.map((s) => `${s.t}ms phone=${s.phoneMaking} align=${s.aligning} tv=${s.lobby}`).join('\n');
		const firstSign = samples.find((s) => s.lobby?.includes('Making karaoke'));
		expect(firstSign, `the TV never said "Making karaoke":\n${timeline}`).toBeDefined();
		expect(
			firstSign!.t,
			`the TV said "Making karaoke" only ${firstSign!.t} ms after the tap:\n${timeline}`
		).toBeLessThan(FIRST_SIGN_MS);
		// The premise of the second window: the film reached stems-done-lyrics-pending at least once.
		expect(
			samples.some((s) => s.aligning && s.phoneMaking),
			`never sampled the aligning window:\n${timeline}`
		).toBe(true);
		const lies = samples.filter((s) => s.t >= firstSign!.t && s.phoneMaking && s.lobby?.includes('pick a song'));
		expect(lies, `the TV said "pick a song" while the phone said "Making karaoke…":\n${timeline}`).toEqual([]);
	} finally {
		await worker.stop();
	}
});
