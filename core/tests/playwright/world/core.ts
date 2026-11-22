// Starting and stopping a real Encore core. ONE implementation, where 14 drivers under tests/e2e each had
// their own, plus 28 hand-rolled /health polls and 31 readings of EPORT.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This file is tests/playwright/world/, so three levels up is the repo root. */
export const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** An OS-assigned free port. Asking the kernel beats picking a number: parallel workers cannot collide. */
export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (addr === null || typeof addr === 'string') return reject(new Error('no port assigned'));
			const { port } = addr;
			srv.close(() => resolve(port));
		});
	});
}

export interface Core {
	readonly baseURL: string;
	readonly mediaDir: string;
	readonly dataDir: string;
	/** Everything core wrote to stdout/stderr. Named in a failure, so "did not come up" is never the whole story. */
	log(): string;
	stop(): Promise<void>;
	/** Stop core and boot it again on the SAME port, DATA_DIR and env, as a host reboot or a deploy would. Only
	 *  meaningful with `ENCORE_EPHEMERAL: '0'` in the env, or the new core boots an empty room. */
	restart(): Promise<void>;
}

export interface CoreOptions {
	mediaDir: string;
	/** Extra env, for a test whose CONFIGURATION is the experiment. */
	env?: Record<string, string>;
	/** A DATA_DIR the CALLER owns and removes, kept across `stop()`, for a test whose subject is a restart. */
	dataDir?: string;
}

/**
 * Boot core and wait until it answers /health.
 *
 * THROWS rather than skipping when it cannot come up. That is deliberate and it is this repo's own ruling: a
 * permanently-skipped test is indistinguishable from the rot it was meant to catch, so an environment that
 * cannot answer the question must be loud. A thrown fixture is an ERROR in the report, not a pass.
 */
export async function startCore({ mediaDir, env = {}, dataDir: ownDir }: CoreOptions): Promise<Core> {
	const port = await freePort();
	const dataDir = ownDir ?? mkdtempSync(join(tmpdir(), 'enc-data-'));
	const baseURL = `http://127.0.0.1:${port}`;
	let output = '';

	const spawnCore = (): ChildProcess =>
		spawn('bun', ['run', './server.ts'], {
			cwd: repoRoot,
			stdio: ['ignore', 'pipe', 'pipe'],
			// Its own process group, so stopping it takes the nested `bun run` and any ffmpeg with it. Without
			// this, core's children outlive the kill and hold the port against the next worker.
			detached: true,
			env: {
				...process.env,
				PORT: String(port),
				HOST: '127.0.0.1',
				MEDIA_DIR: mediaDir,
				DATA_DIR: dataDir,
				// A file-backed DB would carry one test's queue into the next run.
				ENCORE_EPHEMERAL: '1',
				// Boot passes that reach the network or the worker; a test opts in when it wants them.
				ENCORE_LYRICS_BACKFILL: '0',
				ENCORE_VOCALS_BACKFILL: '0',
				...env
			}
		});
	let proc = spawnCore();
	const capture = (p: ChildProcess) => {
		p.stdout?.on('data', (d: Buffer) => (output += d.toString()));
		p.stderr?.on('data', (d: Buffer) => (output += d.toString()));
	};
	capture(proc);

	const kill = async (): Promise<void> => {
		if (proc.exitCode === null && proc.pid !== undefined) {
			// Negative pid signals the GROUP. SIGTERM first, polled, then SIGKILL — matching dev.sh's stop_tree.
			const signal = (sig: NodeJS.Signals) => {
				try {
					process.kill(-proc.pid!, sig);
				} catch {
					// already gone, or never grouped
				}
			};
			signal('SIGTERM');
			const deadline = Date.now() + 5_000;
			while (proc.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
			if (proc.exitCode === null) signal('SIGKILL');
		}
	};
	const stop = async (): Promise<void> => {
		await kill();
		// ALWAYS, and only once the process is down so nothing is still writing into it. This is a real bug that
		// was fixed the hard way: a core boots PER TEST, so a DATA_DIR left behind each time filled this machine's
		// disk mid-session — 1101 orphaned directories, 4.3GB — until every command failed with ENOSPC. Note the
		// guard above is now an `if` rather than an early `return`: the old shape skipped cleanup entirely
		// whenever the process had already exited, which is exactly the crashed-core case that leaks most.
		if (!ownDir) rmSync(dataDir, { recursive: true, force: true });
	};

	const healthy = async (): Promise<boolean> => {
		const deadline = Date.now() + 45_000;
		while (Date.now() < deadline) {
			if (proc.exitCode !== null) {
				throw new Error(`core exited with ${proc.exitCode} before answering /health.\n\n${output}`);
			}
			const ok = await fetch(`${baseURL}/health`)
				.then((r) => r.ok)
				.catch(() => false);
			if (ok) return true;
			await new Promise((r) => setTimeout(r, 100));
		}
		return false;
	};
	const restart = async (): Promise<void> => {
		await kill();
		output += '\n[world] core restarted\n';
		proc = spawnCore();
		capture(proc);
		if (!(await healthy())) throw new Error(`core did not come back on ${baseURL} within 45s.\n\n${output}`);
	};
	if (await healthy()) return { baseURL, mediaDir, dataDir, log: () => output, stop, restart };
	await stop();
	throw new Error(`core did not answer ${baseURL}/health within 45s.\n\n${output}`);
}
