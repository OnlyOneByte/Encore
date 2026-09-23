// A child process run with a HARD kill timer, so a hung binary cannot stall its caller forever.
// Three Bun.spawn sites (ytdlp availability, loudness probe, retention transcoder) await
// `proc.exited` through this — on the DETACHED boot maintenance chain, a hung ffmpeg would otherwise
// stall every later pass SILENTLY forever (a hang is not a rejection, so the chain's terminal
// `.catch` never fires). One timed implementation, shared by all three sites.

/** How a timed spawn ended. `timedOut` is TRUE only when we killed it for exceeding the budget. */
export interface SpawnCaptureResult {
	/** Exit code, or null if the process was killed by our timer (or never produced one). */
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * Run `argv`, capture stdout+stderr, and KILL the child if it exceeds `timeoutMs`. Never throws for
 * a non-zero exit or a timeout (reported in the result), but a spawn that can't even start (binary
 * absent) still rejects, matching Bun.spawn. stdout/stderr are awaited alongside `proc.exited`
 * because some tools (ffmpeg's volumedetect) print their summary only at the END of the run.
 */
export async function runCapturing(
	argv: string[],
	timeoutMs: number,
	spawn: typeof Bun.spawn = Bun.spawn
): Promise<SpawnCaptureResult> {
	const proc = spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
	let timedOut = false;
	const killer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	try {
		const [, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text()
		]);
		return { code: timedOut ? null : proc.exitCode, stdout, stderr, timedOut };
	} finally {
		clearTimeout(killer);
	}
}
