// guard: the tv:telemetry frame stays lean — the fields #129 removed do not come back.
//
// THE DEFECT (#129). tv:telemetry is a ~4Hz hot-path stream. Two of its five payload fields —
// `durationSec` and `bufferedNextPct` — were declared on the shared wire contract, forwarded through
// server.ts into TvTelemetry, and read by NOTHING (handleTelemetry reads only positionSec, entryId
// and ended, the last derived at the forwarder from status). `bufferedNextPct` was additionally
// HARDCODED to the literal 100 at both producer sites, so a future server-side buffered/preload
// decision wired to it would always read "the next song is fully buffered" — including when nothing
// is warmed. This is the repo's built-never-wired class (a field that reads as supported protocol
// but is vestigial), one layer out from #107. TvTelemetry.status was the same: the forwarder reduces
// the wire status to `ended` before the handler sees it, so the copied .status was never read.
//
// THE FIX deletes those fields. WHY A SOURCE SCAN: a deletion has no runtime-observable regression by
// construction — re-adding a field nothing reads leaves the whole suite green, so a per-hunk mutation
// proof reports UNVERIFIED and cannot pin it. server.ts is the Bun.serve entry with no unit harness.
// The absence of these fields is a decidable property of the sources, so this guard encodes it: the
// wire frame, the handler type and the forwarder must not resurrect durationSec/bufferedNextPct, and
// `bufferedNextPct` (the hardcoded-100 field, whose reappearance is the sharpest regression) must not
// exist ANYWHERE in production. Matches the repo's source-scan-guard precedent
// (session-cookie-attributes.test.ts + stripComments, #107).
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Blank out comments before scanning so a mention living in a comment cannot make a "must be gone"
// check pass while production still carries the field (or vice-versa). Blanks rather than deletes so
// any reported offset still lines up. Matches the repo's stripComments convention.
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/realtime.
const EVENTS = stripComments(readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'events.ts'), 'utf8'));
const PLAYER = stripComments(readFileSync(join(import.meta.dir, 'player.ts'), 'utf8'));
const SERVER = stripComments(readFileSync(join(import.meta.dir, '..', '..', '..', 'server.ts'), 'utf8'));

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

test('the tv:telemetry wire frame declaration was found (guard is not vacuous) (#129)', () => {
	expect(TELEMETRY_VARIANT).not.toBe('');
	expect(TV_TELEMETRY_IFACE).not.toBe('');
});

test('the tv:telemetry wire frame no longer declares the dead durationSec/bufferedNextPct fields (#129)', () => {
	expect(TELEMETRY_VARIANT).not.toMatch(/durationSec/);
	expect(TELEMETRY_VARIANT).not.toMatch(/bufferedNextPct/);
	// The fields that survive — the frame still carries these and the server reads/derives from them.
	expect(TELEMETRY_VARIANT).toMatch(/positionSec/);
	expect(TELEMETRY_VARIANT).toMatch(/status/); // forwarder derives `ended` from this
});

test('the TvTelemetry handler type carries only what handleTelemetry reads (#129)', () => {
	// handleTelemetry (player.ts) reads exactly positionSec, entryId and ended. durationSec, status
	// and bufferedNextPct were copied in and never read — they must not be back on this type.
	expect(TV_TELEMETRY_IFACE).not.toMatch(/durationSec/);
	expect(TV_TELEMETRY_IFACE).not.toMatch(/bufferedNextPct/);
	expect(TV_TELEMETRY_IFACE).not.toMatch(/\bstatus\b/);
	expect(TV_TELEMETRY_IFACE).toMatch(/positionSec/);
	expect(TV_TELEMETRY_IFACE).toMatch(/ended\?/);
});

test('the server.ts forwarder does not copy the dead fields into TvTelemetry, only derives ended (#129)', () => {
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
});

test('bufferedNextPct — the hardcoded-100 field — exists nowhere in core/shared production (#129)', () => {
	// The sharpest regression is resurrecting the field a future reader would trust: a hardcoded 100
	// that always answers "next song fully buffered". Its absence is checked repo-wide (production
	// sources only; test files legitimately reference it via git history and are not scanned here).
	for (const src of [EVENTS, PLAYER, SERVER]) {
		expect(src).not.toMatch(/bufferedNextPct/);
	}
});
