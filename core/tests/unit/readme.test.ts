// The README is the fresh-clone path, and nothing else exercises it (TL-05): the repo root has no
// package.json, so every bun command it shows must run from core/, and every relative link must resolve.
import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

test('every relative link in the README resolves', () => {
	const broken = [...README.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
		.map((m) => m[1])
		.filter((href) => !/^[a-z]+:/i.test(href) && !existsSync(join(ROOT, href)));
	expect(broken).toEqual([]);
});

test('no README code block runs a bun package command before cd-ing into core/', () => {
	const offenders: string[] = [];
	for (const [, body] of README.matchAll(/```bash\n([\s\S]*?)```/g)) {
		let inCore = false;
		for (const line of body.split('\n')) {
			if (/^\s*cd core\b/.test(line)) inCore = true;
			else if (/^\s*cd /.test(line)) inCore = false;
			else if (/^\s*bun (install|run|test)\b/.test(line) && !inCore) offenders.push(line.trim());
		}
	}
	expect(offenders).toEqual([]);
});
