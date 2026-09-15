// The e2e probe runner — one command that can reach every driver in this tree.
//
// WHAT THIS SOLVES. Nineteen drivers under `tests/e2e/` were reachable from no command at all. They
// were kept deliberately (each is a written investigation of a real defect) and each was "runnable by
// hand", but nothing named them, so `e2e-reachability` carried them on an UNRUN list and the decision
// was left open. That list is what let real breakage sit unnoticed for as long as it did: six probes
// resolved their repo root one hop short, two called a `spawnChild` that existed in no scope, and a
// seventh checked for a build directory under a path that could never exist. Nothing ran them, so
// nothing said so.
//
// WHAT IT DELIBERATELY DOES NOT DO. It is not wired into `bun run gates`. Wiring ~12,000 lines of
// browser-driving into a five-leg gate that finishes in about a minute would be the wrong trade, and
// that was the actual objection recorded against fixing this. Reachability and gate membership are
// different things: these are now reachable from a command, runnable in one step, and still opt-in.
//
// WHAT "RUNNABLE" MEANS PER PROBE. Three modes, because the drivers genuinely differ:
//
//   boots   — the probe spawns its own server (and worker) and cleans up after itself.
//   serves  — the probe expects `EPORT` to name an ALREADY-RUNNING server. This runner boots one
//             shared, seeded, ephemeral server for the whole group rather than making the caller do
//             it, which is the step that used to be documented-but-manual.
//   tool    — takes arguments and answers a question rather than asserting an invariant. Named here
//             so it is reachable and discoverable, excluded from `all` because there is no default
//             argument that would mean anything.
//
// Usage:
//   bun run tests/e2e/run-probes.mjs                 # list every driver, its mode and its subject
//   bun run tests/e2e/run-probes.mjs <name>          # run one (by stem, e.g. p6-lyrics)
//   bun run tests/e2e/run-probes.mjs all             # every `boots` and `serves` probe, sequentially
//   bun run tests/e2e/run-probes.mjs boots|serves    # just that group
//
// Exit code is non-zero if any probe run failed, so this is usable from CI as-is.

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, atRepo } from './lib/repo-root.mjs';
import { spawnChild, killChild } from './lib/child.mjs';

/**
 * Every driver, its mode, and what it is FOR.
 *
 * The paths are spelled in full deliberately: `e2e-reachability` resolves reachability by looking for
 * a file's name in the text reachable from a package.json script, so this manifest is what makes each
 * of these files reachable. A discovery-by-globbing runner would run them and still leave every one of
 * them looking dead to that guard.
 */
const PROBES = [
	// ── self-booting ────────────────────────────────────────────────────────────────────────────────
	{ path: 'tests/e2e/probes/p2-guiding-track.mjs', mode: 'boots', subject: 'the guiding-track mix and its 4-channel guide' },
	{ path: 'tests/e2e/probes/p5-process-lifecycle.mjs', mode: 'boots', subject: 'process lifecycle: queue, process, retry, kill' },
	{ path: 'tests/e2e/probes/p14-playhead-vs-process.mjs', mode: 'boots', subject: 'the playhead against a concurrent process' },
	{ path: 'tests/e2e/probes/p15-reload-resume.mjs', mode: 'boots', subject: 'reload mid-song resumes at the right position' },
	{ path: 'tests/e2e/probes/p15-phone-reflow.mjs', mode: 'boots', subject: 'phone reflow across viewports (needs a built UI)' },
	{ path: 'tests/e2e/probes/p16-hero-live-controls.mjs', mode: 'boots', subject: 'the now-playing drawer: live controls, and the slider that must not dismiss it' },
	{ path: 'tests/e2e/shoot-913.mjs', mode: 'boots', kind: 'captures', subject: 'shadcn-migration screenshots (evidence, not assertions)' },

	// ── need a server this runner provides ──────────────────────────────────────────────────────────
	{ path: 'tests/e2e/probes/p1-gapless.mjs', mode: 'serves', subject: 'the gapless seam between queued songs' },
	{ path: 'tests/e2e/probes/p3-key-shift.mjs', mode: 'serves', subject: 'key-shift pitch handling' },
	{ path: 'tests/e2e/probes/p6-lyrics.mjs', mode: 'serves', subject: 'lyrics rendering and the presplit contract' },
	{ path: 'tests/e2e/probes/p8-presence-resilience.mjs', mode: 'serves', subject: 'presence across disconnects' },
	{ path: 'tests/e2e/probes/p9-settings.mjs', mode: 'serves', subject: 'the settings surface and its join-origin fallback' },
	{ path: 'tests/e2e/probes/p10-scaling.mjs', mode: 'serves', kind: 'captures', subject: 'TV stage scaling' },
	{ path: 'tests/e2e/probes/admin-delete-639.mjs', mode: 'serves', kind: 'captures', subject: 'admin delete and its confirmation posture' },
	{ path: 'tests/e2e/probes/tv-audiocontext-resume.mjs', mode: 'serves', subject: 'the TV AudioContext gesture A/B' },
	{ path: 'tests/e2e/probes/tv-scrim-empty-lobby-736.mjs', mode: 'serves', subject: 'the TV scrim over an empty lobby' },

	// ── tools ───────────────────────────────────────────────────────────────────────────────────────
	{
		path: 'tests/e2e/probes/preflight-reset-audit.mjs',
		mode: 'tool',
		subject: 'audits reset state; takes an output JSON path'
	},
	{
		path: 'tests/e2e/probes/preflight-diff.mjs',
		mode: 'tool',
		subject: 'diffs two preflight audits; takes before.json after.json'
	}
];

