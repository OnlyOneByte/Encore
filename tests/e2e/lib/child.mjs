import { spawn } from 'node:child_process';

/** @typedef {import('node:child_process').ChildProcess} Child */

/**
 * @param {string} cmd @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [opts] @returns {Child}
 */
export function spawnChild(cmd, args, opts = {}) {
	return spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/**
 * SIGTERM escalating to SIGKILL, POLLED rather than sleeping a fixed grace period. A missing or
 * already-exited child is a no-op, which makes this safe to call unconditionally from a `finally`.
 * @param {Child | undefined} p @param {number} [timeoutMs] @returns {Promise<void>}
 */
export async function killChild(p, timeoutMs = 3000) {
	if (!p || p.exitCode !== null) return;
	try {
		p.kill('SIGTERM');
	} catch {
		// already gone
	}
	const started = Date.now();
	while (p.exitCode === null && Date.now() - started < timeoutMs) {
		await new Promise((r) => setTimeout(r, 100));
	}
	if (p.exitCode === null) {
		try {
			p.kill('SIGKILL');
		} catch {
			// already gone
		}
	}
}
