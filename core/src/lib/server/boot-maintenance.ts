// Per-pass ISOLATION runner for the boot library-maintenance chain: runs each enabled task in order,
// and if one throws, logs a NAMED warning and continues to the next — one pass's failure never skips
// the rest, and never looks identical to a pass that had nothing to do. Task bodies stay in app.ts
// (they close over the runtime catalog, job repo, and app); only the isolation contract lives here,
// provable without standing up getApp().

export interface BootTask {
	/** Human name, printed in the failure note so the operator knows WHICH pass died. */
	name: string;
	/** Optional env gate. A disabled task is skipped silently — that is not a failure. */
	enabled?: () => boolean;
	run: () => Promise<void>;
}

/** Human-readable description of a thrown value that keeps the stack for an Error and never collapses
 *  a non-Error to "[object Object]" — the one clue an operator needs from an object like `{ code: 'ENOSPC' }`. */
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

/** Run `tasks` in order with per-pass failure isolation: a task that throws does NOT stop the tasks
 *  after it, its failure is reported through `warn` (NAMED, stack retained), and the returned `failed`
 *  list lets a caller or test assert on the isolation without scraping logs. */
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
			// A faulted pass MUST NOT skip the passes after it, and must be VISIBLE and NAMED, with its
			// stack kept rather than collapsed to a message string.
			const detail = describeError(err);
			warn(`boot maintenance pass "${task.name}" FAILED (later passes still run): ${detail}`);
			failed.push(task.name);
		}
	}
	return { failed };
}