/**
 * `fake-align-worker.mjs` is NOT listed above and does not need to be: `p9-settings.mjs` spawns it by
 * path, and reachability follows a spawned basename as well as a static import — the guard has a
 * dedicated arm proving exactly that. Listing it as a runnable probe would be a lie about what it is.
 */

const SCRATCH = process.env.KIROCREW_SCRATCH ?? process.env.TMPDIR ?? '/tmp';
const RUN_DIR = join(SCRATCH, `e2e-probes-${process.pid}`);

/**
 * A routable-looking, non-loopback public origin.
 *
 * Not this host's real address, and it does not need to be: the server binds loopback and this value
 * only decides what the TV renders as its join URL. A LOOPBACK origin makes the attract screen render
 * its "unreachable" notice instead of the join panel, which several probes then measure as a failure
 * of the thing they were actually testing. Same reasoning, and the same synthetic address, as the
 * measured-design gate.
 */
const PUBLIC_ORIGIN_HOST = process.env.ENCORE_PROBE_ORIGIN_HOST ?? '192.168.1.20';

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} p @returns {string} */
function stem(p) {
	return p.slice(p.lastIndexOf('/') + 1).replace(/\.mjs$/, '');
}

function list() {
	const width = Math.max(...PROBES.map((p) => stem(p.path).length));
	for (const mode of ['boots', 'serves', 'tool']) {
		const group = PROBES.filter((p) => p.mode === mode);
		if (group.length === 0) continue;
		console.log(`\n${mode} (${group.length})`);
		for (const p of group) {
			console.log(`  ${stem(p.path).padEnd(width)}  ${p.subject}`);
		}
	}
	console.log(
		`\n${PROBES.length} drivers. Run one by name, or \`all\`, \`boots\`, \`serves\`.\n` +
			'Not part of `bun run gates` — these drive a real browser and take minutes, not seconds.\n'
	);
}

/**
 * Drive one library song to READY, so the `serves` probes have the fixture they ask for.
 *
 * Several of them bail with "no READY song in the library — seed + process one first". That is a real
 * precondition, not a defect: `seed-media.mjs` writes PLACEHOLDER files, enough to index, search and
 * queue but not to process. A READY song needs a worker to claim a job and report stems, which is what
 * `fake-stems-worker.mjs` exists for.
 *
 * Doing this here is the whole difference between "runnable by hand if you already know the four
 * steps" and "runnable". Returns the fake worker so the caller can reap it.
 */
