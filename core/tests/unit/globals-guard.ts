import { afterAll } from 'bun:test';

// Every test file runs in one process, so a browser global one file sets and keeps leaks into every file bun
// runs after it, in an order that differs by checkout (#1321). The run fails if any file left one changed.
const g = globalThis as Record<string, unknown>;
const KEYS = ['window', 'document', 'navigator'] as const;
const start = KEYS.map((k) => g[k]);

afterAll(() => {
	const left = KEYS.filter((k, i) => g[k] !== start[i]);
	if (left.length) throw new Error(`a test file left globalThis.${left.join(', ')} changed: restore it in afterAll`);
});
