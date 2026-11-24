// The dev server, for the /components stories: they are dev-only (a 404 in the build `startCore` runs), so a primitive
// that no screen uses yet can only be filmed here. Bound to 127.0.0.1, and its own scratch DATA_DIR and MEDIA_DIR.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { freePort, repoRoot } from './core';

export interface Gallery {
	readonly baseURL: string;
	/** Go to `path` and wait for `ready`. The first visit loads twice: vite's dependency optimizer reloads the page
	 *  once when the client first asks for a module it had not bundled, which would destroy a test's context. */
	open(page: Page, path: string, ready: string): Promise<void>;
	/** Everything `vite dev` printed, for a failing test to attach. */
	log(): string;
	stop(): Promise<void>;
}

/** Boot `vite dev` and wait until `path` answers. Throws rather than skipping, like `startCore`. */
export async function startGallery(path = '/components/spotlight'): Promise<Gallery> {
	const port = await freePort();
	const dir = mkdtempSync(join(tmpdir(), 'enc-gallery-'));
	const baseURL = `http://127.0.0.1:${port}`;
	let output = '';
	const proc = spawn('bun', ['--bun', 'vite', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
		cwd: repoRoot,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true,
		// Its own vite cache and SvelteKit output: shared, parallel instances collide on a cold optimise (ENOTEMPTY)
		// and reload each other's pages when one rewrites the generated files.
		env: {
			...process.env,
			DATA_DIR: dir,
			MEDIA_DIR: dir,
			ENCORE_EPHEMERAL: '1',
			ENCORE_VITE_CACHE_DIR: join(dir, 'vite'),
			ENCORE_VITE_NO_WATCH: '1'
		}
	});
	proc.stdout?.on('data', (d: Buffer) => (output += d.toString()));
	proc.stderr?.on('data', (d: Buffer) => (output += d.toString()));
	const signal = (sig: NodeJS.Signals) => {
		try {
			process.kill(-proc.pid!, sig);
		} catch {
			// the group is already gone
		}
	};
	const stop = async () => {
		if (proc.exitCode === null && proc.pid !== undefined) {
			signal('SIGTERM');
			const deadline = Date.now() + 5_000;
			while (proc.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
			if (proc.exitCode === null) signal('SIGKILL');
		}
		rmSync(dir, { recursive: true, force: true });
	};
	const deadline = Date.now() + 60_000;
	let up = false;
	while (!up && proc.exitCode === null && Date.now() < deadline) {
		// Per request too: the first SSR waits on vite's dependency scan, and a hung fetch would outlive the deadline.
		up = await fetch(baseURL + path, { signal: AbortSignal.timeout(10_000) })
			.then((r) => r.ok)
			.catch(() => false);
		if (!up) await new Promise((r) => setTimeout(r, 200));
	}
	if (!up) {
		await stop();
		throw new Error(`vite dev did not serve ${baseURL}${path} within 60s.\n\n${output}`);
	}
	let warm = false;
	const open = async (page: Page, to: string, ready: string) => {
		// Under load the optimiser's reload can land seconds late, so settle until a 3 s window passes with none.
		for (let i = 0; !warm && i < 6; i++) {
			let reloads = 0;
			const seen = (f: Frame) => void (f === page.mainFrame() && reloads++);
			await page.goto(baseURL + to, { waitUntil: 'networkidle' });
			page.on('framenavigated', seen);
			await page.waitForTimeout(3_000);
			page.off('framenavigated', seen);
			warm = reloads === 0;
		}
		const res = await page.goto(baseURL + to, { waitUntil: 'networkidle' });
		if (!res?.ok()) throw new Error(`vite dev answered ${res?.status()} for ${to}.\n\n${output.slice(-4000)}`);
		await page.locator(ready).waitFor();
	};
	return { baseURL, open, log: () => output, stop };
}