/** @param {string} base @returns {Promise<import('node:child_process').ChildProcess>} */
async function prepareReadySong(base) {
	const worker = spawnChild('bun', ['run', atRepo('tests', 'e2e', 'fake-stems-worker.mjs')], {
		cwd: repoRoot,
		env: { ...process.env, EPORT: new URL(base).port },
		stdio: 'ignore'
	});

	// A session cookie: /api/search is open but /api/process is capability-gated.
	const joined = await fetch(`${base}/api/join`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName: 'probe-runner', color: 'violet' })
	});
	if (!joined.ok) throw new Error(`join failed while preparing a song: ${joined.status}`);
	const cookieHeader = joined.headers.get('set-cookie') ?? '';
	const cookie = /encore_singer=([^;]+)/.exec(cookieHeader);
	if (!cookie) throw new Error('join returned no session cookie; cannot request processing');

	const search = await fetch(`${base}/api/search?q=caroline`).then((r) => r.json());
	const hit = [...(search.ready ?? []), ...(search.processing ?? []), ...(search.results ?? [])].find(
		(m) => m.source === 'local'
	);
	if (!hit) throw new Error('no local library match to process — did seed-media.mjs run?');

	if ((search.ready ?? []).some((/** @type {{ id: string }} */ m) => m.id === hit.id)) return worker; // already there

	const asked = await fetch(`${base}/api/process`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: `encore_singer=${cookie[1]}` },
		body: JSON.stringify({ mediaId: hit.id })
	});
	if (!asked.ok) throw new Error(`POST /api/process returned ${asked.status} while preparing a song`);

	for (let i = 0; i < 80; i += 1) {
		const ready = await fetch(`${base}/api/search?q=caroline`)
			.then((r) => r.json())
			.then((d) => d.ready ?? [])
			.catch(() => []);
		if (ready.length > 0) return worker;
		await sleep(250);
	}
	await killChild(worker);
	throw new Error(
		'no song reached READY within 20s. The fake stems worker may not have connected — check that\n' +
			'ENCORE_WORKER_TOKEN is unset for this ephemeral server, since the worker role would then need it.'
	);
}

/**
 * Seed a media library and boot one PRISTINE ephemeral server, with a fake stems worker and one song
 * driven to READY. Called once per `serves` probe rather than once per run — see the loop in main() for
 * why an empty room is load-bearing.
 * @param {number} port
 */
async function bootProbeServer(port) {
	// Per-port, and deliberately NOT wiping RUN_DIR: each probe gets its own library, and clearing the
	// whole scratch tree here would delete a sibling's while it was still in use.
	const mediaDir = join(RUN_DIR, `media-${port}`);
	mkdirSync(mediaDir, { recursive: true });

	const seed = spawnChild('bun', ['run', atRepo('tests', 'e2e', 'seed-media.mjs')], {
		cwd: repoRoot,
		env: { ...process.env, MEDIA_DIR: mediaDir },
		stdio: 'ignore'
	});
	await new Promise((res) => seed.on('exit', res));

	const server = spawnChild('bun', ['run', './server.ts'], {
		cwd: repoRoot,
		env: {
			...process.env,
			ENCORE_EPHEMERAL: '1',
			PORT: String(port),
			HOST: '127.0.0.1',
			ENCORE_PUBLIC_ORIGIN: `http://${PUBLIC_ORIGIN_HOST}:${port}`,
			MEDIA_DIR: mediaDir,
			ENCORE_LYRICS_BACKFILL: '0',
			ENCORE_VOCALS_BACKFILL: '0'
		},
		stdio: 'ignore'
	});

	const base = `http://127.0.0.1:${port}`;
	let healthy = false;
	for (let i = 0; i < 60; i += 1) {
		const ok = await fetch(`${base}/health`)
			.then((r) => r.ok)
			.catch(() => false);
		if (ok) {
			healthy = true;
			break;
		}
		await sleep(250);
	}
	if (!healthy) {
		await killChild(server);
		throw new Error(
			`the probe server did not answer ${base}/health within 15s.\n` +
				'Run `bun run build` then `bun run start` by hand to see why.'
		);
	}

	let worker;
	try {
		worker = await prepareReadySong(base);
	} catch (err) {
		await killChild(server);
		throw err;
	}
	return { server, worker, mediaDir };
}

/** Run one probe as a subprocess, inheriting stdio so its own report is what the caller sees. */
/**
 * @param {{ path: string, mode: string, kind?: string, subject: string }} probe
 * @param {Record<string, string>} extraEnv
 */
async function runOne(probe, extraEnv) {
	const label = stem(probe.path);
	process.stdout.write(`\n──── ${label} (${probe.mode}) ────────────────────────────────────\n`);
	const started = Date.now();
	const child = spawnChild('bun', ['run', atRepo(probe.path)], {
		cwd: repoRoot,
		env: { ...process.env, ...extraEnv },
		stdio: 'inherit'
	});
	const code = await new Promise((res) => child.on('exit', res));
	const secs = ((Date.now() - started) / 1000).toFixed(1);
	return { label, code: code ?? 1, secs, kind: probe.kind ?? 'asserts' };
}

