// A WORKER'S RESOLVED PROFILE REACHES /metrics. `/api/metrics` builds its worker list field by field, so a field
// added to `WorkerSession` never leaves the server unless the route names it, and the shot fixture injects it
// anyway: the page change looked right in every shot while the live page showed nothing. This probe sends a
// real hello to a built core and reads the live endpoint and pages, no fixture.
import { test, expect } from '../../world/fixtures';
import { startFakeWorker } from '../../world/workers';
import { WebSocket } from 'ws';

const PROFILE = {
	backend: 'torch',
	device: 'cuda',
	threads: 16,
	demucsJobs: 4,
	asrCompute: 'float16',
	warmup: true,
	handSet: ['threads']
};
const HOST = { accelerator: 'cuda', deviceName: 'NVIDIA RTX 4070', cpuCount: 8 };
const HELLO = {
	type: 'worker:hello',
	workerId: 'gpu-1',
	capabilities: ['stems'],
	concurrency: 1,
	version: 't',
	host: HOST,
	...PROFILE
};

const VIEWPORTS = [
	{ name: '390', width: 390, height: 844 },
	{ name: '320', width: 320, height: 640 },
	{ name: 'desktop', width: 1440, height: 900 }
];

test('the profile a worker sends in hello is on /api/metrics and the /metrics page', async ({ world, browser }) => {
	const token = encodeURIComponent(world.core.workerToken() ?? '');
	const ws = new WebSocket(`${world.baseURL.replace(/^http/, 'ws')}/ws?role=worker&token=${token}`);
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});
	ws.send(JSON.stringify(HELLO));

	await expect
		.poll(async () => (await (await world.hostGet('/api/metrics')).json()).workers[0]?.profile)
		.toEqual({ ...PROFILE, concurrency: 1 });

	for (const vp of VIEWPORTS) {
		const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, baseURL: world.baseURL });
		await world.becomeHost(page);
		await page.goto(`${world.baseURL}/metrics`);
		const worker = page.locator('.worker', { hasText: 'gpu-1' });
		await worker.scrollIntoViewIfNeeded();
		await expect(worker).toContainText('cuda (auto)');
		await expect(worker).toContainText('16 (set by hand)');
		// Neither set nor picked by the box: a fixed default, never "auto" (goal 2 counts the auto ones).
		await expect(worker).toContainText('1 (default)');
		// demucs jobs is picked from the cores (#1284).
		await expect(worker).toContainText('4 (auto)');
		await expect(worker).toContainText('demucs jobs');
		await expect(worker).toContainText('jobs at once');
		await expect(worker).toContainText('NVIDIA RTX 4070');
		// Said once: the resolved device hides the host's `accelerator`, which repeated it under another name.
		await expect(worker).not.toContainText('accelerator');
		await page.screenshot({ path: test.info().outputPath(`metrics-worker-${vp.name}.png`), fullPage: false });
		await page.close();
	}
	ws.close();
});

test("a song's history says what its worker ran with, and which of it was set by hand", async ({ world, browser }) => {
	test.setTimeout(90_000);
	const phone = await world.openPhone('Host');
	const worker = await startFakeWorker(world, {
		workerId: 'den-pc',
		profile: { backend: 'torch', device: 'cpu', threads: 16, demucsJobs: 4, handSet: ['demucsJobs'] }
	});
	try {
		const media = await world.awaitDemoTrack('caroline');
		expect((await phone.request.post('/api/process', { data: { mediaId: media.id } })).ok()).toBe(true);
		type Attempt = { jobType: string; outcome: string | null };
		const attempts = async (): Promise<Attempt[]> =>
			((await (await world.hostGet(`/api/audit/${media.id}`)).json()).processes ?? []).flatMap(
				(p: { attempts: Attempt[] }) => p.attempts
			);
		await expect
			.poll(async () => (await attempts()).some((a) => a.outcome === 'ready'), {
				timeout: 60_000,
				message: worker.log()
			})
			.toBe(true);
		// A guest gets the catalog row alone: no attempts, so none of the profile.
		const guest = await (await phone.request.get(`/api/audit/${media.id}`)).json();
		expect(Object.keys(guest)).toEqual(['media']);

		for (const vp of VIEWPORTS.slice(0, 2)) {
			const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, baseURL: world.baseURL });
			await world.becomeHost(page);
			await page.goto(`${world.baseURL}/metrics/${media.id}`);
			await expect(page.getByText('4 (set by hand)').first()).toBeVisible();
			await expect(page.getByText('16 (auto)').first()).toBeVisible();
			await expect(page.getByText('jobs at once').first()).toBeVisible();
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
			).toBe(true);
			await page.screenshot({ path: test.info().outputPath(`song-history-${vp.name}.png`), fullPage: true });
			await page.close();
		}
	} finally {
		await worker.stop();
	}
});
