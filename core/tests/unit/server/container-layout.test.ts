// The runtime image (docker/core.Dockerfile) runs server.ts from source with no tsconfig and no
// .svelte-kit, and installs deps with only the files it COPYs. Two ways that silently broke the README
// quick start (BE-01, BE-02) are pinned here, because no other test boots the container's layout.
import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const CORE = resolve(import.meta.dir, '../../..');
const transpiler = new Bun.Transpiler({ loader: 'ts' });

function resolveLocal(from: string, spec: string): string | null {
	const base = resolve(dirname(from), spec);
	for (const p of [base, `${base}.ts`, join(base, 'index.ts'), base.replace(/\.js$/, '.ts')]) {
		if (p.endsWith('.ts') && existsSync(p)) return p;
	}
	return null;
}

test('nothing server.ts loads at runtime imports a SvelteKit alias ($lib, $app, $env)', () => {
	const offenders: string[] = [];
	const seen = new Set<string>();
	const todo = [join(CORE, 'server.ts')];
	while (todo.length) {
		const file = todo.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		// scanImports drops type-only imports, which are erased and so cannot fail at runtime.
		for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
			if (path.startsWith('$')) offenders.push(`${file.slice(CORE.length + 1)} -> ${path}`);
			else if (path.startsWith('.')) {
				const next = resolveLocal(file, path);
				if (next) todo.push(next);
			}
		}
	}
	expect(seen.size).toBeGreaterThan(20); // the walk really followed the graph
	expect(offenders).toEqual([]);
});

test('compose hands ENCORE_WORKER_TOKEN to both core and the worker', () => {
	// compose's docker/.env only feeds `${}` substitution: a key a service does not list never reaches it.
	const compose = Bun.YAML.parse(readFileSync(join(CORE, '../docker/compose.yaml'), 'utf8')) as {
		services: Record<string, { environment: string[] }>;
	};
	for (const service of ['core', 'worker']) {
		expect(compose.services[service]!.environment).toContain('ENCORE_WORKER_TOKEN=${ENCORE_WORKER_TOKEN:-}');
	}
});

// Read by the code but owned by the image or compose itself: in-container paths, binaries and internals.
// Forwarding a docker/.env value for these would point the container at a HOST path (dev.sh rewrites them
// for the native run). Every other setting a service reads must be in its `environment:` list.
const CONTAINER_OWNED: Record<'core' | 'worker', string[]> = {
	core: [
		'HOST',
		'DATA_DIR',
		'FFMPEG_BIN',
		'ENCORE_MIGRATIONS_DIR',
		'ENCORE_DEV_HARNESS',
		'ENCORE_UNSERVABLE_TTL_MS' // a probe's knob (worker-hub.ts): it shortens the TTL so ui:review can film what follows
	],
	worker: [
		'ENCORE_MEDIA_DIR',
		'ENCORE_DBOS_DB',
		'ENCORE_ZOO_MODEL_DIR',
		'ENCORE_FFMPEG_BIN',
		'ENCORE_YTDLP_BIN',
		'ENCORE_MLX_BIN',
		'ENCORE_WORKER_VERSION',
		'HOME', // the zoo dir's fallback base, set by the image
		'XDG_CACHE_HOME',
		'XDG_CONFIG_HOME' // yt-dlp config lookup; the image uses /etc/yt-dlp.conf
	]
};

// Read from the env by Bun.S3Client itself, not by our code: object-store.ts passes only bucket, endpoint and
// region, and Bun falls back to these (bun-types/s3.d.ts "Defaults to ...").
const BUN_S3_ENV = ['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'SESSION_TOKEN', 'REGION', 'ENDPOINT'].flatMap((k) => [
	`S3_${k}`,
	`AWS_${k}`
]);