async function main() {
	const arg = process.argv[2];
	if (!arg || arg === 'list' || arg === '--help') {
		list();
		return 0;
	}

	let selected;
	if (arg === 'all') selected = PROBES.filter((p) => p.mode !== 'tool');
	else if (arg === 'boots' || arg === 'serves') selected = PROBES.filter((p) => p.mode === arg);
	else {
		selected = PROBES.filter((p) => stem(p.path) === arg);
		if (selected.length === 0) {
			console.error(`unknown probe: ${arg}\n`);
			list();
			return 2;
		}
		if (selected[0].mode === 'tool') {
			console.error(
				`${arg} is a tool, not a probe — it takes arguments. Run it directly:\n` +
					`  bun run ${selected[0].path} <args>\n`
			);
			return 2;
		}
	}

	// p15-phone-reflow measures a BUILT UI and bails without one; say so before spending minutes.
	if (selected.some((p) => p.path.includes('p15-phone-reflow')) && !existsSync(atRepo('build', 'client'))) {
		console.error('no built UI at build/client — run `bun run build` first (p15-phone-reflow needs it).\n');
		return 2;
	}

	const results = [];
	/*
	 * A FRESH server per `serves` probe, not one shared across the group.
	 *
	 * Sharing was the obvious optimisation and it is wrong here. Several of these probes assert on a
	 * PRISTINE room: `p8-presence-resilience` bails outright with "server was not empty at start of run",
	 * and `tv-scrim-empty-lobby-736` checks "one entry, nothing behind it". Run them after a probe that
	 * joined singers and queued songs and they report an environment failure that says nothing about the
	 * behaviour they exist to measure — and the ones that report a finding rather than bailing would report
	 * a FALSE one.
	 *
	 * The cost is one boot, seed and process cycle per probe, roughly ten seconds each. That is the right
	 * trade for a suite that is opt-in and already measured in minutes: cross-probe interference is the
	 * kind of failure that wastes an afternoon before anyone suspects the harness.
	 */
	const servesGroup = selected.filter((p) => p.mode === 'serves');
	const basePort = Number(process.env.EPORT ?? 5390);
	for (const [i, probe] of servesGroup.entries()) {
		const port = basePort + i;
		let env;
		process.stdout.write(`\nbooting a fresh server on :${port} for ${stem(probe.path)}…\n`);
		try {
			env = await bootProbeServer(port);
		} catch (err) {
			process.stdout.write(`  could not prepare the environment: ${String(err).split('\n')[0]}\n`);
			results.push({ label: stem(probe.path), code: 1, secs: '0.0', kind: probe.kind ?? 'asserts' });
			continue;
		}
		try {
			/*
			 * BOTH port variables, because the probes do not agree on one. Most read
			 * `EPORT ?? <default>`, `p1-gapless` and `p3-key-shift` read `EPORT ?? PORT ?? <default>`,
			 * and `p10-scaling` reads `PORT` ALONE. Passing only EPORT left p10 dialling its own
			 * hardcoded 5230 — where it got ERR_CONNECTION_REFUSED and still exited 0.
			 */
			results.push(
				await runOne(probe, { EPORT: String(port), PORT: String(port), MEDIA_DIR: env.mediaDir })
			);
		} finally {
			await killChild(env.worker);
			await killChild(env.server);
		}
	}

	try {
		for (const probe of selected.filter((p) => p.mode === 'boots')) {
			results.push(await runOne(probe, {}));
		}
	} finally {
		// The `serves` group reaps its own server in the loop above; this only clears the scratch tree.
		rmSync(RUN_DIR, { recursive: true, force: true });
	}

	const failed = results.filter((r) => r.code !== 0);
	process.stdout.write('\n──── summary ────────────────────────────────────────────────\n');
	for (const r of results) {
		/*
		 * `ran` is NOT `passed`, and the distinction matters more than it looks. Three of these drivers
		 * gather EVIDENCE rather than assert an invariant: they write screenshots or a findings.json and
		 * exit 0 whatever they saw. `p10-scaling` recorded twelve phases of which seven were timeouts and
		 * still exited 0. Reporting that as "ok" would make this runner a false-pass machine, which is the
		 * one thing the suite it belongs to exists to prevent.
		 */
		const verdict =
			r.code !== 0 ? 'FAIL' : r.kind === 'captures' ? 'ran ' : 'ok  ';
		process.stdout.write(`  ${verdict}  ${r.label.padEnd(28)} ${r.secs}s\n`);
	}
	const asserting = results.filter((r) => r.kind !== 'captures');
	const assertingOk = asserting.filter((r) => r.code === 0).length;
	process.stdout.write(
		`  ${assertingOk}/${asserting.length} asserting probes passed` +
			`, ${results.length - asserting.length} capture runs (read their output — exit code is not a verdict)\n\n`
	);
	return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();
