// The per-pass ISOLATION runner for the boot library-maintenance chain (defect 1).
//
// The chain used to be a single 168-line promise chain under one terminal `.catch`: a rejection in
// any pass skipped every pass after it, and the one log line named no pass. Because every downstream
// reporter is zero-guarded, a pass that never executed produced byte-identical output to a pass that
// ran with nothing to do — so on a steady-state library a failure in pass 1 was indistinguishable
// from one in pass 5, and one hand-edited sidecar silently disabled backfill, lyrics and retention.
//
// This is that fix as a PURE, testable unit: run each enabled task, and if one throws, log a NAMED
// warning and CONTINUE to the next — one pass's failure never skips the rest. The task bodies stay in
// app.ts (they close over the runtime catalog, the job repo and the app); only the isolation contract
// lives here, where it can be proven without standing up getApp().

export interface BootTask {
	/** Human name, printed in the failure note so the operator knows WHICH pass died. */
	name: string;
	/** Optional env gate. A disabled task is skipped silently — that is not a failure. */
	enabled?: () => boolean;
	run: () => Promise<void>;
}

/**
 * Run `tasks` in order with per-pass failure isolation. A task that throws (or rejects) does NOT
 * prevent the tasks after it from running; its failure is reported through `warn`, NAMED, with the
 * stack retained. Returns the names of the tasks that failed, so a caller (or a test) can assert on
 * the isolation without scraping logs.
 */
/**
 * A human-readable description of a thrown value that keeps the stack for an Error and does NOT
 * collapse a thrown non-Error to "[object Object]" — the old catch did `(err as Error)?.message ?? err`,
 * so a thrown object (e.g. `{ code: 'ENOSPC' }`) interpolated as "[object Object]" and lost the one
 * clue the operator needed.
 */
function describeError(err: unknown): string {
	if (err instanceof Error) return err.stack ?? err.message;
	if (err && typeof err === 'object') {
		try {
			return JSON.stringify(err);
		} catch {
			return Object.prototype.toString.call(err);
		}
	}
	return String(err);
}

export async function runBootMaintenance(
	tasks: BootTask[],
	warn: (msg: string) => void = (m) => console.warn(m)
): Promise<{ failed: string[] }> {
	const failed: string[] = [];
	for (const task of tasks) {
		if (task.enabled && !task.enabled()) continue;
		try {
			await task.run();
		} catch (err) {
			// A failed/faulted pass MUST NOT skip the passes after it, and it must be VISIBLE and NAMED —
			// the old single terminal catch could not say which of six passes died. Keep the stack: the
			// prior catch discarded it (`(err as Error)?.message`) and interpolated a thrown non-Error as
			// "[object Object]".
			const detail = describeError(err);
			warn(`boot maintenance pass "${task.name}" FAILED (later passes still run): ${detail}`);
			failed.push(task.name);
		}
	}
	return { failed };
}