// What the scans see. Core: `env.X` / `env?.X`, `env['X']` / env[`X`], `dirFromEnv('X')` and
// `const { X, Y } = process.env`. Worker: every quoted NAME in host/config.py (the one place it parses the env),
// `os.environ.get("X")` / `os.environ["X"]` / `os.getenv("X")` anywhere, and any quoted `ENCORE_*` key.
// shortcut: a key built at runtime (env[name] outside dirFromEnv) or an env bag renamed before it is read is
// invisible to both; widen the regex when such a read lands.
const CORE_READ =
	/\benv\??\.([A-Z][A-Z0-9_]+)|\benv(?:\?\.)?\[\s*['"`]([A-Z][A-Z0-9_]+)|dirFromEnv\(\s*['"`]([A-Z][A-Z0-9_]+)|\{([^}]*)\}\s*=\s*(?:process\.)?env\b/g;
const WORKER_CONFIG_READ = /["']([A-Z][A-Z0-9_]+)["']/g;
const WORKER_READ = /os\.(?:environ\.get\(|environ\[|getenv\()\s*["']([A-Z][A-Z0-9_]+)|["'](ENCORE_[A-Z0-9_]+)["']/g;

function envReads(root: string, patterns: string[], re: RegExp): Set<string> {
	const names = new Set<string>();
	for (const pattern of patterns) {
		for (const file of new Bun.Glob(pattern).scanSync(root)) {
			if (file.includes('.test.')) continue;
			for (const m of readFileSync(join(root, file), 'utf8').matchAll(re)) {
				// A destructuring match carries the whole `{ ... }` body: take each upper-case binding in it.
				for (const name of m
					.slice(1)
					.find(Boolean)!
					.match(/\b[A-Z][A-Z0-9_]+\b/g) ?? [])
					names.add(name);
			}
		}
	}
	return names;
}

test('compose forwards every setting each service reads from docker/.env', () => {
	const compose = Bun.YAML.parse(readFileSync(join(CORE, '../docker/compose.yaml'), 'utf8')) as {
		services: Record<string, { environment: string[] }>;
	};
	const coreReads = envReads(CORE, ['server.ts', 'src/**/*.ts', 'src/**/*.js', 'src/**/*.svelte'], CORE_READ);
	for (const name of BUN_S3_ENV) coreReads.add(name);
	const worker = join(CORE, '../worker');
	const workerReads = envReads(worker, ['encore_worker/**/*.py'], WORKER_READ);
	for (const name of envReads(worker, ['encore_worker/host/config.py'], WORKER_CONFIG_READ)) workerReads.add(name);
	expect(coreReads).toContain('ENCORE_MEDIA_MAX_GB'); // the scans really found the reads
	expect(workerReads).toContain('ENCORE_LRCLIB_URL');
	for (const [service, reads] of [
		['core', coreReads],
		['worker', workerReads]
	] as const) {
		const forwarded = compose.services[service]!.environment.map((e) => e.split('=')[0]!);
		const missing = [...reads].filter((n) => !forwarded.includes(n) && !CONTAINER_OWNED[service].includes(n));
		// The reverse: a name the service never reads is a dead knob, or a secret handed to the wrong service.
		const unread = forwarded.filter((n) => !reads.has(n));
		expect({ service, missing, unread }).toEqual({ service, missing: [], unread: [] });
	}
	// The Dockerfile's default, not a pin: an `object` store set in docker/.env must reach core.
	expect(compose.services.core!.environment).toContain('MEDIA_STORE=${MEDIA_STORE:-local}');
});

test('VOLUME is declared after the chown, so the volumes start owned by the app user', () => {
	// Docker discards changes a later RUN makes to a path already declared a VOLUME.
	const dockerfile = readFileSync(join(CORE, '../docker/core.Dockerfile'), 'utf8');
	expect(dockerfile.indexOf('VOLUME [')).toBeGreaterThan(dockerfile.indexOf('chown -R bun:bun /app'));
});

test('the image copies every patch file bun install needs, in both stages', () => {
	const pkg = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8'));
	const dockerfile = readFileSync(join(CORE, '../docker/core.Dockerfile'), 'utf8');
	const patchDirs = new Set(Object.values<string>(pkg.patchedDependencies ?? {}).map((p) => dirname(p)));
	expect(patchDirs.size).toBeGreaterThan(0);
	for (const dir of patchDirs) {
		expect(dockerfile).toContain(`COPY core/${dir} ./${dir}`);
		expect(dockerfile).toContain(`COPY --from=build /app/${dir} ./${dir}`);
	}
});
