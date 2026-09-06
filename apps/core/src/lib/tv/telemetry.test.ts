// The TV telemetry FRAME — the client half of #70/#125. #130: this half had no assertion anywhere;
// the server's `t.entryId !== undefined && …` guard is INERT on an id-less frame, so a TV that stops
// stamping silently re-opens both bugs while the whole suite stays green. These run the real stamping
// code and pin its output, so a refactor that drops the stamp reddens a test that EXECUTED it.
import { describe, test, expect } from 'bun:test';
import { telemetryFrame } from './telemetry';

const entry = { id: 'q7' };

describe('telemetryFrame stamps the current entry on every frame (#70/#125, #130)', () => {
	test('an `ended` frame carries current.id — the frame #70 drops when it is stale', () => {
		const f = telemetryFrame('ended', entry, 100, 100, 0);
		// The stamp is what makes the server's #70 drop reachable; without it the ended branch
		// falls back to the pre-#70 unconditional advance.
		expect(f.entryId).toBe('q7');
		expect(f.status).toBe('ended');
		expect(f.type).toBe('tv:telemetry');
	});

	test('a non-`ended` position frame ALSO carries current.id — #125 needs every frame stamped', () => {
		// Before #125 only `ended` was stamped, so position frames arrived id-less and the guard's
		// first conjunct was false. This is the assertion that pins "every frame", not just ended.
		const f = telemetryFrame('playing', entry, 42.7, 100, 50);
		expect(f.entryId).toBe('q7');
		expect(f.status).toBe('playing');
	});

	test('an id-less frame (nothing playing) omits entryId — the legacy arm stays load-bearing', () => {
		// telemetry.test.ts pins the server's id-less arm for a TV cached from before the upgrade;
		// mirror it here: a null `current` must produce NO entryId so that arm is actually exercised,
		// not accidentally forced to a required id.
		const f = telemetryFrame('playing', null, 33.3, 100, 50);
		expect(f.entryId).toBeUndefined();
		expect(f.status).toBe('playing');
	});

	test('positionSec / durationSec / bufferedNextPct pass through unchanged', () => {
		const f = telemetryFrame('playing', entry, 12.5, 200, 87);
		expect(f.positionSec).toBe(12.5);
		expect(f.durationSec).toBe(200);
		expect(f.bufferedNextPct).toBe(87);
	});
});
