// A child process run with a HARD kill timer, so a hung binary cannot stall its caller forever.
//
// WHY THIS EXISTS: three Bun.spawn sites (ytdlp availability, loudness probe, retention transcoder)
// awaited `proc.exited` with no timeout. On the request path that is a slow response; on the DETACHED
// boot maintenance chain it is worse — the chain runs its passes serially, so one hung ffmpeg stalls
// every later pass SILENTLY forever, and the chain's terminal `.catch` never fires on a hang (a hang
// is not a rejection). yt-dlp SEARCH already had the right shape (a setTimeout(kill) cleared in a
// finally); this is that pattern extracted so the other three sites share one timed, byte-identical
// implementation instead of three hand-copied ones drifting apart.

/** How a timed spawn ended. `timedOut` is TRUE only when we killed it for exceeding the budget. */
export interface SpawnCaptureResult {
	/** Exit code, or null if the process was killed by our timer (or never produced one). */
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * Run `argv`, capture stdout+stderr, and KILL the child if it runs longer than `timeoutMs`. Never
 * throws for a non-zero exit or a timeout — those are reported in the result — but a spawn that cannot
 * even start (binary absent) still rejects, matching Bun.spawn, so callers keep their existing
 * absent-binary handling.
 *
 * The stderr/stdout reads are awaited alongside `proc.exited` because a tool (ffmpeg's volumedetect,
 * for one) prints its summary only at the END of the run, so the text is complete only once exited.
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
