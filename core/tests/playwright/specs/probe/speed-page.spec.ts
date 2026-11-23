// THE HOST SPEED PAGE ON REAL ROWS. Two machines process songs over the real worker protocol, a third returns a
// silent instrumental that core refuses. /api/metrics must count only the songs that reached ready, list the
// refusal under its cause, and serve the attempts as CSV. The page is shot at 390, 320 and 1440 from this core.
import { test, expect } from '../../world/fixtures';
import { startFakeWorker, type FakeWorkerOptions } from '../../world/workers';
import type { World } from '../../world/fixtures';
import type { Page } from '@playwright/test';

interface SpeedBody {
	speed: { n: number; p50Multiple: number | null };
	devices: { workerId: string; device: string | null; threads: number | null; n: number }[];
	failures: { cause: string; songs: number }[];
	workers: { workerId: string }[];
}

const VIEWPORTS = [
	{ name: '390', width: 390, height: 844 },
	{ name: '320', width: 320, height: 568 },
	{ name: '1440', width: 1440, height: 900 }
];

async function metrics(world: World): Promise<SpeedBody> {
	return (await (await fetch(`${world.baseURL}/api/metrics`)).json()) as SpeedBody;
}

/** One worker, its songs processed one at a time until each is terminal, then gone. */
async function drive(
	world: World,
	phone: Page,
	options: FakeWorkerOptions,
	queries: string[],
	done: (m: SpeedBody) => boolean
) {
	const worker = await startFakeWorker(world, options);
	try {
		await expect
			.poll(async () => (await metrics(world)).workers.some((w) => w.workerId === options.workerId))
			.toBe(true);
		for (const q of queries) {
			const media = await world.awaitDemoTrack(q);
			const res = await phone.request.post('/api/process', { data: { mediaId: media.id } });
			expect(res.ok(), `/api/process refused ${q}: ${await res.text()}`).toBe(true);
		}
		await expect.poll(async () => done(await metrics(world)), { timeout: 60_000, message: worker.log() }).toBe(true);
	} finally {
		await worker.stop();
	}
}

test('the speed page counts only songs that reached ready, and names what went wrong', async ({ world, browser }) => {
	test.setTimeout(180_000);
	const phone = await world.openPhone('Host');

	const mac = { backend: 'torch', device: 'mps', threads: 10 };
	await drive(
		world,
		phone,
		{ workerId: 'studio-mac', profile: mac, slowMs: 100 },
		['caroline', 'believin'],
		(m) => m.speed.n === 2
	);
	const pc = { backend: 'torch', device: 'cpu', threads: 16 };
	await drive(world, phone, { workerId: 'den-pc', profile: pc, slowMs: 400 }, ['bohemian'], (m) => m.speed.n === 3);
	await drive(world, phone, { workerId: 'den-pc-2', silentInstrumental: true, slowMs: 100 }, ['prayer'], (m) =>
		m.failures.some((f) => f.cause === 'silent')
	);

	const body = await metrics(world);
	// The refused song is a failure, never a fourth song in the speed figure.
	expect(body.speed.n).toBe(3);
	expect(body.failures).toEqual([expect.objectContaining({ cause: 'silent', songs: 1 })]);
	expect(body.devices.map((d) => [d.workerId, d.device, d.threads, d.n]).sort()).toEqual([
		['den-pc', 'cpu', 16, 1],
		['studio-mac', 'mps', 10, 2]
	]);

	const csv = await fetch(`${world.baseURL}/api/metrics?format=csv`);
	expect(csv.headers.get('content-type')).toContain('text/csv');
	const lines = (await csv.text()).trimEnd().split('\r\n');
	expect(lines[0]).toMatch(/^id,jobId,mediaId,processingId,jobType,/);
	expect(lines.some((l) => l.includes('digital silence'))).toBe(true);

	// A connected worker for the shots, so the page shows its live state rather than the no-worker warning.
	const idle = await startFakeWorker(world, { workerId: 'studio-mac', profile: mac });
	try {
		for (const vp of VIEWPORTS) {
			const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
			await page.goto(`${world.baseURL}/metrics`);
			await expect(page.getByRole('heading', { name: 'Pick to ready, typical song' })).toBeVisible();
			await expect(page.getByText('Vocal removal came out silent')).toBeVisible();
			await expect(page.locator('.split li', { hasText: 'studio-mac' })).toContainText('Vocals out');
			// Tenet 4: no sideways scroll, on the page or in the by-machine table, at the smallest phone.
			const machines = page.locator('[data-slot="card"]', { hasText: 'By machine' }).locator('.machines');
			const [scroll, client] = await machines.evaluate((el) => [el.scrollWidth, el.clientWidth]);
			expect(scroll, `by-machine table at ${vp.name}: ${scroll}px wide in ${client}px`).toBeLessThanOrEqual(client!);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
			).toBe(true);
			await page.screenshot({ path: test.info().outputPath(`speed-${vp.name}.png`), fullPage: true });
			await page.close();
		}
	} finally {
		await idle.stop();
	}
});
