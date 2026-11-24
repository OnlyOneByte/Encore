// #1213: a one-folder install (MEDIA_DIR=X, DATA_DIR=X/data) boots, and never serves the database or the worker token.
import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCore } from '../../world/core';
import { seedDemoLibrary } from '../../world/seed';

test('with DATA_DIR inside MEDIA_DIR, the database and the token are a 404, and media still plays', async () => {
	const mediaDir = mkdtempSync(join(tmpdir(), 'enc-media-'));
	seedDemoLibrary(mediaDir);
	const dataDir = join(mediaDir, 'data');
	// A file-backed DB, so there is a real encore.sqlite to ask for, and core's own token beside DATA_DIR.
	const core = await startCore({
		mediaDir,
		dataDir,
		env: { ENCORE_EPHEMERAL: '0', ENCORE_WORKER_TOKEN: '', ENCORE_WORKER_TOKEN_FILE: '' }
	});
	try {
		expect(existsSync(join(dataDir, 'encore.sqlite'))).toBe(true);
		const token = readFileSync(join(mediaDir, 'auth', 'worker-token'), 'utf8').trim();
		expect(existsSync(join(dataDir, 'encore.sqlite-shm')), 'WAL mode keeps a -shm file while core runs').toBe(true);
		for (const path of [
			'data/encore.sqlite',
			'data/encore.sqlite-wal',
			'data/encore.sqlite-shm',
			'auth/worker-token'
		]) {
			const res = await fetch(`${core.baseURL}/media/${path}`);
			expect(res.status, `GET /media/${path}`).toBe(404);
			expect(await res.text()).not.toContain(token);
			// HEAD and a byte range reach the file through the same guard, so they 404 too.
			expect((await fetch(`${core.baseURL}/media/${path}`, { method: 'HEAD' })).status, `HEAD ${path}`).toBe(404);
			const ranged = await fetch(`${core.baseURL}/media/${path}`, { headers: { Range: 'bytes=0-1' } });
			expect(ranged.status, `Range ${path}`).toBe(404);
		}

		// Non-vacuous: a real library file is still served.
		const real = readdirSync(join(mediaDir, 'library')).find((f) => f.endsWith('.wav'));
		expect((await fetch(`${core.baseURL}/media/library/${real}`)).status).toBe(200);
	} finally {
		await core.stop();
		rmSync(mediaDir, { recursive: true, force: true });
	}
});
