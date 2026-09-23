// tv:telemetry is a ~4Hz hot-path stream. Caught: `durationSec`, `bufferedNextPct` and TvTelemetry.status
// were declared on the wire contract, forwarded through server.ts, and read by NOTHING — handleTelemetry
// reads only positionSec, entryId and ended (the forwarder derives `ended` from the wire status before the
// handler sees it). `bufferedNextPct` was HARDCODED to 100 at both producer sites, so any future
// buffered/preload decision wired to it would always read "the next song is fully buffered".
//
// Re-adding a field nothing reads leaves the whole suite green, so the absence is pinned as a source
// property across all four links: wire frame, handler type, forwarder, and the client-side PRODUCER.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { read, repoRoot } from '@encore/test-support';

// Blanks rather than deletes, so reported offsets still line up.
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const EVENTS = stripComments(read('src/lib/contract/core/events.ts'));
const PLAYER = stripComments(read('src/lib/server/realtime/player.ts'));
const SERVER = stripComments(read('server.ts'));
// The producer declares its OWN copy of the wire type and JSON.stringify's the literal, so the shared union
// never reaches the value: typecheck cannot catch a field added to both that interface and that literal.
const PRODUCER = stripComments(read('src/lib/tv/telemetry.ts'));

// Isolated so a durationSec on some OTHER event (or the legitimate Media.durationSec) cannot trip these checks.
const TELEMETRY_VARIANT = (() => {
	const m = EVENTS.match(/\|\s*\{\s*type:\s*'tv:telemetry';[^}]*\}/);
	return m ? m[0] : '';
})();

// Isolated the same way, so other interfaces in player.ts do not count.
const TV_TELEMETRY_IFACE = (() => {
	const m = PLAYER.match(/export interface TvTelemetry\s*\{[\s\S]*?\n\}/);
	return m ? m[0] : '';
})();

// Isolated so an unrelated interface in telemetry.ts (e.g. StampableEntry) cannot trip these checks.
const PRODUCER_IFACE = (() => {
	const m = PRODUCER.match(/export interface TelemetryFrame\s*\{[\s\S]*?\n\}/);
	return m ? m[0] : '';
})();

// The literal telemetryFrame() hands to JSON.stringify — the second half of the two-line mutant (field added
// to the interface AND stamped here). Isolated so an unrelated return elsewhere in the file cannot count.
const PRODUCER_LITERAL = (() => {
	const m = PRODUCER.match(/return\s*\{[\s\S]*?type:\s*'tv:telemetry'[\s\S]*?\n\t\}/);
	return m ? m[0] : '';
})();

test('the tv:telemetry wire frame declaration was found (guard is not vacuous)', () => {
	expect(TELEMETRY_VARIANT).not.toBe('');
	expect(TV_TELEMETRY_IFACE).not.toBe('');
	// Both producer slices must be located, or the producer-scan below passes vacuously on an empty string.
	expect(PRODUCER_IFACE).not.toBe('');
	expect(PRODUCER_LITERAL).not.toBe('');
});

test('the tv:telemetry wire frame no longer declares the dead durationSec/bufferedNextPct fields', () => {
	expect(TELEMETRY_VARIANT).not.toMatch(/durationSec/);
	expect(TELEMETRY_VARIANT).not.toMatch(/bufferedNextPct/);
	// The fields that survive: the server reads or derives from each of these.
	expect(TELEMETRY_VARIANT).toMatch(/positionSec/);
	expect(TELEMETRY_VARIANT).toMatch(/status/); // forwarder derives `ended` from this
	// entryId is the stamp the stale-frame drops need; its wire half is otherwise held by typecheck alone.
	expect(TELEMETRY_VARIANT).toMatch(/entryId\?/);
});

