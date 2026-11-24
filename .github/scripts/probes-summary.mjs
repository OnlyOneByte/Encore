// probes.yml's summary: every job's Playwright JSON report merged into failures by file:line, flaky tests and
// the @youtube probes left out. Usage: node probes-summary.mjs <artifacts dir> <specs dir>; exits 1 on a failure.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const [resultsDir, specsDir] = process.argv.slice(2);
const runResult = process.env.RUN_RESULT ?? '';

function* files(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* files(path);
		else yield path;
	}
}

const failed = [];
const flaky = [];
const errors = [];
const totals = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
const shards = [];

function walk(suite, shard) {
	for (const spec of suite.specs ?? []) {
		for (const test of spec.tests ?? []) {
			const last = test.results?.at(-1);
			const failedAt = last?.error?.location?.line;
			const where = `specs/${spec.file}:${spec.line}` + (failedAt && failedAt !== spec.line ? ` (fails at :${failedAt})` : '');
			const message = (last?.error?.message ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 200);
			if (test.status === 'unexpected') failed.push({ where, title: spec.title, shard, message });
			if (test.status === 'flaky') flaky.push({ where, title: spec.title, shard });
		}
	}
	for (const child of suite.suites ?? []) walk(child, shard);
}

for (const path of files(resultsDir)) {
	if (!path.endsWith('/results/results.json')) continue;
	const shard = relative(resultsDir, path).split('/')[0];
	const report = JSON.parse(readFileSync(path, 'utf8'));
	shards.push({ shard, minutes: (report.stats.duration / 60_000).toFixed(1) });
	for (const key of Object.keys(totals)) totals[key] += report.stats[key] ?? 0;
	for (const suite of report.suites ?? []) walk(suite, shard);
	for (const error of report.errors ?? []) errors.push({ shard, message: (error.message ?? '').split('\n')[0] });
}

const youtube = [];
for (const path of files(specsDir)) {
	if (!path.endsWith('.spec.ts')) continue;
	readFileSync(path, 'utf8')
		.split('\n')
		.forEach((line, i) => {
			if (/\btest\(.*@youtube\b/.test(line)) youtube.push(`specs/${relative(specsDir, path)}:${i + 1}`);
		});
}

const cell = (text) => text.replaceAll('|', '\\|');
const out = [];
out.push('## Probes and gate:measured', '');
out.push(
	`${totals.expected} passed, ${totals.unexpected} failed, ${totals.flaky} flaky (passed on retry), ` +
		`${totals.skipped} skipped. Paths are under \`core/tests/playwright/\`.`,
	''
);
if (failed.length) {
	out.push('### Failed', '', '| Test | Title | Job | First line of the error |', '| --- | --- | --- | --- |');
	for (const f of failed) out.push(`| \`${f.where}\` | ${cell(f.title)} | ${f.shard} | ${cell(f.message)} |`);
	out.push('');
}
if (errors.length) {
	out.push('### Errors outside a test', '');
	for (const e of errors) out.push(`- ${e.shard}: ${e.message}`);
	out.push('');
}
if (flaky.length) {
	out.push('### Flaky', '', '| Test | Title | Job |', '| --- | --- | --- |');
	for (const f of flaky) out.push(`| \`${f.where}\` | ${cell(f.title)} | ${f.shard} |`);
	out.push('');
}
out.push('### Left out: need YouTube (`@youtube`)', '');
out.push(youtube.length ? youtube.map((w) => `- \`${w}\``).join('\n') : 'None.', '');
out.push('### Jobs', '', '| Job | Playwright minutes |', '| --- | --- |');
for (const s of shards.sort((a, b) => a.shard.localeCompare(b.shard))) out.push(`| ${s.shard} | ${s.minutes} |`);
out.push('');

// A job that died before Playwright wrote its report leaves no results.json, so trust the jobs' own result too.
const silentFailure = runResult !== 'success' && !failed.length && !errors.length;
if (silentFailure) out.push(`**A job ended \`${runResult}\` without a failing test in its report: read its log.**`);
console.log(out.join('\n'));
process.exit(failed.length || errors.length || silentFailure ? 1 : 0);
