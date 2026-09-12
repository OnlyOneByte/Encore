// guard: the tv:telemetry frame stays lean — the fields the lean-frame cleanup removed do not come back.
//
// THE DEFECT. tv:telemetry is a ~4Hz hot-path stream. Two of its five payload fields —
// `durationSec` and `bufferedNextPct` — were declared on the shared wire contract, forwarded through
// server.ts into TvTelemetry, and read by NOTHING (handleTelemetry reads only positionSec, entryId
// and ended, the last derived at the forwarder from status). `bufferedNextPct` was additionally
// HARDCODED to the literal 100 at both producer sites, so a future server-side buffered/preload
// decision wired to it would always read "the next song is fully buffered" — including when nothing
// is warmed. This is the repo's built-never-wired class (a field that reads as supported protocol
// but is vestigial), one layer out from the earlier built-never-wired instance. TvTelemetry.status
// was the same: the forwarder reduces the wire status to `ended` before the handler sees it, so the
// copied .status was never read.
//
// THE FIX deletes those fields. WHY A SOURCE SCAN: a deletion has no runtime-observable regression by
// construction — re-adding a field nothing reads leaves the whole suite green, so a per-hunk mutation
// proof reports UNVERIFIED and cannot pin it. server.ts is the Bun.serve entry with no unit harness.
// The absence of these fields is a decidable property of the sources, so this guard encodes it: the
// wire frame, the handler type, the forwarder AND the client-side PRODUCER must not resurrect
// durationSec/bufferedNextPct, and `bufferedNextPct` (the hardcoded-100 field, whose reappearance is
// the sharpest regression) must not exist ANYWHERE in production. Review caught that the earlier version
// scanned only events.ts/player.ts/server.ts and NOT the producer apps/core/src/lib/tv/telemetry.ts —
// the one file the `<audio>.buffered` value is actually available at, and the natural place a
// developer would re-add the field — so a hardcoded `bufferedNextPct: 100` there left the guard 5/5
// green. The producer is now scanned directly (its own TelemetryFrame interface + the telemetryFrame()
// literal), and the repo-wide claim below is made TRUE by walking the whole production tree rather
// than a hand-picked file list, so a fourth site added later is covered without editing this file.
// Matches the repo's source-scan-guard precedents (session-cookie-attributes.test.ts + stripComments,
// ; the repo walk mirrors task-number-hygiene.test.ts).
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { read, repoRoot } from '@encore/test-support';

// Blank out comments before scanning so a mention living in a comment cannot make a "must be gone"
// check pass while production still carries the field (or vice-versa). Blanks rather than deletes so
// any reported offset still lines up. Matches the repo's stripComments convention.
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// Anchored on the repo root. `player.ts` was a SIBLING READ — this guard used to live in
// apps/core/src/lib/server/realtime/, so `at('apps/core/src/lib/server/realtime/player.ts')` meant "the player module next
// to me"; every subject is named explicitly now and was confirmed present before re-anchoring.
const EVENTS = stripComments(read('apps/core/src/lib/contract/core/events.ts'));
const PLAYER = stripComments(read('apps/core/src/lib/server/realtime/player.ts'));
const SERVER = stripComments(read('apps/core/server.ts'));
// The client-side producer of the frame. It declares its OWN copy of the wire type
// (`TelemetryFrame`) and builds the object literal that gets JSON.stringify'd to the server — so the
// shared union is never applied to the value and typecheck cannot catch a field added to both this
// interface and this literal.
const PRODUCER = stripComments(read('apps/core/src/lib/tv/telemetry.ts'));

// The tv:telemetry ClientEvent variant, isolated so a durationSec/bufferedNextPct on some OTHER event
// (or the legitimate Media.durationSec) does not falsely trip these checks.
const TELEMETRY_VARIANT = (() => {
	const m = EVENTS.match(/\|\s*\{\s*type:\s*'tv:telemetry';[^}]*\}/);
	return m ? m[0] : '';
})();

// The TvTelemetry interface body (the handler-side type), isolated the same way — Media.durationSec
// and other interfaces in player.ts must not count.
const TV_TELEMETRY_IFACE = (() => {
	const m = PLAYER.match(/export interface TvTelemetry\s*\{[\s\S]*?\n\}/);
	return m ? m[0] : '';
})();

// The producer's own TelemetryFrame interface body, isolated the same way — so an unrelated
// interface in telemetry.ts (e.g. StampableEntry) cannot falsely trip these checks.
const PRODUCER_IFACE = (() => {
	const m = PRODUCER.match(/export interface TelemetryFrame\s*\{[\s\S]*?\n\}/);
	return m ? m[0] : '';
})();