test('the TvTelemetry handler type carries only what handleTelemetry reads', () => {
	// handleTelemetry reads exactly positionSec, entryId and ended; the other three were copied in, never read.
	expect(TV_TELEMETRY_IFACE).not.toMatch(/durationSec/);
	expect(TV_TELEMETRY_IFACE).not.toMatch(/bufferedNextPct/);
	expect(TV_TELEMETRY_IFACE).not.toMatch(/\bstatus\b/);
	expect(TV_TELEMETRY_IFACE).toMatch(/positionSec/);
	expect(TV_TELEMETRY_IFACE).toMatch(/ended\?/);
});

test('the server.ts forwarder does not copy the dead fields into TvTelemetry, only derives ended', () => {
	// The one handleTelemetry({...}) call the forwarder builds.
	const m = SERVER.match(/handleTelemetry\(\s*\{[^}]*\}/);
	expect(m).not.toBeNull();
	const forwarded = m![0];
	expect(forwarded).not.toMatch(/durationSec/);
	expect(forwarded).not.toMatch(/bufferedNextPct/);
	// status must not be copied through as a field, but the derivation `evt.status === 'ended'` stays.
	expect(forwarded).not.toMatch(/status:\s*evt\.status/);
	expect(forwarded).toMatch(/ended:\s*evt\.status\s*===\s*'ended'/);
	expect(forwarded).toMatch(/positionSec:\s*evt\.positionSec/);
	// The middle link of producer -> wire -> FORWARDER -> handler. Drop the entryId stamp here and the
	// handler's `t.entryId !== undefined` check goes inert for every frame (entryId is optional, so an
	// unstamped forward still typechecks) — both stale-frame drops re-open silently.
	expect(forwarded).toMatch(/entryId:\s*evt\.entryId/);
});

test('the client-side producer (lib/tv/telemetry.ts) does not carry the dead fields', () => {
	// telemetry.ts is where `<audio>.buffered` is available, so it is the natural place to re-add
	// `bufferedNextPct: 100`. The two-line mutant touches BOTH the interface and the return literal.
	expect(PRODUCER_IFACE).not.toMatch(/durationSec/);
	expect(PRODUCER_IFACE).not.toMatch(/bufferedNextPct/);
	expect(PRODUCER_LITERAL).not.toMatch(/durationSec/);
	expect(PRODUCER_LITERAL).not.toMatch(/bufferedNextPct/);
	// The fields that survive — the producer still stamps these.
	expect(PRODUCER_IFACE).toMatch(/positionSec/);
	expect(PRODUCER_LITERAL).toMatch(/positionSec/);
});

// A whole-tree walk, so a site added later is covered without editing this file; a hand-picked list would
// miss it. *.test.ts is excluded so this guard's own references do not count as offenders.
const REPO = repoRoot;
const SCANNED_EXT = ['.ts', '.svelte', '.py', '.js'];
const SKIP_DIRS = new Set(['node_modules', 'build', '.svelte-kit', 'dist', '.git', 'media', '__pycache__']);

function productionFiles(dir: string, out: string[]): string[] {
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		if (ent.isDirectory()) {
			if (SKIP_DIRS.has(ent.name)) continue;
			productionFiles(join(dir, ent.name), out);
		} else if (SCANNED_EXT.some((e) => ent.name.endsWith(e)) && !ent.name.endsWith('.test.ts')) {
			out.push(join(dir, ent.name));
		}
	}
	return out;
}

// The 30s budget is deliberate: bun's 5s default reds this arm on a checkout on an external volume, where the
// whole-tree walk takes 5-7s. A red in the guard costs a reader a triage cycle to learn nothing is wrong.
test('bufferedNextPct — the hardcoded-100 field — exists nowhere in production, repo-wide', { timeout: 30_000 }, () => {
	const files = productionFiles(REPO, []).filter((f) => statSync(f).isFile());
	// Not vacuous: the walk must reach a meaningful slice of the tree.
	expect(files.length).toBeGreaterThan(50);
	const offenders: string[] = [];
	for (const file of files) {
		if (/bufferedNextPct/.test(stripComments(readFileSync(file, 'utf8')))) {
			offenders.push(file.replace(REPO + '/', ''));
		}
	}
	expect(offenders).toEqual([]);
});
