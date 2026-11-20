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
