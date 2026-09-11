// defect 3: the three previously-untimed Bun.spawn sites (ytdlp availability, loudness probe,
// retention transcoder) must be killed if the child hangs — on the DETACHED boot chain a hung ffmpeg
// stalls every later pass SILENTLY forever, and a hang is not a rejection so the chain's .catch never
// fires. runCapturing adds the kill timer (the ratified pattern already on yt-dlp search).
import { test, expect } from 'bun:test';
import { runCapturing } from './spawn-capture';

// A fake child that NEVER exits on its own — `exited` resolves only once kill() is called. Models a
// hung ffmpeg. `stdout`/`stderr` are empty streams so the Response reads resolve.
function hungSpawn() {
	let resolveExited: (code: number) => void;
	const exited = new Promise<number>((r) => {
		resolveExited = r;
	});
	const empty = () =>
		new ReadableStream<Uint8Array>({
			start(c) {
				c.close();
			}
		});
	const proc = {
		exited,
		get exitCode() {
			return null as number | null;
		},
		stdout: empty(),
		stderr: empty(),
		kill: () => {
			resolveExited(143);
		} // SIGTERM-ish; the point is it only ends BECAUSE we killed it
	};
	return proc as unknown as ReturnType<typeof Bun.spawn>;
}

function quickSpawn(code: number, stderrText = '') {
	const one = (text: string) =>
		new ReadableStream<Uint8Array>({
			start(c) {
				if (text) c.enqueue(new TextEncoder().encode(text));
				c.close();
			}
		});
	const proc = {
		exited: Promise.resolve(code),
		get exitCode() {
			return code;
		},
		stdout: one(''),
		stderr: one(stderrText),
		kill: () => {}
	};
	return proc as unknown as ReturnType<typeof Bun.spawn>;
}

test('a hung child is KILLED after the timeout and reported timedOut (defect 3)', async () => {
	const t0 = Date.now();
	const r = await runCapturing(['sleep', 'forever'], 50, hungSpawn);
	// Without the kill timer this awaits proc.exited forever and the test times out. With it, the
	// timer fires kill() (which resolves our fake's exited) and we return promptly.
	expect(r.timedOut).toBe(true);
	expect(r.code).toBeNull(); // a killed child has no meaningful exit code
	expect(Date.now() - t0).toBeLessThan(5000);
});

test('a child that exits before the timeout is NOT flagged timedOut (defect 3)', async () => {
	const r = await runCapturing(['echo', 'ok'], 5000, () => quickSpawn(0, 'some stderr'));
	expect(r.timedOut).toBe(false);
	expect(r.code).toBe(0);
	expect(r.stderr).toBe('some stderr');
});
