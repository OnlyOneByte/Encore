import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: the WIRING between `waitingTurns`/`stuckTurnsLines` (tested as functions in waiting-turns.test.ts) and the
 * two screens that print them, the TV lobby and the phone strip. Each break below LOOKS LIKE the unfixed app — the
 * old "Making karaoke…" copy — and before this file only probe p21, which is not a gate, caught them. Source scans,
 * because the component-mount harness is gone (bunfig.toml records why). Each assertion names the shape that failed.
 */

const tv = readFileSync(at('src/routes/tv/+page.svelte'), 'utf8');
const lobby = readFileSync(at('src/lib/tv/TvLobby.svelte'), 'utf8');
const layout = readFileSync(at('src/routes/+layout.svelte'), 'utf8');
const strip = readFileSync(at('src/lib/ui/NowPlayingStrip.svelte'), 'utf8');
const songRow = readFileSync(at('src/lib/components/SongRow.svelte'), 'utf8');
const home = readFileSync(at('src/routes/+page.svelte'), 'utf8');

test('a Sing-tab row nobody can make says so, with no bar and no percentage', () => {
	expect(songRow).toContain("const stalled = $derived(readiness === 'processing' && unservable);");
	expect(songRow).toContain('if (stalled) return STALLED_TURN_LABEL;');
	// The stalled return precedes the in-flight one, or the row prints "Making karaoke… 20%" anyway.
	expect(songRow.indexOf('if (stalled) return STALLED_TURN_LABEL;')).toBeLessThan(
		songRow.indexOf("if (readiness === 'processing') return processStageLabel('queued'")
	);
	// Each guard on its OWN element, so neither can stand in for the other: the sparkle in the title line, and the
	// progress bar (the GPU-composited fill) below the chips.
	expect(songRow).toMatch(/\{#if readiness === 'processing' && !stalled\}<span class="sparkle">/);
	expect(songRow).toMatch(/\{#if readiness === 'processing' && !stalled\}\s*<!-- GPU-composited fill/);
	// Both rows on the Sing tab that carry a live status hand the verdict over, and the group heading says "Making
	// karaoke…" only for a row really being made.
	expect(home).toContain('unservable={c.unservable}');
	expect(home).toContain('unservable={liveOf(m.id)?.unservable}');
	expect(home).toMatch(
		/processingGroupHeading\(\s*processingRows\.map\(\s*\(c\) => displayReadiness\(c\.media, liveOf\(c\.id\)\) === 'processing' && !c\.unservable/
	);
});

test('the TV lobby counts only turns being made, and is handed the stuck line', () => {
	expect(tv).toContain('pendingCount={waiting.making}');
	expect(tv).toContain('stuck={stuck}');
	expect(tv).toContain('const stuck = $derived(stuckTurnsLines(waiting, singerName));');
	// The live statuses the fold reads: without them a no-maker turn classifies as cooking off the catalog.
	expect(tv).toContain('(id) => liveStatus.get(id)');
	// The count that called every unplayable turn "processing": `pending` is kept only for #978's overdue question.
	expect(tv).not.toContain('pendingCount={pendingCount}');
	expect(tv).not.toContain('pending.length');
});

test('the TV adopts the first queue patch after a boot', () => {
	// 0 let the rev-1 patch through unread, so the first song queued never reached the lobby.
	expect(tv).toContain('getLastRev: () => -1');
});

test('the lobby prints the stuck line in place of "this takes a minute"', () => {
	expect(lobby).toContain("stuck?.headline ?? 'Waiting for someone to pick a song...'");
	// Worded by `lobbyLine` (screen.test.ts reads every wording); the lobby hands it the stuck turn's way out.
	expect(lobby).toContain('lobbyLine(count, processing, overdue, stuck?.next)');
});

test('the strip is worded by the same fold, and prints it where it wraps', () => {
	expect(layout).toContain('stuckTurnsLines(waiting,');
	expect(layout).toContain('waitingLine={waitingLine}');
	expect(strip).toContain(`<span class="status">{canPlay ? 'Ready when you are' : waitingLine}</span>`);
	// The hard-coded line that sat under two "Couldn't make karaoke" rows.
	expect(strip).not.toContain(": 'Making karaoke…'}");
});

test('a TV that loads inside the window seeds the verdict the room already heard', () => {
	// The sweep says `unservable` once; a TV opened later learns it from /api/library or keeps "this takes a minute".
	expect(tv).toContain("fetch('/api/library')");
	expect(tv).toContain('liveStatus = seedLiveStatus(liveStatus, j.processing ?? [], j.noMakerFailed ?? [], {');
	expect(tv).toContain('void seedFromLibrary();');
	// A read a later re-connect overtook neither seeds nor clears the later read's heard-set (reconnect-heard.test.ts
	// drives the phone's twin of this through a real socket).
	expect(tv).toContain('const superseded = () => reconnect && heardSinceReconnect !== heard;');
	expect(tv).toContain('if (j && !superseded())');
	expect(tv).toContain('if (reconnect && !superseded()) heardSinceReconnect = null;');
	// And every queue sync drops the statuses of songs the room no longer holds (reconnect-seed.test.ts).
	expect(tv).toContain('liveStatus = pruneLiveStatus(liveStatus, e.entries);');
});

test('a worker leaving and a reconnecting TV both reach the verdict a reload would give', () => {
	// The close path goes through the hub, which re-tells "no maker" when the last capable worker leaves.
	expect(readFileSync(at('server.ts'), 'utf8')).toContain(
		'app.workerHub.workerLeft(() => releaseWorkerSocket(workerSockets, app.workers, workerId, ws));'
	);
	// A TV re-seeds from /api/library on a RE-connect, as the phone's link does (room-live-scar.test.ts).
	expect(tv).toMatch(/if \(c && wasConnected\) \{[\s\S]{0,200}void seedFromLibrary\(true\);/);
});
