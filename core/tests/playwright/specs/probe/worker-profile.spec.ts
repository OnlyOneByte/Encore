// A WORKER'S RESOLVED PROFILE REACHES /metrics. `/api/metrics` builds its worker list field by field, so a field
// added to `WorkerSession` never leaves the server unless the route names it, and the shot fixture injects it
// anyway: the page change looked right in every shot while the live page showed nothing. This probe sends a
// real hello to a built core and reads the live endpoint and page, no fixture.
import { test, expect } from '../../world/fixtures';
import { WebSocket } from 'ws';

const PROFILE = { backend: 'torch', device: 'cuda', threads: 16 };
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
	const ws = new WebSocket(`${world.baseURL.replace(/^http/, 'ws')}/ws?role=worker`);
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});
	ws.send(JSON.stringify(HELLO));

	await expect
		.poll(async () => (await (await world.hostGet('/api/metrics')).json()).workers[0]?.profile)
		.toEqual(PROFILE);

	for (const vp of VIEWPORTS) {
		const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, baseURL: world.baseURL });
		await world.becomeHost(page);
		await page.goto(`${world.baseURL}/metrics`);
		const worker = page.locator('.worker', { hasText: 'gpu-1' });
		await worker.scrollIntoViewIfNeeded();
		await expect(worker).toContainText('hardware');
		await expect(worker).toContainText('torch threads');
		await expect(worker).toContainText('NVIDIA RTX 4070');
		// Said once: the resolved device hides the host's `accelerator`, which repeated it under another name.
		await expect(worker).not.toContainText('accelerator');
		await page.screenshot({ path: test.info().outputPath(`metrics-worker-${vp.name}.png`), fullPage: false });
		await page.close();
	}
	ws.close();
});
