import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: the leave confirm's two failure shapes, which neither a sentence test nor a browser can pin cheaply.
 *
 * What is covered ELSEWHERE and deliberately not duplicated:
 *   · tests/unit/lib/leave-cost-sentence.test.ts owns the copy, branch by branch, including the `null` arm.
 *   · the fix was driven in a browser against a real server with POST /api/leave aborted and then 500'd.
 * What is HERE is the handful of shapes whose correctness is invisible to both. All three were defects:
 *   1. `leaveRoom` was the only unguarded fetch in the file. A rejection left `leaving` true forever, so the one
 *      irreversible guest action sat at "Leaving…", disabled, claiming to be in progress — and a reopen showed the
 *      same dead label, because `leaving` belongs to a component that stays mounted.
 *   2. A 500 RESOLVES, so a catch-only guard does not fire: the navigation ran anyway and left a guest who was
 *      still a member on the Sing tab with nothing saying the leave had failed. `res.ok` is the whole fix for that
 *      half, and nothing about a try/catch alone looks wrong.
 *   3. `askLeave` never reset `leaveCost`, so a reopen displayed the previous open's number.
 *
 * The component-mount harness was deleted (see bunfig.toml), so this is a source scan on purpose rather than for
 * want of a renderer.
 */

const youPage = readFileSync(at('src/routes/settings/you/+page.svelte'), 'utf8');

/** The body of a top-level `async function <name>() { … }` in the route's `<script>`, brace-matched. */
function fn(name: string): string {
	const start = youPage.indexOf(`async function ${name}() {`);
	expect(start).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = youPage.indexOf('{', start); i < youPage.length; i++) {
		if (youPage[i] === '{') depth++;
		else if (youPage[i] === '}' && --depth === 0) return youPage.slice(start, i + 1);
	}
	throw new Error(`unbalanced braces in ${name}()`);
}

test('a failed leave is CAUGHT, tested for ok, and becomes retryable', () => {
	const leaveRoom = fn('leaveRoom');

	// The rejection path. Without the try the error escapes as an unhandled pageerror and the pending flag sticks.
	expect(leaveRoom).toContain('} catch {');
	// The resolved-but-refused path, which is the half a catch cannot see.
	expect(leaveRoom).toContain('if (!res.ok) {');

	// RETRYABLE means the flag comes back on BOTH failure paths — two resets, because a `finally` would clear it on
	// the success path too and flip the label back to "Yes, leave" while the navigation was still running.
	expect(leaveRoom.match(/leaving = false;/g)?.length).toBe(2);
	expect(leaveRoom).not.toContain('finally');

	// Each failure path RETURNS rather than falling through to the navigation: a leave that did not happen must not
	// send the guest to the landing page as though it had.
	const lines = leaveRoom.split('\n').map((l) => l.trim());
	for (const i of lines.flatMap((l, j) => (l === 'leaving = false;' ? [j] : []))) {
		expect(lines[i + 1]).toBe('return;');
	}
	// …and the navigation is the LAST statement, outside the try, so a goto rejection cannot be reported as a
	// refusal of a POST that already landed.
	expect(leaveRoom.indexOf("await goto('/')")).toBeGreaterThan(leaveRoom.indexOf('} catch {'));

	// The reason is stated, from the one shared literal, and it is a failure tone rather than the amber the two
	// other scopes' advisories wear.
	expect(youPage).toContain("const LEAVE_REFUSAL = 'Could not leave the room — try again.';");
	expect(leaveRoom.match(/leaveRefusal = LEAVE_REFUSAL;/g)?.length).toBe(2);
	expect(youPage).toContain('{#if leaveRefusal}<p class="err" role="alert">{leaveRefusal}</p>{/if}');
	// THE RULE BODY, not the file. A file-wide `not.toContain('--warn')` reds on a correct tree — the comment above
	// this rule names `--warn` in prose precisely to explain why it is not the ink here — which is how the first
	// draft of this test failed against a fix that was right.
	const errAt = youPage.indexOf('\t.err {');
	const errRule = youPage.slice(errAt, youPage.indexOf('}', errAt));
	expect(errRule).toContain('color: var(--danger-ink);');
	expect(errRule).not.toContain('--warn');

	// Nothing is read out of the body: /api/leave's only non-ok answer is a 401 `join first`, which would be
	// nonsense to show somebody trying to leave.
	expect(leaveRoom).not.toContain('res.json');
});

test('opening the confirm clears BOTH statements before the dialog mounts', () => {
	const askLeave = fn('askLeave');
	// Ordered: `confirmingLeave = true` is what mounts the alertdialog, and alertdialog announces its description
	// at mount — so a carried-over cost or a stale refusal set after this line would be the thing announced.
	const nulled = askLeave.indexOf('leaveCost = null;');
	const cleared = askLeave.indexOf("leaveRefusal = '';");
	const opened = askLeave.indexOf('confirmingLeave = true;');
	expect(nulled).toBeGreaterThan(-1);
	expect(cleared).toBeGreaterThan(-1);
	expect(nulled).toBeLessThan(opened);
	expect(cleared).toBeLessThan(opened);
});

test('the description is the phrasing module, with no `?? 0` left anywhere in the route', () => {
	expect(youPage).toContain('const leaveWarning = $derived(leaveCostSentence(leaveCost));');
	expect(youPage).toContain('<AlertDialog.Description>{leaveWarning}</AlertDialog.Description>');
	// The exact expression that turned "not known yet" into a confident zero, and the sentence it produced.
	expect(youPage).not.toContain('queuedCount ?? 0');
	expect(youPage).not.toContain('no songs queued');
});
