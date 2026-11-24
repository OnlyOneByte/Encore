// #1206: a symlink planted inside the media tree must not serve the file it points at.
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '../../world/fixtures';

test('a symlink out of the media tree is a 404, and the real files still play', async ({ world }) => {
	const outside = mkdtempSync(join(tmpdir(), 'encore-outside-'));
	try {
		const secret = join(outside, 'worker-token');
		writeFileSync(secret, 'not for the network');
		symlinkSync(secret, join(world.mediaDir, 'link-to-token'));
		symlinkSync(secret, join(world.mediaDir, 'library', 'token.wav'));
		symlinkSync(outside, join(world.mediaDir, 'library', 'outside-dir'));

		for (const path of ['link-to-token', 'library/token.wav', 'library/outside-dir/worker-token']) {
			const res = await fetch(`${world.baseURL}/media/${path}`);
			expect(res.status, `GET /media/${path}`).toBe(404);
			expect(await res.text()).not.toContain('not for the network');
		}

		// Non-vacuous: a real library file is still served.
		const real = readdirSync(join(world.mediaDir, 'library')).find((f) => f.endsWith('.wav') && f !== 'token.wav');
		expect((await fetch(`${world.baseURL}/media/library/${real}`)).status).toBe(200);
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
});
