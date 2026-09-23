import { spawn } from 'node:child_process';

/**
 * Child-process helpers for e2e drivers: a spawn whose stdio defaults to piped, and a kill that escalates
 * SIGTERM to SIGKILL rather than assuming the child went away.
 *
 * @typedef {import('node:child_process').ChildProcess} Child
 */

/**
 * Spawn a child with piped stdio by default.
 * @param {string} cmd @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [opts] @returns {Child}
 */
export function spawnChild(cmd, args, opts = {}) {
	return spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/**
 * Stop a child, escalating to SIGKILL if it does not go quietly. POLLS rather than sleeping a fixed grace
 * period, so a child that exits promptly does not cost the full timeout; a missing or already-exited child
 * is a no-op, which is what makes this safe to call unconditionally from a `finally`.
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
