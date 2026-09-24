// guard: the boot maintenance chain must ISOLATE each pass. One pass failing or hanging must not disable the passes
// after it, and a failure must be visible and NAMED — not one terminal catch that cannot say which of six passes
// died. Two halves: the runner's behaviour in a pure harness, and the app.ts wiring that makes this runner the one
// the boot chain uses (a source scan — getApp() has no unit harness).
import { test, expect } from 'bun:test';
import { read } from '$test';
import { runBootMaintenance, type BootTask } from '$lib/server/boot-maintenance';
import { stripComments } from '$test';

test('a pass that throws does NOT skip the passes after it (the whole point of the isolated boot runner)', async () => {
	const ran: string[] = [];
	const warnings: string[] = [];
	const tasks: BootTask[] = [
		{
			name: 'first',
			run: async () => {
				ran.push('first');
			}
		},
		{
			name: 'exploder',
			run: async () => {
				ran.push('exploder');
				throw new Error('one hand-edited sidecar');
			}
		},
		{
			name: 'third',
			run: async () => {
				ran.push('third');
			}
		},
		{
			name: 'fourth',
			run: async () => {
				ran.push('fourth');
			}
		}
	];

	const { failed } = await runBootMaintenance(tasks, (m) => warnings.push(m));

	// Before the fix the throw in `exploder` aborted the chain: 'third' and 'fourth' never ran.
	expect(ran).toEqual(['first', 'exploder', 'third', 'fourth']);
	expect(failed).toEqual(['exploder']);
});

test('a failed pass surfaces a NAMED, non-silent note that keeps the stack', async () => {
	const warnings: string[] = [];
	const boom = new Error('instrumental is undefined');
	const tasks: BootTask[] = [
		{
			name: 'guiding-track backfill',
			run: async () => {
				throw boom;
			}
		}
	];

	await runBootMaintenance(tasks, (m) => warnings.push(m));

	expect(warnings).toHaveLength(1);
	// The note names WHICH pass — the exact thing the single terminal catch could not do — and keeps the stack, where
	// `(err as Error)?.message ?? err` interpolated a thrown object as "[object Object]".
	expect(warnings[0]).toContain('guiding-track backfill');
	expect(warnings[0]).toContain('FAILED');
	expect(warnings[0]).toContain('instrumental is undefined');
});

test('a thrown non-Error is reported as text, never "[object Object]"', async () => {
	const warnings: string[] = [];
	const tasks: BootTask[] = [
		{
			name: 'weird',
			run: async () => {
				throw { code: 'ENOSPC' };
			}
		}
	];
	await runBootMaintenance(tasks, (m) => warnings.push(m));
	expect(warnings[0]).not.toContain('[object Object]');
	expect(warnings[0]).toContain('ENOSPC');
});

test('a disabled pass is skipped silently (not counted as a failure)', async () => {
	const ran: string[] = [];
	const warnings: string[] = [];
	const tasks: BootTask[] = [
		{
			name: 'off',
			enabled: () => false,
			run: async () => {
				ran.push('off');
			}
		},
		{
			name: 'on',
			run: async () => {
				ran.push('on');
			}
		}
	];
	const { failed } = await runBootMaintenance(tasks, (m) => warnings.push(m));
	expect(ran).toEqual(['on']);
	expect(failed).toEqual([]);
	expect(warnings).toHaveLength(0);
});

const APP = stripComments(read('src/lib/server/app.ts'));

test('app.ts imports runBootMaintenance and drives the boot passes through it (the wiring)', () => {
	expect(APP).toMatch(/import\s*\{[^}]*\brunBootMaintenance\b[^}]*\}\s*from\s*'\.\/boot-maintenance'/);
	// The passes are a table handed to the isolated runner; a revert to a single `.then(…).catch(…)` chain breaks both.
	expect(APP).toMatch(/const\s+bootTasks\s*:\s*BootTask\[\]\s*=/);
	expect(APP).toMatch(/runBootMaintenance\(\s*bootTasks\b/);
});