// The `return { ... }` object literal telemetryFrame() builds and hands to JSON.stringify.
// This is the second half of the issue's two-line mutant: the field is added to the interface AND
// stamped into this literal. Isolated so an unrelated return elsewhere in the file cannot count.
const PRODUCER_LITERAL = (() => {
	const m = PRODUCER.match(/return\s*\{[\s\S]*?type:\s*'tv:telemetry'[\s\S]*?\n\t\}/);
	return m ? m[0] : '';
})();

test('the tv:telemetry wire frame declaration was found (guard is not vacuous)', () => {
	expect(TELEMETRY_VARIANT).not.toBe('');
	expect(TV_TELEMETRY_IFACE).not.toBe('');
	// the producer's own interface and its built literal must both be located, or the
	// producer-scan below would pass vacuously on an empty slice.
	expect(PRODUCER_IFACE).not.toBe('');
	expect(PRODUCER_LITERAL).not.toBe('');
});

test('the tv:telemetry wire frame no longer declares the dead durationSec/bufferedNextPct fields', () => {
	expect(TELEMETRY_VARIANT).not.toMatch(/durationSec/);
	expect(TELEMETRY_VARIANT).not.toMatch(/bufferedNextPct/);
	// The fields that survive — the frame still carries these and the server reads/derives from them.
	expect(TELEMETRY_VARIANT).toMatch(/positionSec/);
	expect(TELEMETRY_VARIANT).toMatch(/status/); // forwarder derives `ended` from this
	// entryId is the stamp the stale-frame drops depend on to reach player.ts:280's drop; the wire
	// half is otherwise held by typecheck alone (deleting it makes evt.entryId a TS error).
	expect(TELEMETRY_VARIANT).toMatch(/entryId\?/);
});

test('the TvTelemetry handler type carries only what handleTelemetry reads', () => {
	// handleTelemetry (player.ts) reads exactly positionSec, entryId and ended. durationSec, status
	// and bufferedNextPct were copied in and never read — they must not be back on this type.
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
	// the middle link of the producer -> wire -> FORWARDER -> handler chain. Without the
	// entryId stamp here, player.ts:280's `t.entryId !== undefined` drop goes inert for every
	// frame (t.entryId is optional, so any unstamped form typechecks) and both stale-frame drops
	// re-open silently. The producer and handler ends are pinned; nothing pinned this middle site.
	expect(forwarded).toMatch(/entryId:\s*evt\.entryId/);
});

test('the client-side producer (lib/tv/telemetry.ts) does not carry the dead fields', () => {
	// telemetry.ts is where `<audio>.buffered` is available, so it is the natural place a
	// developer would re-add `bufferedNextPct: 100` — and it was NOT scanned before. The two-line
	// mutant adds the field to BOTH the interface and the return literal; pin both.
	expect(PRODUCER_IFACE).not.toMatch(/durationSec/);
	expect(PRODUCER_IFACE).not.toMatch(/bufferedNextPct/);
	expect(PRODUCER_LITERAL).not.toMatch(/durationSec/);
	expect(PRODUCER_LITERAL).not.toMatch(/bufferedNextPct/);
	// The fields that survive — the producer still stamps these.
	expect(PRODUCER_IFACE).toMatch(/positionSec/);
	expect(PRODUCER_LITERAL).toMatch(/positionSec/);
});

// make the "exists nowhere in production" claim TRUE by walking the whole production tree,
// mirroring task-number-hygiene.test.ts. The old version scanned three hand-picked files and
// missed the producer telemetry.ts; a fixed list would miss the NEXT new site too. The walk excludes
// *.test.ts so this guard's own references (and any other test citing the field from git history)
// are not scanned. The root is the repo root marker, not a count of hops from this file.
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

test('bufferedNextPct — the hardcoded-100 field — exists nowhere in production, repo-wide', () => {
	// The sharpest regression is resurrecting the field a future reader would trust: a hardcoded 100
	// that always answers "next song fully buffered". Walk the whole production tree so the test's own
	// name ("exists nowhere ... repo-wide") is honest — not a claim over three hand-picked files.
	const files = productionFiles(REPO, []).filter((f) => statSync(f).isFile());
	// Not vacuous: the walk must actually reach a meaningful slice of the tree.
	expect(files.length).toBeGreaterThan(50);
	const offenders: string[] = [];
	for (const file of files) {
		if (/bufferedNextPct/.test(stripComments(readFileSync(file, 'utf8')))) {
			offenders.push(file.replace(REPO + '/', ''));
		}
	}
	expect(offenders).toEqual([]);
});
