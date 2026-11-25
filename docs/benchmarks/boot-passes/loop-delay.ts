// How long the boot eviction pass's byte count holds the event loop (#1297). Not a gate: a shared host's load moves
// the numbers, so `probe/eviction-pass-responsive.spec.ts` is the gate. Run from core/:
//   bun ../docs/benchmarks/boot-passes/loop-delay.ts 300 1000 3000
// For each N it makes N ready songs (3 stems, 3 candidate lyrics docs and 2 fix docs each, the #1279 review's
// fixture) in a temp media folder, then counts their bytes as one synchronous map (main before #1297) and as
// `derivedBytesOfAll` (sliced). It prints each run's total time and the longest the loop was held, read by a 5 ms
// timer the way a phone's request would wait.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'encore-loop-delay-'));
process.env.MEDIA_DIR = root;
const retention = await import(join(process.cwd(), 'src/lib/server/media/retention'));

async function held(run: () => number[] | Promise<number[]>): Promise<{ ms: number; worst: number; total: number }> {
	let last = performance.now();
	let worst = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		worst = Math.max(worst, now - last);
		last = now;
	}, 5);
	const t0 = performance.now();
	const bytes = await run();
	const ms = performance.now() - t0;
	await new Promise((r) => setTimeout(r, 10));
	clearInterval(timer);
	return { ms, worst, total: bytes.reduce((a, b) => a + b, 0) };
}

try {
	for (const n of process.argv.slice(2).map(Number)) {
		rmSync(join(root, 'derived'), { recursive: true, force: true });
		for (const d of ['derived/stems', 'derived/lyrics']) mkdirSync(join(root, d), { recursive: true });
		const write = (ref: string) => (writeFileSync(join(root, ref), 'x'.repeat(64)), ref);
		const songs = Array.from({ length: n }, (_, i) => {
			const id = `01BENCH${String(i).padStart(6, '0')}`;
			const candidates = [0, 1, 2].map((k) => ({ ref: write(`derived/lyrics/${id}-c${k}.json`), textSource: 'lrclib' }));
			write(`derived/lyrics/${id}-edit-r1.json`);
			return {
				id,
				source: 'youtube',
				instrumentalRef: write(`derived/stems/${id}-instrumental.flac`),
				vocalsRef: write(`derived/stems/${id}-vocals.flac`),
				guideMixRef: write(`derived/stems/${id}-guidemix.flac`),
				lyricsRef: candidates[0]!.ref,
				lyricsCandidates: candidates,
				lyricsOverrideRef: write(`derived/lyrics/${id}-edit-r2.json`),
				lyricsOverrideText: 'pasted'
			};
		});
		const edits = retention.editRefsByMedia();
		const map = await held(() => songs.map((m) => retention.derivedBytesOf(m, edits)));
		const sliced = await held(() => retention.derivedBytesOfAll(songs, edits));
		console.log(
			`${n} songs: one map ${map.ms.toFixed(0)} ms, loop held ${map.worst.toFixed(0)} ms | ` +
				`sliced ${sliced.ms.toFixed(0)} ms, loop held at most ${sliced.worst.toFixed(0)} ms | ` +
				`bytes ${map.total} / ${sliced.total}${map.total === sliced.total ? ' (same)' : ' (DIFFER)'}`
		);
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
