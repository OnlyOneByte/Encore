import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: a "Couldn't make karaoke — try again" notice belongs to the guest who ASKED.
 *
 * The defect, reproduced 2/2: phone B joined, did nothing at all, and at t+122s recorded the identical toast for
 * a song phone A had tapped — plus a `encore:process-scars` entry for it. `media:status` is a room-wide broadcast
 * BY DESIGN (worker-hub records why: broadcasting a stall for an unservable `align` on a playable song would
 * regress a ready row on every phone), so the fix is not the fan-out of the STATUS, it is the fan-out of the
 * NOTICE.
 *
 * WHY A SOURCE GUARD for the client half. `RoomLink` is browser-only and `#onMediaStatus` is private — there is
 * no seam to feed an event through, and faking one would test the fake. The SERVER half, which is where the
 * attribution actually reaches the wire, is driven against the real production epilogue in
 * tests/unit/server/jobs/reaper.test.ts; the client half was driven in a real browser with two contexts. What
 * this file holds is the wiring between them, which is the part a later edit can quietly undo.
 */

const room = readFileSync(at('src/lib/stores/room.ts'), 'utf8');
const events = readFileSync(at('src/lib/contract/core/events.ts'), 'utf8');
const process = readFileSync(at('src/lib/server/jobs/process.ts'), 'utf8');
const hub = readFileSync(at('src/lib/server/jobs/worker-hub.ts'), 'utf8');

test('the contract carries the requester, optionally', () => {
	// Optional, not required: `canceled` publishers (cancel.ts, media/delete.ts) hold no job and must stay
	// compilable without inventing an attribution.
	expect(events).toContain('requestedBy?: string;');
});

test('both paths that can emit `failed` publish it', () => {
	// These are the only two. /api/process publishes `ready` and in-flight stages only, and the two `canceled`
	// publishers emit a status no toast arm reads — a field there would be noise, so its absence is deliberate.
	expect(process).toContain('requestedBy: job.singerId ?? undefined');
	expect(hub).toContain('requestedBy: job.singerId ?? undefined');
	// `?? undefined` and never `job.singerId` bare: the repository stores `singerId: null` for an unattributed
	// job, and a null on the wire contradicts the `requestedBy?: string` the contract declares.
	expect(process).not.toMatch(/requestedBy: job\.singerId\s*[,}\n]/);
	expect(hub).not.toMatch(/requestedBy: job\.singerId\s*[,}\n]/);
});

test('the client gates the NOTICE on the requester, and nothing else', () => {
	// The whole event reaches the handler, or the new field cannot be read at the one site that needs it.
	expect(room).toContain("#onMediaStatus(e: Extract<ServerEvent, { type: 'media:status' }>)");
	expect(room).toContain('this.#onMediaStatus(e);');

	const failedArm = room.slice(room.indexOf("if (status === 'failed') {"));
	// The gate, with the `!e.requestedBy` fallback: an internal or admin-side process nobody asked for is still
	// news for whoever is looking, which is the conservative direction.
	expect(failedArm).toContain('if (!e.requestedBy || e.requestedBy === this.me?.id) {');
	// Server-side attribution against `me.id`, which comes from the session cookie — so the notice still finds
	// the requester after they reload mid-wait. A client-side "did I tap this?" set would not survive that.
	expect(failedArm).not.toContain('requestedThisDevice');

	// And the gate wraps the TOAST only. The status map, the catalog's stemStatus and the scar are all unchanged
	// by it: every phone still draws the row correctly, and B's /queue row still reads "Couldn't make karaoke".
	const gateAt = failedArm.indexOf('if (!e.requestedBy');
	expect(failedArm.indexOf('recordScar(failedMedia)')).toBeLessThan(gateAt);
	expect(failedArm.slice(gateAt)).toContain("Couldn't make karaoke for");
});

test('the STATUS fan-out is untouched — this is not a narrowing of the broadcast', () => {
	// If this ever reds, the fix has been applied in the wrong place: a status gated per-requester leaves every
	// other phone's row pinned on "Making karaoke… N%" forever, which is strictly worse than a stray toast.
	const head = room.slice(room.indexOf('#onMediaStatus('), room.indexOf("if (status === 'ready')"));
	/* THE FIELD LIST GREW BY ONE and the claim is unchanged: `unservable` joined the stored shape so the phone can
	   draw a stalled card instead of a progress bar for a job nobody can run (it was already on the wire and the TV
	   already read it). What this test is about is the ABSENCE of a per-requester gate on the write, not the width
	   of the record — so the list is pinned as it is rather than loosened to a prefix match, which would stop
	   noticing a field quietly dropped on the way in. */
	expect(head).toContain('next.set(mediaId, { status, pct, etaSec, unservable });');
	expect(head).not.toContain('requestedBy');
});
