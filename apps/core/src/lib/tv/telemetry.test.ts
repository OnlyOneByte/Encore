// The TV telemetry FRAME — the client half of #70 and the per-frame stamp. This half had no assertion anywhere;
// the server's `t.entryId !== undefined && …` guard is INERT on an id-less frame, so a TV that stops
// stamping silently re-opens both bugs while the whole suite stays green. These run the real stamping
// code and pin its output, so a refactor that drops the stamp reddens a test that EXECUTED it.
import { test, expect } from 'bun:test';
import { telemetryFrame } from './telemetry';

const entry = { id: 'q7' };

test('telemetryFrame stamps the current entry on every frame: an `ended` frame carries current.id — the frame #70 drops when it is stale', () => {
	const f = telemetryFrame('ended', entry, 100);
	// The stamp is what makes the server's #70 drop reachable; without it the ended branch
	// falls back to the pre-#70 unconditional advance.
	expect(f.entryId).toBe('q7');
	expect(f.status).toBe('ended');
	expect(f.type).toBe('tv:telemetry');
});

test('telemetryFrame stamps the current entry on every frame: a non-`ended` position frame ALSO carries current.id — every frame must be stamped', () => {
	// Before that change only `ended` was stamped, so position frames arrived id-less and the guard's
	// first conjunct was false. This is the assertion that pins "every frame", not just ended.
	const f = telemetryFrame('playing', entry, 42.7);
	expect(f.entryId).toBe('q7');
	expect(f.status).toBe('playing');
});

test('telemetryFrame stamps the current entry on every frame: an id-less frame (nothing playing) omits entryId — the legacy arm stays load-bearing', () => {
	// telemetry.test.ts pins the server's id-less arm for a TV cached from before the upgrade;
	// mirror it here: a null `current` must produce NO entryId so that arm is actually exercised,
	// not accidentally forced to a required id.
	const f = telemetryFrame('playing', null, 33.3);
	expect(f.entryId).toBeUndefined();
	expect(f.status).toBe('playing');
});

test('telemetryFrame stamps the current entry on every frame: positionSec passes through unchanged', () => {
	const f = telemetryFrame('playing', entry, 12.5);
	expect(f.positionSec).toBe(12.5);
});
